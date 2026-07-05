import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { chatService } from '../chatService'
import { dbAdapter } from '../dbAdapter'
import { findMessageDbPaths } from '../dbStoragePaths'
import { groupMetadataService } from '../groupMetadataService'
import {
  extractExactMessageTableHash,
  getMessageTableColumns,
  getMessageTableHash,
  hasName2IdTable,
  listExactMessageTables,
} from '../messageDbScanner'
import { parseQuoteMessage } from '../chat/contentParsers'
import { decodeMaybeCompressed, extractXmlValue } from '../chat/rowDecoders'
import { buildMessageStatsWhere, normalizeTimeRange, quoteIdent } from '../statsSqlHelpers'
import type { ChatSession, ContactInfo } from '../chat/types'
import type {
  RelationshipGraphBuildProgress,
  RelationshipGraphCommunity,
  RelationshipGraphData,
  RelationshipGraphDiagnostics,
  RelationshipGraphLink,
  RelationshipGraphNode,
  RelationshipGraphOptions,
  RelationshipGraphStats,
  RelationshipGraphTaskInfo,
  RelationshipGraphTimeRange,
} from '../../../src/types/models'
import {
  DEFAULT_GRAPH_SCOPE,
  MAX_DIRECT_SESSIONS,
  MAX_GROUP_MESSAGES_PER_SESSION,
  MAX_GROUP_SESSIONS,
  MAX_LINKS,
} from './constants'
import {
  addEdgeAmount,
  edgeKey,
  isGroupSession,
  isPersonUsername,
  normalizeSeconds,
  orderedPair,
  scoreGroupInteractions,
  toRelationshipLink,
  type RelationshipEdgeAccumulator,
  type RelationshipGroupMessage,
} from './algorithm'
import { RelationshipGraphFactsCache, type RelationshipGraphFacts, type RelationshipGraphGroupFacts } from './factsCache'
import { selectPanoramaGroupMembers, type PanoramaGroupSignal } from './groupFilter'
import { applyStableGoldenAngleLayout } from './layout'
import { buildCurrentRelationshipGraphSignature, type CurrentRelationshipGraphSignature } from './dataSignature'
import { resolveRelationshipTimeRange } from './timeRange'
import type { RelationshipGraphSnapshot } from './types'

type NodeDraft = Omit<RelationshipGraphNode, 'weightedDegree' | 'degree' | 'score' | 'rank' | 'x' | 'y' | 'size' | 'color' | 'labelVisibility' | 'searchText'> & {
  weightedDegree?: number
  degree?: number
  score?: number
  rank?: number
  x?: number
  y?: number
  size?: number
  color?: string
  labelVisibility?: RelationshipGraphNode['labelVisibility']
  searchText?: string
}

type GraphMessageTablePair = {
  dbPath: string
  tableName: string
  tableHash: string
}

type MessageTableIndex = {
  byHash: Map<string, GraphMessageTablePair[]>
}

type GroupGraphMessage = {
  senderUsername: string
  createTime: number
  sortSeq: number
  localId: number
  content?: string
}

const SESSION_PAGE_SIZE = 800

function displayNameOf(contact?: ContactInfo | null, fallback?: string): string {
  return String(contact?.displayName || contact?.remark || contact?.nickname || fallback || '').trim()
}

function decodeGraphMessageContent(messageContent: unknown, compressContent: unknown): string {
  const content = decodeMaybeCompressed(messageContent)
  if (content || !compressContent) return content
  return decodeMaybeCompressed(compressContent)
}

function unique(values: Iterable<string>, limit = 24): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).slice(0, limit)
}

function recencyBoost(lastActiveTime?: number): number {
  const ts = normalizeSeconds(lastActiveTime)
  if (!ts) return 0
  const ageDays = Math.max(0, (Date.now() / 1000 - ts) / 86400)
  if (ageDays <= 7) return 8
  if (ageDays <= 30) return 5
  if (ageDays <= 180) return 2
  return 0
}

function baseNode(id: string, label: string, kind: RelationshipGraphNode['kind'], patch: Partial<NodeDraft> = {}): RelationshipGraphNode {
  return {
    id,
    label,
    avatarUrl: patch.avatarUrl,
    kind,
    communityId: patch.communityId,
    score: 0,
    rank: 0,
    x: 0,
    y: 0,
    size: 8,
    color: '#94a3b8',
    labelVisibility: 'hover',
    privateMessageCount: patch.privateMessageCount || 0,
    groupMessageCount: patch.groupMessageCount || 0,
    commonGroupCount: patch.commonGroupCount || 0,
    searchText: '',
    weightedDegree: 0,
    degree: 0,
    lastActiveTime: patch.lastActiveTime,
  }
}

