import { buildRelationshipGraphSnapshot } from './services/relationshipGraph/builder'
import type { RelationshipGraphBuildRequest } from './services/relationshipGraph/types'

const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('relationshipGraphUtilityProcess 必须在 Electron utilityProcess 中运行')
}

const keepAliveTimer = setInterval(() => undefined, 60_000)

parentPort.on('message', (event: Electron.MessageEvent) => {
  void handleMessage(event.data)
})

process.once('exit', () => {
  clearInterval(keepAliveTimer)
})

async function handleMessage(msg: any): Promise<void> {
  const { id, type, payload } = msg || {}
  if (type === 'wcdb:result') return

  try {
    switch (type) {
      case 'build': {
        const request = payload as RelationshipGraphBuildRequest
        const snapshot = await buildRelationshipGraphSnapshot({
          taskId: request.taskId,
          options: request.options || {},
          cacheBaseDir: request.cacheBaseDir,
          onProgress: (progress) => parentPort!.postMessage({
            id: -1,
            type: 'progress',
            payload: progress,
          }),
        })
        parentPort!.postMessage({ id, result: { snapshot } })
        break
      }
      default:
        parentPort!.postMessage({ id, error: `unknown type: ${type}` })
    }
  } catch (error: any) {
    parentPort!.postMessage({ id, error: error?.message || String(error) })
  }
}

parentPort.postMessage({ id: 0, type: 'ready' })
