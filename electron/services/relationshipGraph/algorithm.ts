import type { RelationshipGraphLink, RelationshipGraphRelationType } from '../../../src/types/models'
import {
  CO_OCCURRENCE_COUNT_WEIGHT,
  GROUP_DECAY_SECONDS,
  GROUP_LOOK_AHEAD,
  REPLY_WEIGHT,
} from './constants'

export interface RelationshipGroupMessage {
  senderUsername: string
  createTime: number
  sortSeq?: number
  localId?: number
  replyTargets?: string[]
}

export interface RelationshipEdgeAccumulator {
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
  messageCount: number
  sharedGroupCount: number
  lastInteractionTs: number
  lastActiveTime: number
  sourceSessionIds: Set<string>
  evidenceSessionIds: Set<string>
}

export function normalizeSeconds(value?: number): number | undefined {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

export function isGroupSession(username: string): boolean {
  return username.includes('@chatroom')
}

export function isPersonUsername(username: string): boolean {
  if (!username) return false
  if (isGroupSession(username)) return false
  if (username.startsWith('gh_')) return false
  if (username.includes('@kefu.openim')) return false
  if (username.includes('@openim')) return true
  return username.startsWith('wxid_') || !username.includes('@')
}

export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export function edgeKey(a: string, b: string, type: RelationshipGraphRelationType): string | null {
  if (!a || !b || a === b) return null
  const [source, target] = orderedPair(a, b)
  return `${type}:${source}::${target}`
}

export function createEdgeAccumulator(source: string, target: string, type: RelationshipGraphRelationType): RelationshipEdgeAccumulator {
  const [orderedSource, orderedTarget] = orderedPair(source, target)
  return {
    source: orderedSource,
    target: orderedTarget,
    type,
    weight: 0,
    coOccurrenceCount: 0,
    coOccurrenceRawScore: 0,
    replyInteractionCount: 0,
    repliesFromSourceToTarget: 0,
    repliesFromTargetToSource: 0,
    sourceGroupCount: 0,
    messageCount: 0,
    sharedGroupCount: 0,
    lastInteractionTs: 0,
    lastActiveTime: 0,
    sourceSessionIds: new Set<string>(),
    evidenceSessionIds: new Set<string>(),
  }
}

export function addEdgeAmount(
  edges: Map<string, RelationshipEdgeAccumulator>,
  a: string,
  b: string,
  type: RelationshipGraphRelationType,
  amount: Partial<Omit<RelationshipEdgeAccumulator, 'source' | 'target' | 'type' | 'sourceSessionIds' | 'evidenceSessionIds'>> & {
    sourceSessionId?: string
  },
): void {
  const key = edgeKey(a, b, type)
  if (!key) return
  let edge = edges.get(key)
  if (!edge) {
    edge = createEdgeAccumulator(a, b, type)
    edges.set(key, edge)
  }

  edge.weight += amount.weight || 0
  edge.coOccurrenceCount += amount.coOccurrenceCount || 0
  edge.coOccurrenceRawScore += amount.coOccurrenceRawScore || 0
  edge.replyInteractionCount += amount.replyInteractionCount || 0
  edge.messageCount += amount.messageCount || 0
  edge.sharedGroupCount += amount.sharedGroupCount || 0
  edge.lastInteractionTs = Math.max(edge.lastInteractionTs, amount.lastInteractionTs || 0)
  edge.lastActiveTime = Math.max(edge.lastActiveTime, amount.lastActiveTime || amount.lastInteractionTs || 0)
  if (amount.sourceSessionId) {
    const before = edge.sourceSessionIds.size
    edge.sourceSessionIds.add(amount.sourceSessionId)
    edge.evidenceSessionIds.add(amount.sourceSessionId)
    if (edge.sourceSessionIds.size > before) edge.sourceGroupCount += 1
  }
  edge.sourceGroupCount += amount.sourceGroupCount || 0

  const [source] = orderedPair(a, b)
  if ((amount.replyInteractionCount || 0) > 0) {
    if (a === source) edge.repliesFromSourceToTarget += amount.replyInteractionCount || 0
    else edge.repliesFromTargetToSource += amount.replyInteractionCount || 0
  }
}

function positionWeight(offset: number): number {
  return Math.max(0.25, (GROUP_LOOK_AHEAD - offset + 1) / GROUP_LOOK_AHEAD)
}

export function scoreGroupInteractions(
  messages: RelationshipGroupMessage[],
  groupId: string,
  selectedMemberIds?: Set<string>,
): Map<string, RelationshipEdgeAccumulator> {
  const edges = new Map<string, RelationshipEdgeAccumulator>()
  const ordered = [...messages]
    .filter((message) => isPersonUsername(message.senderUsername))
    .sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0)
      || Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
      || Number(a.localId || 0) - Number(b.localId || 0))

  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i]
    const currentSender = current.senderUsername
    if (selectedMemberIds && !selectedMemberIds.has(currentSender)) continue
    const currentTs = normalizeSeconds(current.createTime) || 0

    for (let offset = 1; offset <= GROUP_LOOK_AHEAD; offset += 1) {
      const previous = ordered[i - offset]
      if (!previous) break
      const previousSender = previous.senderUsername
      if (previousSender === currentSender) continue
      if (selectedMemberIds && !selectedMemberIds.has(previousSender)) continue
      const previousTs = normalizeSeconds(previous.createTime) || 0
      const delta = Math.max(0, currentTs - previousTs)
      const rawScore = Math.exp(-delta / GROUP_DECAY_SECONDS) * positionWeight(offset)
      addEdgeAmount(edges, previousSender, currentSender, 'group_interaction', {
        coOccurrenceCount: 1,
        coOccurrenceRawScore: rawScore,
        lastInteractionTs: currentTs,
        sourceSessionId: groupId,
      })
    }

    for (const target of current.replyTargets || []) {
      if (!isPersonUsername(target) || target === currentSender) continue
      if (selectedMemberIds && !selectedMemberIds.has(target)) continue
      addEdgeAmount(edges, currentSender, target, 'group_interaction', {
        replyInteractionCount: 1,
        lastInteractionTs: currentTs,
        sourceSessionId: groupId,
      })
    }
  }

  for (const edge of edges.values()) {
    edge.weight = edge.coOccurrenceRawScore
      + edge.replyInteractionCount * REPLY_WEIGHT
      + edge.coOccurrenceCount * CO_OCCURRENCE_COUNT_WEIGHT
  }

  return edges
}

export function toRelationshipLink(edge: RelationshipEdgeAccumulator): RelationshipGraphLink {
  return {
    id: `${edge.type}:${edge.source}:${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    weight: Number(edge.weight.toFixed(3)),
    coOccurrenceCount: edge.coOccurrenceCount,
    coOccurrenceRawScore: Number(edge.coOccurrenceRawScore.toFixed(3)),
    replyInteractionCount: edge.replyInteractionCount,
    repliesFromSourceToTarget: edge.repliesFromSourceToTarget,
    repliesFromTargetToSource: edge.repliesFromTargetToSource,
    sourceGroupCount: edge.sourceGroupCount,
    sourceSessionIds: Array.from(edge.sourceSessionIds).slice(0, 24),
    visibility: 'secondary',
    lastInteractionTs: edge.lastInteractionTs || undefined,
    messageCount: edge.messageCount || undefined,
    sharedGroupCount: edge.sharedGroupCount || undefined,
    lastActiveTime: edge.lastActiveTime || edge.lastInteractionTs || undefined,
    evidenceSessionIds: Array.from(edge.evidenceSessionIds).slice(0, 24),
  }
}