function mergeNode(nodes: Map<string, RelationshipGraphNode>, id: string, patch: Partial<NodeDraft>, contactMap: Map<string, ContactInfo>, myWxid: string): void {
  if (!isPersonUsername(id) && id !== myWxid) return
  const existing = nodes.get(id)
  const contact = contactMap.get(id)
  const label = patch.label || existing?.label || displayNameOf(contact, id)
  const kind = patch.kind || existing?.kind || (id === myWxid ? 'self' : contact?.type === 'friend' ? 'friend' : 'other')
  const next = existing || baseNode(id, label, kind, patch)
  next.label = label
  next.avatarUrl = patch.avatarUrl || next.avatarUrl || contact?.avatarUrl
  next.kind = kind
  next.communityId = patch.communityId || next.communityId
  next.privateMessageCount += patch.privateMessageCount || 0
  next.groupMessageCount += patch.groupMessageCount || 0
  next.commonGroupCount += patch.commonGroupCount || 0
  next.lastActiveTime = Math.max(Number(next.lastActiveTime || 0), Number(patch.lastActiveTime || 0)) || undefined
  nodes.set(id, next)
}

function directLink(myWxid: string, session: ChatSession, latest?: number): RelationshipGraphLink {
  const [source, target] = orderedPair(myWxid, session.username)
  const weight = Math.max(1, 1.2 + recencyBoost(latest))
  return {
    id: `direct_chat:${source}:${target}`,
    source,
    target,
    type: 'direct_chat',
    weight: Number(weight.toFixed(3)),
    coOccurrenceCount: 0,
    coOccurrenceRawScore: 0,
    replyInteractionCount: 0,
    repliesFromSourceToTarget: 0,
    repliesFromTargetToSource: 0,
    sourceGroupCount: 0,
    sourceSessionIds: [session.username],
    visibility: 'primary',
    lastInteractionTs: latest,
    messageCount: 1,
    sharedGroupCount: undefined,
    lastActiveTime: latest,
    evidenceSessionIds: [session.username],
  }
}

function extractMentionUsernames(content?: string): string[] {
  if (!content) return []
  const raw = extractXmlValue(content, 'atuserlist') || extractXmlValue(content, 'atuserlist_')
  if (!raw) return []
  return raw
    .split(/[,;，；\s]+/)
    .map((item) => item.trim())
    .filter(isPersonUsername)
    .slice(0, 12)
}

function buildGroupDisplayLookup(members: Array<{ username: string; displayName?: string }>, contactMap: Map<string, ContactInfo>): Map<string, string> {
  const lookup = new Map<string, string>()
  const addAlias = (alias: string | undefined, username: string) => {
    const normalized = String(alias || '').trim()
    if (normalized.length < 2) return
    if (isPersonUsername(username) && !lookup.has(normalized)) lookup.set(normalized, username)
  }

  for (const member of members) {
    const username = String(member.username || '').trim()
    if (!isPersonUsername(username)) continue
    const contact = contactMap.get(username)
    addAlias(member.displayName, username)
    addAlias(contact?.displayName, username)
    addAlias(contact?.remark, username)
    addAlias(contact?.nickname, username)
  }

  return lookup
}

function extractDisplayMentions(content: string | undefined, displayLookup: Map<string, string>): string[] {
  if (!content || !content.includes('@') || displayLookup.size === 0) return []
  const targets: string[] = []
  const names = [...displayLookup.keys()].sort((a, b) => b.length - a.length).slice(0, 160)
  for (const name of names) {
    if (targets.length >= 8) break
    if (content.includes(`@${name}`) || content.includes(`@ ${name}`)) {
      const username = displayLookup.get(name)
      if (username) targets.push(username)
    }
  }
  return unique(targets, 8)
}

function extractQuoteTarget(content: string | undefined, displayLookup: Map<string, string>): string | undefined {
  if (!content || !content.includes('<refermsg>')) return undefined
  const quoted = parseQuoteMessage(content)
  const sender = String(quoted.sender || '').trim()
  if (!sender) return undefined
  return displayLookup.get(sender)
}

