/**
 * 全局 TTS 播放器 —— 朗读 AI 回复 / 微信消息 / 角色语音回复共用的单例。
 * 优先走主进程在线合成（tts:speak，见 electron/services/ai/ttsService）；
 * 未启用/未配置时回退浏览器 speechSynthesis（系统朗读）。
 * 同一时刻只播一条：再次触发同 key 即停止，触发其他 key 则切换。
 */
import { useEffect, useState } from 'react'
import type { PersonaTtsVoiceBindingInfo, TtsConfig } from '@/types/electron'

export type TtsSpeakingPhase = 'loading' | 'playing'

export interface TtsSpeakingState {
  key: string
  phase: TtsSpeakingPhase
}

type SpeakingListener = (speakingState: TtsSpeakingState | null) => void

export interface SpeakResult {
  ok: boolean
  /** true = 本次调用是"点了正在播的那条"，已停止播放（连播链路据此中断） */
  stopped?: boolean
  error?: string
}

export interface SpeakOptions {
  awaitEnd?: boolean
  config?: Partial<TtsConfig>
  instructions?: string
  personaVoice?: PersonaTtsVoiceBindingInfo | null
}

let currentAudio: HTMLAudioElement | null = null
/** 当前播放的清理回调（停止/切换时调用，保证 awaitEnd 的 Promise 不悬挂） */
let currentOnStop: (() => void) | null = null
let speakingState: TtsSpeakingState | null = null
/** 自增请求序号：合成是异步的，回来时如果用户已切到别的内容就丢弃 */
let requestSeq = 0
const listeners = new Set<SpeakingListener>()

function setSpeaking(state: TtsSpeakingState | null): void {
  speakingState = state
  listeners.forEach((listener) => listener(state))
}

function stopAudio(): void {
  const onStop = currentOnStop
  currentOnStop = null
  if (currentAudio) {
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio.pause()
    currentAudio = null
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel()
  }
  onStop?.()
}

export function getSpeakingKey(): string | null {
  return speakingState?.key || null
}

export function getSpeakingState(): TtsSpeakingState | null {
  return speakingState
}

/** 停止当前朗读（任何来源）。 */
export function stopSpeaking(): void {
  requestSeq += 1
  stopAudio()
  setSpeaking(null)
}

function speakWithSystem(key: string, text: string, seq: number): { started: boolean; done: Promise<void> } {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return { started: false, done: Promise.resolve() }
  }
  if (seq !== requestSeq) return { started: true, done: Promise.resolve() }

  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  let finished = false
  const clear = () => {
    if (finished) return
    finished = true
    if (currentOnStop === clear) currentOnStop = null
    setSpeaking(speakingState?.key === key ? null : speakingState)
    resolveDone()
  }

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'zh-CN'
  utterance.onend = clear
  utterance.onerror = clear
  currentOnStop = clear
  window.speechSynthesis.speak(utterance)
  return { started: true, done }
}

/**
 * 朗读一段文本。key 用于标识朗读对象（消息 id 等）：
 * 同 key 再次调用 = 停止（stopped: true）；不同 key = 切换。
 * awaitEnd: true 时等到播放结束才 resolve（连播队列用）。
 */
export async function speakText(key: string, text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
  const content = String(text || '').trim()
  if (!content) return { ok: false, error: '朗读内容为空' }

  if (speakingState?.key === key) {
    stopSpeaking()
    return { ok: true, stopped: true }
  }

  requestSeq += 1
  const seq = requestSeq
  stopAudio()
  setSpeaking({ key, phase: 'loading' })

  let result: { success: boolean; audioBase64?: string; mimeType?: string; error?: string; errorCode?: string } | null = null
  try {
    const instructions = String(options.instructions || '').trim()
    const config = {
      ...(options.config || {}),
      ...(instructions ? { instructions } : {}),
    }
    result = await window.electronAPI.tts.speak(
      content,
      Object.keys(config).length > 0 || options.personaVoice
        ? { config: Object.keys(config).length > 0 ? config : undefined, personaVoice: options.personaVoice || undefined }
        : undefined,
    )
  } catch (e) {
    result = { success: false, error: e instanceof Error ? e.message : String(e), errorCode: 'SYNTHESIS_FAILED' }
  }

  // 合成期间用户已切换/停止
  if (seq !== requestSeq) return { ok: true, stopped: true }

  if (result?.success && result.audioBase64) {
    const audio = new Audio(`data:${result.mimeType || 'audio/mpeg'};base64,${result.audioBase64}`)
    let resolveEnd: (() => void) | null = null
    const ended = options.awaitEnd ? new Promise<void>((resolve) => { resolveEnd = resolve }) : null
    let finished = false
    const clear = () => {
      if (finished) return
      finished = true
      if (currentAudio === audio) currentAudio = null
      if (currentOnStop === clear) currentOnStop = null
      setSpeaking(speakingState?.key === key ? null : speakingState)
      resolveEnd?.()
    }
    audio.onended = clear
    audio.onerror = clear
    currentAudio = audio
    currentOnStop = clear
    try {
      setSpeaking({ key, phase: 'playing' })
      await audio.play()
    } catch (e) {
      clear()
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    if (ended) {
      await ended
      // 播完后区分自然结束与中途被停
      if (seq !== requestSeq) return { ok: true, stopped: true }
    }
    return { ok: true }
  }

  // 未配置在线 TTS：回退系统朗读；其他失败也尽量回退，保证“能读出声”
  const system = speakWithSystem(key, content, seq)
  if (system.started) {
    if (seq === requestSeq) setSpeaking({ key, phase: 'playing' })
    if (options.awaitEnd) {
      await system.done
      if (seq !== requestSeq) return { ok: true, stopped: true }
    }
    return { ok: true }
  }

  setSpeaking(null)
  return { ok: false, error: result?.error || '朗读失败' }
}

/** React hook：订阅当前朗读对象 key，并提供朗读/停止方法。 */
export function useTtsSpeaker(): {
  speakingKey: string | null
  speakingState: TtsSpeakingState | null
  speak: (key: string, text: string, options?: SpeakOptions) => Promise<SpeakResult>
  stop: () => void
} {
  const [state, setState] = useState<TtsSpeakingState | null>(getSpeakingState())
  useEffect(() => {
    const listener: SpeakingListener = (next) => setState(next)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return { speakingKey: state?.key || null, speakingState: state, speak: speakText, stop: stopSpeaking }
}
