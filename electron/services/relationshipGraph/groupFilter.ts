import { MAX_GROUP_SELECTED_MEMBERS } from './constants'

export interface PanoramaMemberSignal {
  username: string
  isFriend: boolean
  connectedToMe: boolean
  messageCount: number
  replyInteractionCount: number
  friendConnectionCount: number
  lastActiveTime: number
}

export interface PanoramaGroupSignal {
  groupId: string
  memberCount: number
  totalMessageCount: number
  myMessageCount: number
  friendCount: number
  connectedToMeCount: number
  members: PanoramaMemberSignal[]
}

export interface PanoramaGroupDecision {
  accepted: boolean
  reason: string
  selectedMembers: string[]
}

const MIN_FRIEND_COUNT = 2
const MIN_FRIEND_RATIO = 0.035
const MIN_CONNECTED_TO_ME = 1
const MAX_MY_MESSAGE_RATIO = 0.72
const MIN_MY_MESSAGES = 1
const SMALL_GROUP_MEMBER_LIMIT = 30
const SMALL_GROUP_MIN_FRIEND_CONNECTIONS = 1

function memberScore(member: PanoramaMemberSignal): number {
  return (
    member.messageCount * 1.4
    + member.replyInteractionCount * 4
    + member.friendConnectionCount * 2
    + (member.isFriend ? 12 : 0)
    + (member.connectedToMe ? 10 : 0)
    + Math.log1p(member.lastActiveTime || 0) * 0.001
  )
}

function pushLayer(target: string[], seen: Set<string>, members: PanoramaMemberSignal[], predicate: (member: PanoramaMemberSignal) => boolean): void {
  const ranked = members
    .filter(predicate)
    .sort((a, b) => memberScore(b) - memberScore(a))
  for (const member of ranked) {
    if (target.length >= MAX_GROUP_SELECTED_MEMBERS) return
    if (seen.has(member.username)) continue
    seen.add(member.username)
    target.push(member.username)
  }
}

export function selectPanoramaGroupMembers(group: PanoramaGroupSignal): PanoramaGroupDecision {
  const activeCount = Math.max(1, group.members.length)
  const friendRatio = group.friendCount / activeCount
  const myMessageRatio = group.totalMessageCount > 0 ? group.myMessageCount / group.totalMessageCount : 0

  if (group.myMessageCount < MIN_MY_MESSAGES) {
    return { accepted: false, reason: 'my-message-too-low', selectedMembers: [] }
  }
  if (myMessageRatio > MAX_MY_MESSAGE_RATIO && activeCount > 8) {
    return { accepted: false, reason: 'my-message-ratio-too-high', selectedMembers: [] }
  }
  if (group.friendCount < MIN_FRIEND_COUNT && friendRatio < MIN_FRIEND_RATIO && group.connectedToMeCount < MIN_CONNECTED_TO_ME) {
    return { accepted: false, reason: 'friend-signal-too-low', selectedMembers: [] }
  }
  if (
    group.memberCount <= SMALL_GROUP_MEMBER_LIMIT
    && group.friendCount === 0
    && group.members.every((member) => member.friendConnectionCount < SMALL_GROUP_MIN_FRIEND_CONNECTIONS)
  ) {
    return { accepted: false, reason: 'small-group-no-friend-connection', selectedMembers: [] }
  }

  const selected: string[] = []
  const seen = new Set<string>()
  const members = [...group.members]

  pushLayer(selected, seen, members, (member) => member.isFriend)
  pushLayer(selected, seen, members, (member) => member.connectedToMe)
  pushLayer(selected, seen, members, (member) => member.friendConnectionCount > 0)
  pushLayer(selected, seen, members, () => true)

  return {
    accepted: selected.length > 1,
    reason: selected.length > 1 ? 'accepted' : 'not-enough-selected-members',
    selectedMembers: selected,
  }
}