async function loadAllSessions(): Promise<ChatSession[]> {
  const all: ChatSession[] = []
  for (let offset = 0; ; offset += SESSION_PAGE_SIZE) {
    const result = await chatService.getSessions(offset, SESSION_PAGE_SIZE)
    if (!result.success) throw new Error(result.error || '获取会话失败')
    const page = result.sessions || []
    all.push(...page)
    if (!result.hasMore || page.length === 0) break
  }
  return all
}

async function buildMessageTableIndex(sessionIds?: Set<string>): Promise<MessageTableIndex> {
  const byHash = new Map<string, GraphMessageTablePair[]>()
  const allowedHashes = sessionIds && sessionIds.size > 0
    ? new Set(Array.from(sessionIds).map((id) => getMessageTableHash(id)))
    : null

  for (const dbPath of findMessageDbPaths()) {
    const tables = await listExactMessageTables(dbPath).catch(() => [])
    for (const tableName of tables) {
      const tableHash = extractExactMessageTableHash(tableName)
      if (!tableHash) continue
      if (allowedHashes && !allowedHashes.has(tableHash)) continue
      const list = byHash.get(tableHash) || []
      list.push({ dbPath, tableName, tableHash })
      byHash.set(tableHash, list)
    }
  }

  return { byHash }
}

function getSessionMessagePairs(sessionId: string, index: MessageTableIndex): GraphMessageTablePair[] {
  return index.byHash.get(getMessageTableHash(sessionId)) || []
}

async function queryGroupMessagesFromPair(pair: GraphMessageTablePair, range: RelationshipGraphTimeRange, limit: number): Promise<GroupGraphMessage[]> {
  const columns = await getMessageTableColumns(pair.dbPath, pair.tableName)
  if (!columns.names.has('create_time')) return []

  const hasSortSeq = columns.names.has('sort_seq')
  const hasLocalId = columns.names.has('local_id')
  const sortExpr = hasSortSeq ? 'm.sort_seq' : 'm.create_time'
  const localExpr = hasLocalId ? 'm.local_id' : '0'
  const contentExpr = columns.contentColumn ? `m.${quoteIdent(columns.contentColumn)}` : 'NULL'
  const compressExpr = columns.names.has('compress_content') ? 'm.compress_content' : 'NULL'
  const table = quoteIdent(pair.tableName)
  const hasName2Id = await hasName2IdTable(pair.dbPath)
  const where = buildMessageStatsWhere({
    alias: 'm',
    contentColumn: columns.contentColumn || undefined,
    range: normalizeTimeRange(range.startTime, range.endTime),
  })
  const extraPrefix = where.sql ? `${where.sql} AND` : 'WHERE'
  const mapRows = (rows: Array<{
    senderUsername?: string
    createTime?: number
    sortSeq?: number
    localId?: number
    messageContent?: unknown
    compressContent?: unknown
  }>): GroupGraphMessage[] => rows.map((row) => ({
    senderUsername: String(row.senderUsername || '').trim(),
    createTime: Number(row.createTime || 0),
    sortSeq: Number(row.sortSeq || 0),
    localId: Number(row.localId || 0),
    content: decodeGraphMessageContent(row.messageContent, row.compressContent),
  }))

  if (hasName2Id && columns.hasRealSenderId) {
    const rows = await dbAdapter.all<any>(
      'message',
      pair.dbPath,
      `SELECT n.user_name AS senderUsername,
              m.create_time AS createTime,
              ${sortExpr} AS sortSeq,
              ${localExpr} AS localId,
              ${contentExpr} AS messageContent,
              ${compressExpr} AS compressContent
       FROM ${table} m
       LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
       ${extraPrefix} n.user_name IS NOT NULL AND n.user_name != ''
       ORDER BY ${sortExpr} DESC, m.create_time DESC, ${localExpr} DESC
       LIMIT ?`,
      [...where.params, limit],
    ).catch(() => [])
    return mapRows(rows)
  }

  if (columns.senderColumn) {
    const senderExpr = `m.${quoteIdent(columns.senderColumn)}`
    const rows = await dbAdapter.all<any>(
      'message',
      pair.dbPath,
      `SELECT ${senderExpr} AS senderUsername,
              m.create_time AS createTime,
              ${sortExpr} AS sortSeq,
              ${localExpr} AS localId,
              ${contentExpr} AS messageContent,
              ${compressExpr} AS compressContent
       FROM ${table} m
       ${extraPrefix} ${senderExpr} IS NOT NULL AND ${senderExpr} != ''
       ORDER BY ${sortExpr} DESC, m.create_time DESC, ${localExpr} DESC
       LIMIT ?`,
      [...where.params, limit],
    ).catch(() => [])
    return mapRows(rows)
  }

  return []
}

