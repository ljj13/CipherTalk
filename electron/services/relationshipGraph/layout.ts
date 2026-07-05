import type { RelationshipGraphData, RelationshipGraphLink, RelationshipGraphNode } from '../../../src/types/models'
import { COMMUNITY_COLORS } from './constants'

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

function colorForNode(node: RelationshipGraphNode, communityIndex: number): string {
  if (node.kind === 'self') return '#38bdf8'
  if (node.kind === 'friend' && node.degree <= 1) return '#34d399'
  if (node.kind === 'group_member' && node.degree <= 1) return '#f59e0b'
  return COMMUNITY_COLORS[Math.abs(communityIndex) % COMMUNITY_COLORS.length]
}

function scoreNode(node: RelationshipGraphNode): number {
  return Number((
    (node.weightedDegree || 0)
    + Math.log1p(node.privateMessageCount || 0) * 2
    + Math.log1p(node.groupMessageCount || 0)
    + Math.log1p(node.commonGroupCount || 0) * 1.5
  ).toFixed(3))
}

function visibilityForRank(rank: number, score: number): 'always' | 'hover' | 'hidden' {
  if (rank <= 32 || score >= 12) return 'always'
  if (rank <= 180 || score >= 3) return 'hover'
  return 'hidden'
}

function communityOrdinal(id?: string): number {
  if (!id || id === 'isolated') return 0
  const numeric = Number(String(id).replace(/^c/, ''))
  return Number.isFinite(numeric) ? numeric : 0
}

export function applyStableGoldenAngleLayout(graph: RelationshipGraphData): RelationshipGraphData {
  const nodes = graph.nodes.map((node) => ({ ...node }))
  const links = graph.links.map((link) => ({ ...link }))
  const sorted = [...nodes].sort((a, b) => scoreNode(b) - scoreNode(a) || a.id.localeCompare(b.id))
  const maxScore = Math.max(1, ...sorted.map(scoreNode))
  const communityCounts = new Map<string, number>()

  sorted.forEach((node, index) => {
    const communityId = node.communityId || 'c0'
    const withinCommunityIndex = communityCounts.get(communityId) || 0
    communityCounts.set(communityId, withinCommunityIndex + 1)

    const communityIndex = communityOrdinal(communityId)
    const communityRing = communityId === 'isolated' ? 5 : 1 + (communityIndex % 8)
    const communityAngle = communityIndex * GOLDEN_ANGLE
    const clusterRadius = 140 + communityRing * 34
    const clusterX = Math.cos(communityAngle) * clusterRadius
    const clusterY = Math.sin(communityAngle) * clusterRadius
    const localRadius = Math.sqrt(withinCommunityIndex + 1) * 16
    const localAngle = withinCommunityIndex * GOLDEN_ANGLE
    const score = scoreNode(node)
    const rank = index + 1

    node.score = score
    node.rank = rank
    node.size = Number((5 + Math.sqrt(score / maxScore) * 19 + Math.log1p(node.degree || 0) * 1.4).toFixed(2))
    node.x = Number((clusterX + Math.cos(localAngle) * localRadius).toFixed(2))
    node.y = Number((clusterY + Math.sin(localAngle) * localRadius).toFixed(2))
    node.color = colorForNode(node, communityIndex)
    node.labelVisibility = visibilityForRank(rank, score)
    node.searchText = `${node.label || ''} ${node.id || ''}`.trim().toLowerCase()
  })

  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const maxWeight = Math.max(1, ...links.map((link) => Number(link.weight || 0)))
  links.forEach((link) => {
    const source = nodeMap.get(String(link.source))
    const target = nodeMap.get(String(link.target))
    const normalized = Number(link.weight || 0) / maxWeight
    if (!source || !target) {
      link.visibility = 'hidden'
    } else if (normalized >= 0.22 || link.replyInteractionCount > 0 || source.rank <= 40 || target.rank <= 40) {
      link.visibility = 'primary'
    } else if (normalized >= 0.045 || source.rank <= 180 || target.rank <= 180) {
      link.visibility = 'secondary'
    } else {
      link.visibility = 'hidden'
    }
  })

  return {
    ...graph,
    nodes,
    links,
  }
}

export function cropEdgeToNodeBounds(source: RelationshipGraphNode, target: RelationshipGraphNode): { sx: number; sy: number; tx: number; ty: number } {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const distance = Math.max(0.001, Math.hypot(dx, dy))
  const ux = dx / distance
  const uy = dy / distance
  const sourceRadius = Math.max(3, source.size * 0.54)
  const targetRadius = Math.max(3, target.size * 0.54)
  return {
    sx: source.x + ux * sourceRadius,
    sy: source.y + uy * sourceRadius,
    tx: target.x - ux * targetRadius,
    ty: target.y - uy * targetRadius,
  }
}

export function sortLinksForRendering(links: RelationshipGraphLink[]): RelationshipGraphLink[] {
  return [...links].sort((a, b) => {
    const visibilityWeight = (value: string) => value === 'primary' ? 2 : value === 'secondary' ? 1 : 0
    return visibilityWeight(a.visibility) - visibilityWeight(b.visibility)
      || Number(a.weight || 0) - Number(b.weight || 0)
  })
}
