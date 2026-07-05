import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getAppPath, isElectronPackaged } from '../runtimePaths'
import { getElectronWorkerEnv } from '../workerEnvironment'
import type { RelationshipGraphBuildProgress } from '../../../src/types/models'
import type { RelationshipGraphBuildRequest, RelationshipGraphBuildResult, RelationshipGraphSnapshot } from './types'

const UTILITY_FILE = 'relationshipGraphUtilityProcess.js'

type Pending = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  type: string
  startedAt: number
}

export class RelationshipGraphProcessService {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private progressHandlers = new Map<string, (progress: RelationshipGraphBuildProgress) => void>()
  private seq = 0
  private initPromise: Promise<void> | null = null

  async build(request: RelationshipGraphBuildRequest, onProgress?: (progress: RelationshipGraphBuildProgress) => void): Promise<RelationshipGraphBuildResult> {
    if (onProgress) this.progressHandlers.set(request.taskId, onProgress)
    try {
      const result = await this.call<{ snapshot: RelationshipGraphSnapshot }>('build', request)
      return {
        snapshot: result.snapshot,
        task: {
          id: request.taskId,
          status: 'completed',
          stage: 'done',
          message: '关系网络构建完成',
          finishedAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
    } finally {
      this.progressHandlers.delete(request.taskId)
    }
  }

  shutdown(): void {
    const worker = this.worker
    this.worker = null
    this.initPromise = null
    for (const pending of this.pending.values()) {
      pending.reject(new Error('relationship graph utility process shutdown'))
    }
    this.pending.clear()
    this.progressHandlers.clear()
    if (worker) {
      try { worker.kill() } catch { /* ignore */ }
    }
  }

  private async initWorker(): Promise<void> {
    if (this.worker) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      const utilityPath = this.resolveUtilityPath()
      if (!utilityPath) {
        this.initPromise = null
        reject(new Error(`未找到 ${UTILITY_FILE}`))
        return
      }

      let worker: UtilityProcess
      try {
        worker = utilityProcess.fork(utilityPath, [], {
          serviceName: 'CipherTalk Relationship Graph',
          stdio: 'pipe',
          env: { ...getElectronWorkerEnv(), CT_AGENT_WCDB_PROXY: '1' },
        })
      } catch (error: any) {
        this.initPromise = null
        reject(new Error(`启动关系网络 utility process 失败: ${error?.message || String(error)}`))
        return
      }

      this.worker = worker
      let readyFired = false
      let stderrTail = ''
      const rejectInitOnce = (error: Error) => {
        if (!readyFired) {
          readyFired = true
          reject(error)
        }
      }

      worker.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.debug(`[relationshipGraphUtility:${worker.pid ?? 'unknown'}] ${text}`)
      })
      worker.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          stderrTail = `${stderrTail}\n${text}`.slice(-4000)
          console.warn(`[relationshipGraphUtility:${worker.pid ?? 'unknown'}] ${text}`)
        }
      })

      worker.on('message', (msg: any) => {
        if (msg?.type === 'wcdb:call') {
          void this.handleWcdbCall(worker, msg.payload)
          return
        }
        if (msg?.id === 0 && msg.type === 'ready') {
          if (!readyFired) {
            readyFired = true
            resolve()
          }
          return
        }
        if (msg?.id === -1 && msg.type === 'progress') {
          const progress = msg.payload as RelationshipGraphBuildProgress
          if (progress?.taskId) this.progressHandlers.get(progress.taskId)?.(progress)
          return
        }
        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
      })

      worker.on('error', (type, location) => {
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`relationship graph utility process fatal (${type}, ${location || 'unknown'})`)
        rejectInitOnce(new Error(`relationship graph utility process fatal: ${type}`))
      })

      worker.on('exit', (code) => {
        const pid = worker.pid
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`relationship graph utility process exited (pid=${pid ?? 'unknown'}, code=${code})`)
        const stderrDetail = stderrTail.trim() ? `，stderr=${stderrTail.trim()}` : ''
        rejectInitOnce(new Error(`relationship graph utility process 启动后立即退出，code=${code}${stderrDetail}`))
      })
    })

    try {
      await this.initPromise
    } catch (error) {
      this.initPromise = null
      throw error
    }
  }

  private async handleWcdbCall(worker: UtilityProcess, payload: { reqId: number; method: string; payload: any }): Promise<void> {
    const reqId = payload?.reqId
    try {
      const { wcdbService } = await import('../wcdbService')
      const result = await wcdbService.runProxiedCall(payload.method, payload.payload)
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, result } })
    } catch (error: any) {
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, error: error?.message || String(error) } })
    }
  }

  private async call<T = any>(type: string, payload: any): Promise<T> {
    await this.initWorker()
    const worker = this.worker
    if (!worker) throw new Error('relationship graph utility process 未就绪')
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type, startedAt: Date.now() })
      try {
        worker.postMessage({ id, type, payload })
      } catch (error: any) {
        this.pending.delete(id)
        reject(new Error(`relationship graph postMessage 失败: ${error?.message || String(error)}`))
      }
    })
  }

  private rejectAllPending(reason: string): void {
    const error = new Error(reason)
    for (const pending of this.pending.values()) {
      try { pending.reject(error) } catch { /* ignore */ }
    }
    this.pending.clear()
  }

  private getUtilityPathCandidates(): string[] {
    const appPath = getAppPath()
    const resourcesRoot = process.resourcesPath || appPath
    return isElectronPackaged()
      ? [
          join(resourcesRoot, 'app.asar.unpacked', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'app.asar', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'dist-electron', UTILITY_FILE),
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
        ]
      : [
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
          join(appPath, 'dist-electron', UTILITY_FILE),
        ]
  }

  private resolveUtilityPath(): string | null {
    return this.getUtilityPathCandidates().find((candidate) => existsSync(candidate)) || null
  }
}

export const relationshipGraphProcessService = new RelationshipGraphProcessService()