async function scanGroupMessages(sessionId: string, index: MessageTableIndex, range: RelationshipGraphTimeRange): Promise<GroupGraphMessage[]> {
  const pairs = getSessionMessagePairs(sessionId, index)
  if (pairs.length === 0) return []

  const messages: GroupGraphMessage[] = []
  for (const pair of pairs) {
    messages.push(...await queryGroupMessagesFromPair(pair, range, MAX_GROUP_MESSAGES_PER_SESSION))
  }

  return messages
    .filter((message) => message.senderUsername && Number(message.createTime || 0) > 0)
    .sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0)
      || Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
      || Number(a.localId || 0) - Number(b.localId || 0))
    .slice(-MAX_GROUP_MESSAGES_PER_SESSION)
}

async function buildFacts(
  signatureInfo: CurrentRelationshipGraphSignature,
  timeRange: RelationshipGraphTimeRange,
  options: RelationshipGraphOptions,
  onProgress?: (progress: RelationshipGraphBuildProgress) => void,
): Promise<RelationshipGraphFacts> {
  const myInfo = await chatService.getMyUserInfo()
  if (!myInfo.success || !myInfo.userInfo?.wxid) throw new Error(myInfo.error || '请先连接微信数据库')

  const contactsResult = await chatService.getContacts()
  const contacts = contactsResult.contacts || []
  const contactMap = new Map(contacts.map((contact) => [contact.username, contact]))
  const sessions = await loadAllSessions()
  const nodes = new Map<string, RelationshipGraphNode>()
  const directLinks: RelationshipGraphLink[] = []
  const groupFacts: RelationshipGraphGroupFacts[] = []
  const directSessionIds = new Set<string>()
  const groupSessions: ChatSession[] = []

  mergeNode(nodes, myInfo.userInfo.wxid, {
    label: myInfo.userInfo.nickName || myInfo.userInfo.alias || '我',
    avatarUrl: myInfo.userInfo.avatarUrl,
    kind: 'self',
  }, contactMap, myInfo.userInfo.wxid)

  onProgress?.({ stage: 'sessions', message: '正在生成私聊关系', current: 0, total: sessions.length })
  const directSessions = sessions
    .filter((session) => isPersonUsername(session.username))
    .sort((a, b) => Number(b.lastTimestamp || b.sortTimestamp || 0) - Number(a.lastTimestamp || a.sortTimestamp || 0))
    .slice(0, MAX_DIRECT_SESSIONS)
  for (const session of directSessions) directSessionIds.add(session.username)

  let sessionIndex = 0
  for (const session of sessions) {
    sessionIndex += 1
    if (isGroupSession(session.username)) {
      groupSessions.push(session)
      continue
    }
    if (!directSessionIds.has(session.username)) continue
    const latest = normalizeSeconds(session.lastTimestamp || session.sortTimestamp)
    if (timeRange.startTime && (!latest || latest < timeRange.startTime)) continue
    if (timeRange.endTime && latest && latest > timeRange.endTime) continue
    mergeNode(nodes, session.username, {
      label: session.displayName || displayNameOf(contactMap.get(session.username), session.username),
      avatarUrl: session.avatarUrl || contactMap.get(session.username)?.avatarUrl,
      kind: 'friend',
      privateMessageCount: 1,
      lastActiveTime: latest,
    }, contactMap, myInfo.userInfo.wxid)
    directLinks.push(directLink(myInfo.userInfo.wxid, session, latest))
    if (sessionIndex % 100 === 0) {
      onProgress?.({ stage: 'sessions', message: `正在生成私聊关系 ${sessionIndex}/${sessions.length}`, current: sessionIndex, total: sessions.length })
    }
  }

  const candidateGroups = groupSessions
    .sort((a, b) => Number(b.lastTimestamp || b.sortTimestamp || 0) - Number(a.lastTimestamp || a.sortTimestamp || 0))
    .slice(0, MAX_GROUP_SESSIONS)
  const memberCountMap = await groupMetadataService.getMemberCountMap(candidateGroups.map((group) => group.username))
  onProgress?.({ stage: 'groups', message: `正在索引 ${candidateGroups.length}/${groupSessions.length} 个群聊`, current: 0, total: candidateGroups.length })
  const tableIndex = await buildMessageTableIndex(new Set(candidateGroups.map((group) => group.username)))

  let groupsAccepted = 0
  let groupsSkipped = 0
  for (let i = 0; i < candidateGroups.length; i += 1) {
    const group = candidateGroups[i]
    const messages = await scanGroupMessages(group.username, tableIndex, timeRange).catch(() => [])
    if (messages.length < 2) {
      groupsSkipped += 1
      groupFacts.push({
        groupId: group.username,
        selectedMemberIds: [],
        memberMessageCounts: {},
        memberLastActiveTimes: {},
        links: [],
        skippedReason: 'no-messages',
      })
      continue
    }

    const active = new Map<string, { messageCount: number; lastActiveTime: number; replyInteractionCount: number }>()
    const candidateMemberIds = new Set<string>()
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const sender = String(message.senderUsername || '').trim()
      if (!isPersonUsername(sender)) continue
      candidateMemberIds.add(sender)
      const ts = normalizeSeconds(message.createTime) || 0
      const item = active.get(sender) || { messageCount: 0, lastActiveTime: 0, replyInteractionCount: 0 }
      item.messageCount += 1
      item.lastActiveTime = Math.max(item.lastActiveTime, ts)
      active.set(sender, item)
      for (const target of extractMentionUsernames(message.content)) candidateMemberIds.add(target)
    }

    const members = await groupMetadataService.getGroupMembersByUsernames(group.username, Array.from(candidateMemberIds)).catch(() => [])
    const displayLookup = buildGroupDisplayLookup(members, contactMap)
    const augmentedMessages: RelationshipGroupMessage[] = messages.map((message, index) => {
      const content = message.content || ''
      const sender = String(message.senderUsername || '').trim()
      const targets = new Set<string>()
      for (const target of extractMentionUsernames(content)) targets.add(target)
      for (const target of extractDisplayMentions(content, displayLookup)) targets.add(target)
      const quoteTarget = extractQuoteTarget(content, displayLookup)
      if (quoteTarget) targets.add(quoteTarget)
      const previous = messages[index - 1]
      const previousSender = String(previous?.senderUsername || '').trim()
      const delta = (normalizeSeconds(message.createTime) || 0) - (normalizeSeconds(previous?.createTime) || 0)
      if (previousSender && previousSender !== sender && delta >= 0 && delta <= 180) targets.add(previousSender)
      for (const target of targets) {
        const item = active.get(sender)
        if (item) item.replyInteractionCount += 1
      }
      return {
        senderUsername: sender,
        createTime: message.createTime,
        sortSeq: message.sortSeq,
        localId: message.localId,
        replyTargets: Array.from(targets).filter((target) => target !== sender),
      }
    })

    const groupSignal: PanoramaGroupSignal = {
      groupId: group.username,
      memberCount: memberCountMap.get(group.username) || active.size,
      totalMessageCount: messages.length,
      myMessageCount: active.get(myInfo.userInfo.wxid)?.messageCount || 0,
      friendCount: Array.from(active.keys()).filter((id) => contactMap.get(id)?.type === 'friend').length,
      connectedToMeCount: Array.from(active.keys()).filter((id) => directSessionIds.has(id)).length,
      members: Array.from(active.entries()).map(([username, stats]) => ({
        username,
        isFriend: contactMap.get(username)?.type === 'friend',
        connectedToMe: directSessionIds.has(username),
        messageCount: stats.messageCount,
        replyInteractionCount: stats.replyInteractionCount,
        friendConnectionCount: (contactMap.get(username)?.type === 'friend' ? 1 : 0) + (directSessionIds.has(username) ? 1 : 0),
        lastActiveTime: stats.lastActiveTime,
      })),
    }

    const decision = (options.graphScope || DEFAULT_GRAPH_SCOPE) === 'friends'
      ? {
          accepted: true,
          reason: 'friends-scope',
          selectedMembers: groupSignal.members.filter((member) => member.isFriend || member.connectedToMe).map((member) => member.username).slice(0, 80),
        }
      : selectPanoramaGroupMembers(groupSignal)

    const memberMessageCounts: Record<string, number> = {}
    const memberLastActiveTimes: Record<string, number> = {}
    for (const id of decision.selectedMembers) {
      const item = active.get(id)
      if (!item) continue
      memberMessageCounts[id] = item.messageCount
      memberLastActiveTimes[id] = item.lastActiveTime
    }

    if (!decision.accepted) {
      groupsSkipped += 1
      groupFacts.push({
        groupId: group.username,
        selectedMemberIds: [],
        memberMessageCounts,
        memberLastActiveTimes,
        links: [],
        skippedReason: decision.reason,
      })
      continue
    }

    groupsAccepted += 1
    const selectedSet = new Set(decision.selectedMembers)
    const edgeMap = scoreGroupInteractions(augmentedMessages, group.username, selectedSet)
    const links = Array.from(edgeMap.values())
      .map(toRelationshipLink)
      .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
      .slice(0, 1200)

    for (const member of members) {
      if (!selectedSet.has(member.username)) continue
      const stats = active.get(member.username)
      mergeNode(nodes, member.username, {
        label: member.displayName || displayNameOf(contactMap.get(member.username), member.username),
        avatarUrl: member.avatarUrl || contactMap.get(member.username)?.avatarUrl,
        kind: contactMap.get(member.username)?.type === 'friend' ? 'friend' : 'group_member',
        groupMessageCount: stats?.messageCount || 0,
        commonGroupCount: 1,
        lastActiveTime: stats?.lastActiveTime,
      }, contactMap, myInfo.userInfo.wxid)
    }

    groupFacts.push({
      groupId: group.username,
      selectedMemberIds: decision.selectedMembers,
      memberMessageCounts,
      memberLastActiveTimes,
      links,
    })

    onProgress?.({ stage: 'groups', message: `正在计算群聊共同关系 ${i + 1}/${candidateGroups.length}`, current: i + 1, total: candidateGroups.length })
  }

  return {
    key: signatureInfo.factsCacheKey,
    createdAt: Date.now(),
    nodes: Array.from(nodes.values()),
    directLinks,
    groupFacts,
    diagnostics: {
      groupsConsidered: candidateGroups.length,
      groupsAccepted,
      groupsSkipped,
    },
  }
}

