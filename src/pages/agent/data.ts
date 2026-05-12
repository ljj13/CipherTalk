import type { AttachMenuItem, ConversationGroup, SlashCommand } from './types'

export const AGENT_HISTORY: ConversationGroup[] = []

export const AGENT_SUGGESTIONS: string[] = []

export const AGENT_SLASH_COMMANDS: SlashCommand[] = [
  { command: '/clear', description: '清空当前对话上下文' },
  { command: '/search', description: '按关键词检索聊天记录' },
  { command: '/stats', description: '生成联系人或群聊统计' },
  { command: '/moments', description: '分析朋友圈时间线' },
  { command: '/export', description: '准备聊天记录导出任务' },
  { command: '/think', description: '强制深度分析本轮问题' },
]

export const AGENT_ATTACH_MENU: AttachMenuItem[] = [
  { id: 'session', label: '附加会话', description: '指定联系人、群聊或时间范围', icon: 'database' },
  { id: 'file', label: '附加文件', description: 'Markdown / JSON / Excel / PDF', icon: 'file' },
  { id: 'image', label: '附加截图', description: '识别截图里的文字或表格', icon: 'image' },
  { id: 'web', label: '附加网页', description: '粘贴 URL 作为参考资料', icon: 'globe' },
]
