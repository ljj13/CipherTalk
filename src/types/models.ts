// 聊天会话
export interface ChatSession {
  username: string
  type: number
  unreadCount: number
  summary: string
  sortTimestamp: number  // 用于排序
  lastTimestamp: number  // 用于显示时间
  lastMsgType: number
  displayName?: string
  avatarUrl?: string
  isWeCom?: boolean      // 企业微信用户（username 含 @openim）
  weComCorp?: string     // 企业微信所属企业名称（从 extra_buffer 中解析）
  isPinned?: boolean     // 置顶（contact.flag 第 11 位）
  isCollapsed?: boolean  // 折叠的群聊（contact.flag 第 28 位）
  isFoldGroup?: boolean  // 折叠的聊天聚合虚拟会话 (@placeholder_foldgroup)
  isOfficialFolder?: boolean  // 公众号聚合虚拟会话 (brandsessionholder)
  isOfficialAccount?: boolean // 单个公众号 (gh_ 开头)
}

// 联系人
export interface Contact {
  id: number
  username: string
  localType: number
  alias: string
  remark: string
  nickName: string
  bigHeadUrl: string
  smallHeadUrl: string
}

// 通讯录联系人（用于导出）
export interface ContactInfo {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
  isWeCom?: boolean
  weComCorp?: string
}

// 消息
export interface Message {
  localId: number
  serverId: number
  localType: number
  createTime: number
  sortSeq: number  // 排序序列号，用于精确去重
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
  imageMd5?: string
  imageDatName?: string
  isLivePhoto?: boolean  // 是否为实况照片
  emojiCdnUrl?: string
  emojiMd5?: string
  emojiEncryptUrl?: string
  emojiAesKey?: string
  voiceDuration?: number  // 语音时长（秒）
  // 引用消息
  quotedContent?: string
  quotedSender?: string
  quotedImageMd5?: string
  quotedEmojiMd5?: string
  quotedEmojiCdnUrl?: string
  // 视频相关
  videoMd5?: string
  videoDuration?: number  // 视频时长（秒）
  rawContent?: string
  productId?: string
  // 文件消息相关
  fileName?: string       // 文件名
  fileSize?: number       // 文件大小（字节）
  fileExt?: string        // 文件扩展名
  fileMd5?: string        // 文件 MD5
  chatRecordList?: ChatRecordItem[] // 聊天记录列表 (Type 19)
  // 转账消息
  transferPayerUsername?: string    // 转账付款方 wxid
  transferReceiverUsername?: string // 转账收款方 wxid
}

export interface ChatRecordItem {
  datatype: number
  datadesc?: string
  datatitle?: string
  sourcename?: string
  sourcetime?: string
  sourceheadurl?: string
  fileext?: string
  datasize?: number
  messageuuid?: string
  // 媒体信息
  dataurl?: string      // 原始地址
  datathumburl?: string // 缩略图地址
  datacdnurl?: string   // CDN地址
  qaeskey?: string      // AES Key (通常在 recorditem 中是 qaeskey 或 aeskey)
  aeskey?: string
  md5?: string
  imgheight?: number
  imgwidth?: number
  thumbheadurl?: string // 视频/图片缩略图
  duration?: number     // 语音/视频时长
}

// 分析数据
export interface AnalyticsData {
  totalMessages: number
  totalDays: number
  myMessages: number
  otherMessages: number
  messagesByType: Record<number, number>
  messagesByHour: number[]
  messagesByDay: number[]
}

export type RelationshipGraphRelationType = 'direct_chat' | 'same_group' | 'group_interaction'
export type RelationshipGraphTimeRangePreset = '1y' | '2y' | '3y' | '5y' | 'all'
export type RelationshipGraphScope = 'panorama' | 'close' | 'friends'
export type RelationshipGraphLabelVisibility = 'always' | 'hover' | 'hidden'
export type RelationshipGraphLinkVisibility = 'primary' | 'secondary' | 'hidden'
export type RelationshipGraphTaskStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface RelationshipGraphNode {
  id: string
  label: string
  avatarUrl?: string
  kind: 'self' | 'friend' | 'group_member' | 'other'
  communityId?: string
  score: number
  rank: number
  x: number
  y: number
  size: number
  color: string
  labelVisibility: RelationshipGraphLabelVisibility
  privateMessageCount: number
  groupMessageCount: number
  commonGroupCount: number
  searchText: string
  weightedDegree: number
  degree: number
  lastActiveTime?: number
}