function graphFromFacts(
  facts: RelationshipGraphFacts,
  signatureInfo: CurrentRelationshipGraphSignature,
  timeRange: RelationshipGraphTimeRange,
  factsCacheHit: boolean,
): { graph: RelationshipGraphData; diagnostics: RelationshipGraphDiagnostics } {
  const nodes = new Map(facts.nodes.map((node) => [node.id, { ...node }]))
  const edgeMap = new Map<string, RelationshipEdgeAccumulator>()
  const allLinks = [...facts.directLinks]

  for (const group of facts.groupFacts) {
    allLinks.push(...group.links)
    for (const id of group.selectedMemberIds) {
      const node = nodes.get(id)
      if (!node) continue
      node.lastActiveTime = Math.max(Number(node.lastActiveTime || 0), Number(group.memberLastActiveTimes[id] || 0)) || undefined
    }
  }

  for (const link of allLinks) {
    const key = edgeKey(String(link.source), String(link.target), link.type)
    if (!key) continue
    addEdgeAmount(edgeMap, String(link.source), String(link.target), link.type, {
      weight: Number(link.weight || 0),
      coOccurrenceCount: link.coOccurrenceCount || 0,
      coOccurrenceRawScore: link.coOccurrenceRawScore || 0,
      replyInteractionCount: 0,
      messageCount: link.messageCount || 0,
      sharedGroupCount: link.sharedGroupCount || 0,
      lastInteractionTs: link.lastInteractionTs || link.lastActiveTime || 0,
      lastActiveTime: link.lastActiveTime || link.lastInteractionTs || 0,
    })
    const edge = edgeMap.get(key)
    if (!edge) continue
    for (const sourceSessionId of link.sourceSessionIds || link.evidenceSessionIds || []) {
      const before = edge.sourceSessionIds.size
      edge.sourceSessionIds.add(sourceSessionId)
      edge.evidenceSessionIds.add(sourceSessionId)
      if (edge.sourceSessionIds.size > before && link.type !== 'direct_chat') edge.sourceGroupCount += 1
    }
    edge.replyInteractionCount += link.replyInteractionCount || 0
    edge.repliesFromSourceToTarget += link.repliesFromSourceToTarget || 0
    edge.repliesFromTargetToSource += link.repliesFromTargetToSource || 0
  }

  let links = Array.from(edgeMap.values())
    .map(toRelationshipLink)
    .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))
    .slice(0, MAX_LINKS)

  const nodeList = Array.from(nodes.values())
  assignNodeMetrics(nodeList, links)
  assignCommunities(nodeList, links)
  links = links.filter((link) => nodeList.some((node) => node.id === String(link.source)) && nodeList.some((node) => node.id === String(link.target)))
  const graph = applyStableGoldenAngleLayout({
    nodes: nodeList,
    links,
  })
  graph.communities = buildCommunities(graph.nodes)
  graph.rankings = buildRankings(graph.nodes)
  graph.similar = buildSimilar(graph.nodes, graph.links)
  graph.stats = buildStats(graph, Date.now(), false)

  return {
    graph,
    diagnostics: {
      signature: signatureInfo.signature,
      dbVersion: signatureInfo.dbVersion,
      contactVersion: signatureInfo.contactVersion,
      groupMetadataVersion: signatureInfo.groupMetadataVersion,
      factsCacheKey: signatureInfo.factsCacheKey,
      factsCacheHit,
      groupsConsidered: facts.diagnostics.groupsConsidered,
      groupsAccepted: facts.diagnostics.groupsAccepted,
      groupsSkipped: facts.diagnostics.groupsSkipped,
      warnings: timeRange.preset === 'all' ? ['all-time graph can be dense'] : [],
    },
  }
}

