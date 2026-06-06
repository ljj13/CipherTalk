import { AsyncLocalStorage } from 'async_hooks'
import type { AgentProgressEvent, AgentProgressReporter } from './types'

const progressStorage = new AsyncLocalStorage<AgentProgressReporter>()

export async function withAgentProgress<T>(
  reporter: AgentProgressReporter | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!reporter) return fn()
  return progressStorage.run(reporter, fn)
}

export function reportAgentProgress(event: Omit<AgentProgressEvent, 'at'>): void {
  const reporter = progressStorage.getStore()
  if (!reporter) return
  reporter({ ...event, at: Date.now() })
}