export interface RelationshipGraphLink {
  id: string
  source: string
  target: string
  type: RelationshipGraphRelationType
  weight: number
  coOccurrenceCount: number
  coOccurrenceRawScore: number
  replyInteractionCount: number
  repliesFromSourceToTarget: number
  repliesFromTargetToSource: number
  sourceGroupCount: number
  sourceSessionIds: string[]
  visibility: RelationshipGraphLinkVisibility
  lastInteractionTs?: number
  messageCount?: number
  sharedGroupCount?: number
  lastActiveTime?: number
  evidenceSessionIds: string[]
}

export interface RelationshipGraphOptions {
  acceptStale?: boolean
  forceRecompute?: boolean
  timeRangePreset?: RelationshipGraphTimeRangePreset
  graphScope?: RelationshipGraphScope
  startTime?: number
  endTime?: number
  relationTypes?: RelationshipGraphRelationType[]
  minWeight?: number
  includeIsolated?: boolean
  query?: string
  communityId?: string
}

export interface RelationshipGraphCommunity {
  id: string
  label: string
  size: number
  weight: number
}

export interface RelationshipGraphStats {
  nodeCount: number
  linkCount: number
  directChatCount: number
  sameGroupCount: number
  groupInteractionCount: number
  isolatedCount: number
  communityCount: number
  builtAt: number
  stale: boolean
}

export type RelationshipGraphBuildStage = 'queued' | 'snapshot' | 'loading' | 'facts' | 'sessions' | 'groups' | 'analyzing' | 'layout' | 'caching' | 'done' | 'error'

export interface RelationshipGraphData {
  nodes: RelationshipGraphNode[]
  links: RelationshipGraphLink[]
  communities?: RelationshipGraphCommunity[]
  rankings?: {
    central: RelationshipGraphNode[]
    isolated: RelationshipGraphNode[]
    active: RelationshipGraphNode[]
  }
  similar?: Record<string, RelationshipGraphNode[]>
  stats?: RelationshipGraphStats
}

export interface RelationshipGraphTimeRange {
  preset: RelationshipGraphTimeRangePreset
  startTime?: number
  endTime?: number
}

export interface RelationshipGraphSearchResults {
  query?: string
  nodeIds: string[]
  linkIds: string[]
}

export interface RelationshipGraphDiagnostics {
  signature?: string
  dbVersion?: string
  contactVersion?: string
  groupMetadataVersion?: string
  factsCacheKey?: string
  factsCacheHit?: boolean
  groupsConsidered?: number
  groupsAccepted?: number
  groupsSkipped?: number
  buildMs?: number
  warnings?: string[]
}

export interface RelationshipGraphCacheInfo {
  hit: boolean
  stale: boolean
  snapshotPath?: string
  builtAt?: number
  ageMs?: number
  signature?: string
  reason?: string
  factsHit?: boolean
}

export interface RelationshipGraphTaskInfo {
  id: string
  status: RelationshipGraphTaskStatus
  stage?: RelationshipGraphBuildStage
  message?: string
  current?: number
  total?: number
  startedAt?: number
  updatedAt?: number
  finishedAt?: number
  error?: string
}

export interface RelationshipGraphResult {
  success: boolean
  graph?: RelationshipGraphData
  searchResults?: RelationshipGraphSearchResults
  diagnostics?: RelationshipGraphDiagnostics
  cache?: RelationshipGraphCacheInfo
  task?: RelationshipGraphTaskInfo
  timeRange?: RelationshipGraphTimeRange
  algorithmVersion?: string
  /** @deprecated Use graph.nodes. Kept for old renderer callers during migration. */
  nodes?: RelationshipGraphNode[]
  /** @deprecated Use graph.links. Kept for old renderer callers during migration. */
  links?: RelationshipGraphLink[]
  communities?: RelationshipGraphCommunity[]
  rankings?: {
    central: RelationshipGraphNode[]
    isolated: RelationshipGraphNode[]
    active: RelationshipGraphNode[]
  }
  similar?: Record<string, RelationshipGraphNode[]>
  stats?: RelationshipGraphStats
  error?: string
}

export interface RelationshipGraphPartialResult extends RelationshipGraphResult {
  preview: boolean
  stage: RelationshipGraphBuildStage
  message: string
  current?: number
  total?: number
}

export interface RelationshipGraphPathResult {
  success: boolean
  nodeIds?: string[]
  links?: RelationshipGraphLink[]
  error?: string
}

export interface RelationshipGraphBuildProgress {
  taskId?: string
  stage: RelationshipGraphBuildStage
  message: string
  current?: number
  total?: number
  status?: RelationshipGraphTaskStatus
}