function assignNodeMetrics(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    node.degree = 0
    node.weightedDegree = 0
  }
  for (const link of links) {
    const source = nodeMap.get(String(link.source))
    const target = nodeMap.get(String(link.target))
    if (!source || !target) continue
    source.degree += 1
    target.degree += 1
    source.weightedDegree = Number((source.weightedDegree + Number(link.weight || 0)).toFixed(3))
    target.weightedDegree = Number((target.weightedDegree + Number(link.weight || 0)).toFixed(3))
    const last = normalizeSeconds(link.lastActiveTime || link.lastInteractionTs)
    if (last) {
      source.lastActiveTime = Math.max(Number(source.lastActiveTime || 0), last)
      target.lastActiveTime = Math.max(Number(target.lastActiveTime || 0), last)
    }
  }
}

function assignCommunities(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
  try {
    const connectedNodes = nodes.filter((node) => node.degree > 0)
    for (const node of nodes) if (node.degree === 0) node.communityId = 'isolated'
    if (connectedNodes.length === 0) return
    const graph = new Graph({ type: 'undirected', multi: false })
    for (const node of connectedNodes) graph.addNode(node.id)
    for (const link of links) {
      const source = String(link.source)
      const target = String(link.target)
      if (!graph.hasNode(source) || !graph.hasNode(target) || graph.hasEdge(source, target)) continue
      graph.addUndirectedEdge(source, target, { weight: Math.max(0.01, Number(link.weight || 0.01)) })
    }
    const communities = louvain(graph, { getEdgeWeight: 'weight' }) as Record<string, number>
    for (const node of connectedNodes) node.communityId = `c${communities[node.id] ?? 0}`
  } catch {
    assignComponentCommunities(nodes, links)
  }
}

