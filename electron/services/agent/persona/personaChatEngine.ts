/**
 * 克隆好友聊天引擎 —— 跑在 AI utilityProcess 子进程。
 * 与 AI 助手（engine.ts 的工具循环）刻意不同：扮演真人不暴露工具，
 * 每轮先做一次记忆预检索（向量优先、关键词兜底，失败静默），
 * 再单次 generateText 完整生成后按气泡回推 —— 人格稳定性优先于能力灵活性。
 */
import { generateText, type FinishReason, type ModelMessage, type UIMessageChunk } from 'ai'
import { createLanguageModel } from '../provider'
import { reportAgentProgress, withAgentProgress } from '../progress'
import { searchChat } from '../tools/shared'
import type { AgentProgressReporter } from '../types'
import type { PersonaChatInput, PersonaChatPersona } from './personaTypes'

const MEMORY_TOP_K = 5
// 扮演真人要比工具 Agent 更"活"，温度调高
const PERSONA_TEMPERATURE = 0.8
const BURST_JOINER = '／'
const HUMAN_TYPING_MS_PER_CHAR = 130
const HUMAN_TYPING_MIN_DELAY_MS = 550
const HUMAN_TYPING_MAX_DELAY_MS = 4200
const HUMAN_BUBBLE_PAUSE_MIN_MS = 350
const HUMAN_BUBBLE_PAUSE_MAX_MS = 1200

