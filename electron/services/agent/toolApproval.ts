import type { ToolApprovalConfiguration, ToolApprovalStatus, ToolSet } from 'ai'
import type { AgentRunInput } from './types'

const HIGH_RISK_TOOL_NAMES = new Set([
  'send_sticker',
  'send_random_image',
  'send_media_from_history',
  'send_wechat_media',
  'send_wechat_file',
  'export_chat',
  'create_artifact',
  'remove_knowledge_source',
  'create_task',
  'update_task',
  'cancel_task',
  'run_task_now',
  'rollback_operation',
  'apply_memory_fix',
])

function approvalReason(toolName: string): string {
  if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) return '外部 MCP 工具需要用户确认'
  if (toolName.startsWith('send_')) return '发送微信消息、媒体或文件需要用户确认'
  if (toolName === 'export_chat' || toolName === 'create_artifact') return '导出或写入本机文件需要用户确认'
  if (toolName.endsWith('_task') || toolName === 'run_task_now') return '主动/定时任务变更需要用户确认'
  if (toolName.includes('memory')) return '修改长期记忆需要用户确认'
  return '高风险工具调用需要用户确认'
}

export function buildAgentToolApproval(
  input: AgentRunInput,
  mcpToolNames: readonly string[] = [],
): ToolApprovalConfiguration<ToolSet, unknown> | undefined {
  // 微信机器人入口没有当前 Agent 页审批 UI；该入口只允许当前触发会话的受控回复附件。
  if (input.outputMode === 'wechat') return undefined

  const mcpTools = new Set(mcpToolNames)
  return ({ toolCall }): ToolApprovalStatus => {
    const toolName = String(toolCall.toolName || '')
    if (!HIGH_RISK_TOOL_NAMES.has(toolName) && !mcpTools.has(toolName)) return undefined
    return { type: 'user-approval', reason: approvalReason(toolName) }
  }
}