function assignComponentCommunities(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
  const adjacency = new Map<string, string[]>()
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (node.degree === 0) node.communityId = 'isolated'
    else adjacency.set(node.id, [])
  }
  for (const link of links) {
    adjacency.get(String(link.source))?.push(String(link.target))
    adjacency.get(String(link.target))?.push(String(link.source))
  }
  const visited = new Set<string>()
  let community = 0
  for (const node of nodes) {
    if (node.degree === 0 || visited.has(node.id)) continue
    const id = `c${community++}`
    const stack = [node.id]
    visited.add(node.id)
    while (stack.length) {
      const current = stack.pop()!
      const currentNode = nodeMap.get(current)
      if (currentNode) currentNode.communityId = id
      for (const next of adjacency.get(current) || []) {
        if (visited.has(next)) continue
        visited.add(next)
        stack.push(next)
      }
    }
  }
}

function buildCommunities(nodes: RelationshipGraphNode[]): RelationshipGraphCommunity[] {
  const map = new Map<string, RelationshipGraphCommunity>()
  for (const node of nodes) {
    const id = node.communityId || 'c0'
    const item = map.get(id) || { id, label: id === 'isolated' ? '孤岛' : `社群 ${id.replace(/^c/, '')}`, size: 0, weight: 0 }
    item.size += 1
    item.weight = Number((item.weight + node.weightedDegree).toFixed(3))
    map.set(id, item)
  }
  return Array.from(map.values()).sort((a, b) => b.size - a.size)
}