function splitReplyBubbles(text: string): string[] {
  return text.split(/[\n／]/).map((line) => line.trim()).filter(Boolean)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function jitter(ms: number): number {
  return Math.round(ms * randomBetween(0.85, 1.2))
}

function typingDelayMs(text: string): number {
  const charCount = Array.from(text.replace(/\s+/g, '')).length
  const punctuationCount = text.match(/[，。！？!?…~～、,.]/g)?.length || 0
  return clamp(
    jitter(charCount * HUMAN_TYPING_MS_PER_CHAR + punctuationCount * 90),
    HUMAN_TYPING_MIN_DELAY_MS,
    HUMAN_TYPING_MAX_DELAY_MS,
  )
}

function bubblePauseMs(index: number): number {
  return index === 0 ? 0 : Math.round(randomBetween(HUMAN_BUBBLE_PAUSE_MIN_MS, HUMAN_BUBBLE_PAUSE_MAX_MS))
}

function waitMs(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (ms <= 0) return Promise.resolve(true)

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (completed: boolean) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = () => done(false)

    timer = setTimeout(() => done(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function emitCompleteTextAsUiChunks(
  text: string,
  finishReason: FinishReason,
  metadata: Record<string, unknown>,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const textId = `persona-text-${Date.now()}`
  onChunk({ type: 'start' })
  onChunk({ type: 'start-step' })
  onChunk({ type: 'text-start', id: textId })
  const bubbles = splitReplyBubbles(text)
  for (let i = 0; i < bubbles.length; i += 1) {
    const completed = await waitMs(bubblePauseMs(i) + typingDelayMs(bubbles[i]), signal)
    if (!completed) {
      onChunk({ type: 'abort', reason: 'aborted' })
      return false
    }
    onChunk({ type: 'text-delta', id: textId, delta: `${i === 0 ? '' : '\n'}${bubbles[i]}` })
  }
  onChunk({ type: 'text-end', id: textId })
  onChunk({ type: 'finish-step' })
  onChunk({ type: 'finish', finishReason, messageMetadata: metadata })
  return true
}

function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (p && typeof p === 'object' && 'type' in p && p.type === 'text' ? String(p.text || '') : ''))
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }
  return ''
}

/** 记忆预检索：嵌入就绪走会话片段向量（首聊触发懒构建，进度上报），否则/失败关键词兜底。 */
async function retrieveMemories(sessionId: string, query: string): Promise<string[]> {
  try {
    const { getEmbeddingConfig } = await import('../../ai/embeddingService')
    const { messageVectorService, embedQuery } = await import('../../search/messageVectorService')
    const cfg = getEmbeddingConfig()
    if (messageVectorService.isReady(cfg)) {
      const queryVec = await embedQuery(query, cfg)
      await messageVectorService.ensureSessionVectors(sessionId, cfg, undefined, (progress) => {
        reportAgentProgress({
          stage: progress.stage === 'embedding' ? 'indexing' : 'searching',
          title: progress.message,
          sessionId,
        })
      })
      const hits = messageVectorService.searchSession(sessionId, queryVec, MEMORY_TOP_K)
      if (hits.length > 0) {
        return hits.map((h) => h.excerpt.replace(/\n+/g, BURST_JOINER))
      }
    }
  } catch {
    /* 向量检索失败 → 关键词兜底 */
  }
  try {
    const { hits } = await searchChat({ query, sessionId, limit: MEMORY_TOP_K })
    return hits.map((h) => `${h.sender}: ${h.excerpt.replace(/\n+/g, BURST_JOINER)}`)
  } catch {
    return []
  }
}

export function buildPersonaSystemPrompt(persona: PersonaChatPersona, memories: string[]): string {
  const { displayName, card, fewShots, stats } = persona
  const lines: string[] = [
    `你是「${displayName}」，正在微信上和老朋友聊天。你不是 AI 助手，你就是${displayName}本人，任何情况下都不要承认或暗示自己是 AI、模型或程序。`,
    '',
    '【你的说话方式】',
    `语气风格：${card.tone}`,
    `性格：${card.personalityTraits.join('、')}`,
  ]
  if (card.catchphrases.length > 0) lines.push(`口头禅：${card.catchphrases.join('、')}（自然使用，别刻意堆砌）`)
  lines.push(`标点习惯：${card.punctuationStyle}`)
  if (card.addressing && card.addressing !== '无特别称呼') lines.push(`你对对方的称呼：${card.addressing}`)
  if (card.topics.length > 0) lines.push(`你们常聊：${card.topics.join('、')}`)

  if (fewShots.length > 0) {
    lines.push(
      '',
      `【你过去真实的回复方式】（「${BURST_JOINER}」分隔的是连发的多条消息）`,
      ...fewShots.map((s) => `对方: ${s.user}\n你: ${s.replies.join(BURST_JOINER)}`),
    )
  }

  if (memories.length > 0) {
    lines.push(
      '',
      '【可能相关的真实聊天片段】（你们真的聊过这些，可自然提及，但别逐字背诵、别主动复述无关内容）',
      ...memories.map((m) => `- ${m}`),
    )
  }

  lines.push(
    '',
    '【聊天规则】',
    `- 微信短消息风格：参考过去单条平均 ${Math.max(stats.avgFriendMsgChars, 4)} 字左右的习惯，别写长段落`,
    `- 回复几条由你根据上下文自然决定；要连发多条时，每条消息之间用换行或「${BURST_JOINER}」分隔（会被拆成多条气泡发出）`,
    '- 禁止 markdown、列表、序号、emoji 之外的格式符号',
    '- 不知道、记不清的事就像真人一样含糊带过或反问，绝不编造具体细节',
    '- 始终保持口语化，符合上面的语气和标点习惯',
  )
  return lines.join('\n')
}

export async function runPersonaChat(
  input: PersonaChatInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
  onProgress?: AgentProgressReporter,
): Promise<void> {
  await withAgentProgress(onProgress, async () => {
    const userText = lastUserText(input.messages)
    reportAgentProgress({ stage: 'run_started', title: '正在回忆相关聊天' })
    const memories = userText ? await retrieveMemories(input.persona.sessionId, userText) : []

    reportAgentProgress({ stage: 'run_started', title: '正在组织语言' })
    const result = await generateText({
      model: createLanguageModel(input.providerConfig),
      system: buildPersonaSystemPrompt(input.persona, memories),
      messages: input.messages,
      temperature: PERSONA_TEMPERATURE,
      abortSignal: signal,
    })

    const completed = await emitCompleteTextAsUiChunks(result.text, result.finishReason, {
      usage: result.totalUsage,
      finishReason: result.finishReason,
      modelProvider: input.providerConfig.name,
      modelId: input.providerConfig.model,
      persona: input.persona.sessionId,
    }, onChunk, signal)
    reportAgentProgress(completed
      ? { stage: 'run_finished', title: '回复完成' }
      : { stage: 'error', title: '已停止回复' })
  })
}
