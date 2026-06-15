import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { codeWorkspaceService } from '../../services/agent/codeWorkspaceService'

export function registerAgentWorkspaceHandlers(ctx: MainProcessContext): void {
  codeWorkspaceService.setContext(ctx)

  ipcMain.handle('agentWorkspace:selectWorkspace', async () => {
    return codeWorkspaceService.selectWorkspace()
  })

  ipcMain.handle('agentWorkspace:clearWorkspace', async () => {
    try {
      const state = await codeWorkspaceService.clearWorkspace()
      return { success: true, state }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:stopDevServer', async () => {
    try {
      const result = await codeWorkspaceService.handleToolCall({ method: 'stop_dev_server' })
      return { success: true, result, state: codeWorkspaceService.getState() }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle('agentWorkspace:getState', async () => {
    return { success: true, state: codeWorkspaceService.getState() }
  })

  ipcMain.handle('agentWorkspace:approve', async (_event, requestId: string) => {
    return { success: codeWorkspaceService.approve(String(requestId || '')) }
  })

  ipcMain.handle('agentWorkspace:reject', async (_event, requestId: string) => {
    return { success: codeWorkspaceService.reject(String(requestId || '')) }
  })
}
