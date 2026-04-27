/**
 * Agent 结构化日志
 *
 * 为 Agent 决策循环提供结构化日志能力，
 * 支持按 requestId 追踪完整的决策链路。
 */
import type {
  SessionQAToolCall,
  ToolObservation,
  EvidenceQuality,
  SessionQAIntentType
} from './types'

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 单条日志条目 */
export interface AgentLogEntry {
  timestamp: number
  level: LogLevel
  category: 'decision' | 'tool' | 'evidence' | 'answer' | 'error' | 'lifecycle'
  message: string
  data?: Record<string, unknown>
}

/**
 * Agent 结构化日志器
 *
 * 每个 Agent 实例拥有独立的日志器，记录完整的决策链路。
 */
export class AgentLogger {
  private readonly entries: AgentLogEntry[] = []
  private readonly requestId: string
  private readonly prefix: string

  constructor(sessionId: string) {
    this.requestId = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.prefix = `[SessionQAAgent:${this.requestId}]`
  }

  /** 获取请求追踪 ID */
  getRequestId(): string {
    return this.requestId
  }

  /** 获取所有日志条目 */
  getEntries(): ReadonlyArray<AgentLogEntry> {
    return this.entries
  }

  /** 获取日志摘要（用于诊断） */
  getSummary(): string {
    const warnings = this.entries.filter((e) => e.level === 'warn' || e.level === 'error')
    if (warnings.length === 0) return `${this.entries.length} 条日志，无异常`
    return `${this.entries.length} 条日志，${warnings.length} 条告警/错误`
  }

  // ─── 分类日志方法 ──────────────────────────────────────────

  /** 记录生命周期事件（启动、完成等） */
  lifecycle(message: string, data?: Record<string, unknown>) {
    this.log('info', 'lifecycle', message, data)
  }

  /** 记录决策循环信息 */
  decision(message: string, data?: Record<string, unknown>) {
    this.log('info', 'decision', message, data)
  }

  /** 记录工具调用 */
  tool(toolCall: SessionQAToolCall) {
    this.log('info', 'tool', `${toolCall.toolName}: ${toolCall.summary}`, {
      toolName: toolCall.toolName,
      args: toolCall.args,
      status: toolCall.status,
      evidenceCount: toolCall.evidenceCount,
      durationMs: toolCall.durationMs
    })
  }

  /** 记录证据评估 */
  evidence(quality: EvidenceQuality, intent: SessionQAIntentType, data?: Record<string, unknown>) {
    this.log('info', 'evidence', `质量=${quality}，意图=${intent}`, { quality, intent, ...data })
  }

  /** 记录工具观察 */
  observation(obs: ToolObservation) {
    this.log('debug', 'tool', `${obs.title}: ${obs.detail.slice(0, 120)}`, { title: obs.title })
  }

  /** 记录回答生成 */
  answer(message: string, data?: Record<string, unknown>) {
    this.log('info', 'answer', message, data)
  }

  /** 记录警告 */
  warn(message: string, data?: Record<string, unknown>) {
    this.log('warn', 'error', message, data)
    console.warn(`${this.prefix} ${message}`, data || '')
  }

  /** 记录错误 */
  error(message: string, error?: unknown) {
    const errorStr = error instanceof Error ? error.message : String(error || '')
    this.log('error', 'error', `${message}: ${errorStr}`, {
      errorMessage: errorStr,
      errorStack: error instanceof Error ? error.stack : undefined
    })
    console.error(`${this.prefix} ${message}`, error || '')
  }

  // ─── 内部 ─────────────────────────────────────────────────

  private log(level: LogLevel, category: AgentLogEntry['category'], message: string, data?: Record<string, unknown>) {
    this.entries.push({
      timestamp: Date.now(),
      level,
      category,
      message,
      data
    })
  }
}