function buildRankings(nodes: RelationshipGraphNode[]): NonNullable<RelationshipGraphData['rankings']> {
  return {
    central: [...nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 24),
    isolated: nodes.filter((node) => node.degree === 0).sort((a, b) => (b.lastActiveTime || 0) - (a.lastActiveTime || 0)).slice(0, 24),
    active: [...nodes].sort((a, b) => (b.lastActiveTime || 0) - (a.lastActiveTime || 0)).slice(0, 24),
  }
}

function buildSimilar(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): Record<string, RelationshipGraphNode[]> {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const connectedNodes = nodes.filter((node) => node.degree > 0)
  const neighbors = new Map<string, Set<string>>()
  for (const node of connectedNodes) neighbors.set(node.id, new Set())
  for (const link of links) {
    neighbors.get(String(link.source))?.add(String(link.target))
    neighbors.get(String(link.target))?.add(String(link.source))
  }
  const anchors = [...connectedNodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 80)
  const result: Record<string, RelationshipGraphNode[]> = {}
  for (const anchor of anchors) {
    const anchorNeighbors = neighbors.get(anchor.id) || new Set()
    if (anchorNeighbors.size === 0) continue
    const scored = connectedNodes
      .filter((node) => node.id !== anchor.id)
      .map((node) => {
        const otherNeighbors = neighbors.get(node.id) || new Set()
        let intersection = 0
        for (const id of anchorNeighbors) if (otherNeighbors.has(id)) intersection += 1
        const union = new Set([...anchorNeighbors, ...otherNeighbors]).size || 1
        return { node, score: intersection / union }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.node.weightedDegree - a.node.weightedDegree)
      .slice(0, 6)
      .map((item) => nodeMap.get(item.node.id)!)
    if (scored.length) result[anchor.id] = scored
  }
  return result
}

function buildStats(graph: RelationshipGraphData, builtAt: number, stale: boolean): RelationshipGraphStats {
  return {
    nodeCount: graph.nodes.length,
    linkCount: graph.links.length,
    directChatCount: graph.links.filter((link) => link.type === 'direct_chat').length,
    sameGroupCount: graph.links.filter((link) => link.type === 'same_group').length,
    groupInteractionCount: graph.links.filter((link) => link.type === 'group_interaction').length,
    isolatedCount: graph.nodes.filter((node) => node.degree === 0).length,
    communityCount: graph.communities?.length || 0,
    builtAt,
    stale,
  }
}

export async function buildRelationshipGraphSnapshot(
  request: {
    taskId: string
    options: RelationshipGraphOptions
    cacheBaseDir: string
    onProgress?: (progress: RelationshipGraphBuildProgress) => void
  },
): Promise<RelationshipGraphSnapshot> {
  const startedAt = Date.now()
  const timeRange = resolveRelationshipTimeRange(request.options)
  const signatureInfo = await buildCurrentRelationshipGraphSignature(request.options, timeRange)
  const factsCache = new RelationshipGraphFactsCache(request.cacheBaseDir)
  let facts = factsCache.get(signatureInfo.factsCacheKey)
  const factsCacheHit = Boolean(facts)

  request.onProgress?.({
    taskId: request.taskId,
    stage: facts ? 'facts' : 'loading',
    status: 'running',
    message: facts ? '命中关系 facts cache' : '正在读取联系人和会话',
  })

  if (!facts) {
    facts = await buildFacts(signatureInfo, timeRange, request.options, (progress) => {
      request.onProgress?.({ ...progress, taskId: request.taskId, status: 'running' })
    })
    factsCache.put(signatureInfo.factsCacheKey, facts)
  }

  request.onProgress?.({ taskId: request.taskId, stage: 'layout', status: 'running', message: '正在生成稳定布局' })
  const { graph, diagnostics } = graphFromFacts(facts, signatureInfo, timeRange, factsCacheHit)
  const builtAt = Date.now()
  graph.stats = buildStats(graph, builtAt, false)
  diagnostics.buildMs = builtAt - startedAt

  return {
    success: true,
    graph,
    diagnostics,
    timeRange,
    algorithmVersion: signatureInfo.algorithmVersion,
    signature: signatureInfo.signature,
    builtAt,
  }
}

export function taskFromProgress(taskId: string, progress: RelationshipGraphBuildProgress): RelationshipGraphTaskInfo {
  return {
    id: taskId,
    status: progress.status || (progress.stage === 'error' ? 'failed' : progress.stage === 'done' ? 'completed' : 'running'),
    stage: progress.stage,
    message: progress.message,
    current: progress.current,
    total: progress.total,
    updatedAt: Date.now(),
  }
}
