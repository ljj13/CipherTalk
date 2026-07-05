import { EventEmitter } from 'events'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { chatService } from './chatService'
import { ConfigService } from './config'
import { getUserDataPath } from './runtimePaths'
import { relationshipGraphProcessService } from './relationshipGraph/relationshipGraphProcessService'
import { DEFAULT_GRAPH_SCOPE, RELATIONSHIP_GRAPH_ALGORITHM_VERSION } from './relationshipGraph/constants'
import { buildCurrentRelationshipGraphSignature } from './relationshipGraph/dataSignature'
import { resolveRelationshipTimeRange } from './relationshipGraph/timeRange'
import {
  getRelationshipGraphSnapshotPath,
  readRelationshipGraphSnapshot,
  writeRelationshipGraphSnapshot,
} from './relationshipGraph/snapshot'
import type { RelationshipGraphSnapshot } from './relationshipGraph/types'
import type {
  RelationshipGraphBuildProgress,
  RelationshipGraphCommunity,
  RelationshipGraphData,
  RelationshipGraphLink,
  RelationshipGraphNode,
  RelationshipGraphOptions,
  RelationshipGraphPathResult,
  RelationshipGraphResult,
  RelationshipGraphSearchResults,
  RelationshipGraphStats,
  RelationshipGraphTaskInfo,
} from '../../src/types/models'

type PreparedRequest = {
  options: RelationshipGraphOptions
  timeRange: NonNullable<RelationshipGraphResult['timeRange']>
  signature: string
  algorithmVersion: string
  snapshotPath: string
}

const EMPTY_GRAPH: RelationshipGraphData = {
  nodes: [],
  links: [],
  communities: [],
  rankings: {
    central: [],
    isolated: [],
    active: [],
  },
  similar: {},
  stats: {
    nodeCount: 0,
    linkCount: 0,
    directChatCount: 0,
    sameGroupCount: 0,
    groupInteractionCount: 0,
    isolatedCount: 0,
    communityCount: 0,
    builtAt: 0,
    stale: true,
  },
}

function normalizeSeconds(value?: number): number | undefined {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function endpointId(value: string | RelationshipGraphNode): string {
  return typeof value === 'string' ? value : value.id
}

function cloneGraph(graph: RelationshipGraphData): RelationshipGraphData {
  return {
    ...graph,
    nodes: (graph.nodes || []).map((node) => ({ ...node })),
    links: (graph.links || []).map((link) => ({
      ...link,
      source: endpointId(link.source as string | RelationshipGraphNode),
      target: endpointId(link.target as string | RelationshipGraphNode),
      sourceSessionIds: [...(link.sourceSessionIds || [])],
      evidenceSessionIds: [...(link.evidenceSessionIds || [])],
    })),
    communities: graph.communities?.map((item) => ({ ...item })) || [],
    rankings: graph.rankings ? {
      central: graph.rankings.central.map((node) => ({ ...node })),
      isolated: graph.rankings.isolated.map((node) => ({ ...node })),
      active: graph.rankings.active.map((node) => ({ ...node })),
    } : { central: [], isolated: [], active: [] },
    similar: Object.fromEntries(Object.entries(graph.similar || {}).map(([key, value]) => [key, value.map((node) => ({ ...node }))])),
    stats: graph.stats ? { ...graph.stats } : undefined,
  }
}

function buildCommunities(nodes: RelationshipGraphNode[]): RelationshipGraphCommunity[] {
  const map = new Map<string, RelationshipGraphCommunity>()
  for (const node of nodes) {
    const id = node.communityId || 'c0'
    const item = map.get(id) || { id, label: id === 'isolated' ? '孤岛' : `社群 ${id.replace(/^c/, '')}`, size: 0, weight: 0 }
    item.size += 1
    item.weight = Number((item.weight + Number(node.weightedDegree || 0)).toFixed(3))
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

function recomputeNodeMetrics(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
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
  }
}

function filterGraph(graph: RelationshipGraphData, options: RelationshipGraphOptions): { graph: RelationshipGraphData; searchResults?: RelationshipGraphSearchResults } {
  const scoped = cloneGraph(graph)
  const minWeight = Math.max(0, Number(options.minWeight || 0))
  const relationTypes = options.relationTypes?.length ? new Set(options.relationTypes) : null
  const startTime = normalizeSeconds(options.startTime)
  const endTime = normalizeSeconds(options.endTime)
  const scope = options.graphScope || DEFAULT_GRAPH_SCOPE
  const query = String(options.query || '').trim().toLowerCase()

  let links = scoped.links.filter((link) => {
    if (relationTypes && !relationTypes.has(link.type)) return false
    if (Number(link.weight || 0) < minWeight) return false
    const last = normalizeSeconds(link.lastInteractionTs || link.lastActiveTime)
    if (startTime && (!last || last < startTime)) return false
    if (endTime && (!last || last > endTime)) return false
    return link.visibility !== 'hidden'
  })

  const nodeMap = new Map(scoped.nodes.map((node) => [node.id, node]))
  let allowedNodeIds = new Set(scoped.nodes.map((node) => node.id))
  if (scope === 'friends') {
    allowedNodeIds = new Set(scoped.nodes.filter((node) => node.kind === 'self' || node.kind === 'friend').map((node) => node.id))
    links = links.filter((link) => allowedNodeIds.has(String(link.source)) && allowedNodeIds.has(String(link.target)))
  } else if (scope === 'close') {
    const top = scoped.nodes
      .filter((node) => node.degree > 0)
      .sort((a, b) => b.score - a.score || b.weightedDegree - a.weightedDegree)
      .slice(0, 220)
    allowedNodeIds = new Set(top.map((node) => node.id))
    for (const link of links) {
      if (allowedNodeIds.has(String(link.source))) allowedNodeIds.add(String(link.target))
      if (allowedNodeIds.has(String(link.target))) allowedNodeIds.add(String(link.source))
    }
    links = links.filter((link) => allowedNodeIds.has(String(link.source)) && allowedNodeIds.has(String(link.target)))
  }

  const connectedIds = new Set<string>()
  for (const link of links) {
    connectedIds.add(String(link.source))
    connectedIds.add(String(link.target))
  }

  let nodes = scoped.nodes.filter((node) => allowedNodeIds.has(node.id) && (options.includeIsolated === true || connectedIds.has(node.id)))
  let searchResults: RelationshipGraphSearchResults | undefined
  if (query) {
    const matching = new Set(nodes
      .filter((node) => (node.searchText || `${node.label} ${node.id}`.toLowerCase()).includes(query))
      .map((node) => node.id))
    const expanded = new Set(matching)
    for (const link of links) {
      if (matching.has(String(link.source))) expanded.add(String(link.target))
      if (matching.has(String(link.target))) expanded.add(String(link.source))
    }
    nodes = nodes.filter((node) => expanded.has(node.id))
    links = links.filter((link) => expanded.has(String(link.source)) && expanded.has(String(link.target)))
    searchResults = {
      query,
      nodeIds: Array.from(matching),
      linkIds: links.map((link) => link.id),
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id))
  links = links.filter((link) => nodeIds.has(String(link.source)) && nodeIds.has(String(link.target)))
  recomputeNodeMetrics(nodes, links)
  const communities = buildCommunities(nodes)
  const filtered: RelationshipGraphData = {
    nodes,
    links,
    communities,
    rankings: buildRankings(nodes),
    similar: scoped.similar || {},
    stats: buildStats({ nodes, links, communities }, scoped.stats?.builtAt || Date.now(), Boolean(scoped.stats?.stale)),
  }

  return { graph: filtered, searchResults }
}

class RelationshipGraphService extends EventEmitter {
  private configService = new ConfigService()
  private stale = true
  private activeTask: RelationshipGraphTaskInfo | null = null
  private activeSignature = ''
  private taskSeq = 0

  constructor() {
    super()
    chatService.on('dbChange', () => {
      this.stale = true
    })
  }

  markStale(): void {
    this.stale = true
  }

  async getGraph(options: RelationshipGraphOptions = {}): Promise<RelationshipGraphResult> {
    return this.getGraphInternal({ acceptStale: true, ...options })
  }

  async rebuild(options: RelationshipGraphOptions = {}): Promise<RelationshipGraphResult> {
    return this.getGraphInternal({ acceptStale: true, ...options, forceRecompute: true })
  }

  async getNeighborhood(nodeId: string, options: RelationshipGraphOptions = {}): Promise<RelationshipGraphResult> {
    const result = await this.getGraph({ ...options, includeIsolated: false })
    if (!result.success || !result.graph) return result
    const sourceId = String(nodeId || '')
    const linkIds = new Set<string>()
    const nodeIds = new Set([sourceId])
    for (const link of result.graph.links) {
      const source = String(link.source)
      const target = String(link.target)
      if (source !== sourceId && target !== sourceId) continue
      nodeIds.add(source)
      nodeIds.add(target)
      linkIds.add(link.id)
    }
    const graph = cloneGraph(result.graph)
    graph.nodes = graph.nodes.filter((node) => nodeIds.has(node.id))
    graph.links = graph.links.filter((link) => linkIds.has(link.id))
    graph.communities = buildCommunities(graph.nodes)
    graph.rankings = buildRankings(graph.nodes)
    graph.stats = buildStats(graph, graph.stats?.builtAt || Date.now(), Boolean(result.cache?.stale))
    return {
      ...result,
      graph,
      nodes: graph.nodes,
      links: graph.links,
      communities: graph.communities,
      rankings: graph.rankings,
      stats: graph.stats,
      searchResults: {
        query: sourceId,
        nodeIds: Array.from(nodeIds),
        linkIds: Array.from(linkIds),
      },
    }
  }

  async getPath(sourceId: string, targetId: string, options: RelationshipGraphOptions = {}): Promise<RelationshipGraphPathResult> {
    const result = await this.getGraph({ ...options, includeIsolated: false })
    const graph = result.graph
    if (!result.success || !graph) {
      return { success: false, error: result.error || '图谱不可用' }
    }
    const nodeIds = new Set(graph.nodes.map((node) => node.id))
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) {
      return { success: false, error: '联系人不在当前图谱筛选结果中' }
    }
    if (sourceId === targetId) return { success: true, nodeIds: [sourceId], links: [] }

    const adjacency = new Map<string, Array<{ next: string; link: RelationshipGraphLink }>>()
    for (const link of graph.links) {
      const source = String(link.source)
      const target = String(link.target)
      if (!adjacency.has(source)) adjacency.set(source, [])
      if (!adjacency.has(target)) adjacency.set(target, [])
      adjacency.get(source)!.push({ next: target, link })
      adjacency.get(target)!.push({ next: source, link })
    }

    const queue = [sourceId]
    const visited = new Set([sourceId])
    const prev = new Map<string, { node: string; link: RelationshipGraphLink }>()
    while (queue.length > 0) {
      const current = queue.shift()!
      const neighbors = (adjacency.get(current) || [])
        .sort((a, b) => Number(b.link.weight || 0) - Number(a.link.weight || 0))
      for (const item of neighbors) {
        if (visited.has(item.next)) continue
        visited.add(item.next)
        prev.set(item.next, { node: current, link: item.link })
        if (item.next === targetId) {
          const pathNodes = [targetId]
          const pathLinks: RelationshipGraphLink[] = []
          let cursor = targetId
          while (cursor !== sourceId) {
            const p = prev.get(cursor)
            if (!p) break
            pathLinks.unshift(p.link)
            pathNodes.unshift(p.node)
            cursor = p.node
          }
          return { success: true, nodeIds: pathNodes, links: pathLinks }
        }
        queue.push(item.next)
      }
    }
    return { success: false, error: '没有找到关系路径' }
  }

  private async getGraphInternal(options: RelationshipGraphOptions): Promise<RelationshipGraphResult> {
    try {
      const prepared = await this.prepareRequest(options)
      const snapshot = readRelationshipGraphSnapshot(prepared.snapshotPath)
      const cacheFresh = Boolean(snapshot && snapshot.signature === prepared.signature && !options.forceRecompute)
      const cacheStale = Boolean(snapshot && !cacheFresh)
      if (cacheFresh) this.stale = false

      if (!cacheFresh) this.startBackgroundRecompute(prepared)

      if (snapshot && (cacheFresh || options.acceptStale !== false)) {
        return this.wrapSnapshot(snapshot, prepared, {
          hit: true,
          stale: cacheStale,
          reason: cacheFresh ? undefined : 'stale',
        })
      }

      return {
        success: true,
        graph: cloneGraph(EMPTY_GRAPH),
        nodes: [],
        links: [],
        communities: [],
        rankings: EMPTY_GRAPH.rankings,
        similar: {},
        stats: { ...EMPTY_GRAPH.stats!, stale: true },
        cache: {
          hit: false,
          stale: true,
          snapshotPath: prepared.snapshotPath,
          reason: snapshot ? 'stale' : 'missing',
          signature: prepared.signature,
        },
        task: this.activeTask || undefined,
        timeRange: prepared.timeRange,
        algorithmVersion: prepared.algorithmVersion,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), algorithmVersion: RELATIONSHIP_GRAPH_ALGORITHM_VERSION }
    }
  }

  private async prepareRequest(options: RelationshipGraphOptions): Promise<PreparedRequest> {
    const timeRange = resolveRelationshipTimeRange(options)
    const signatureInfo = await buildCurrentRelationshipGraphSignature(options, timeRange)
    return {
      options,
      timeRange,
      signature: signatureInfo.signature,
      algorithmVersion: signatureInfo.algorithmVersion,
      snapshotPath: getRelationshipGraphSnapshotPath(this.getCacheBaseDir(), timeRange.preset, options.graphScope || DEFAULT_GRAPH_SCOPE),
    }
  }

  private wrapSnapshot(
    snapshot: RelationshipGraphSnapshot,
    prepared: PreparedRequest,
    cache: { hit: boolean; stale: boolean; reason?: string },
  ): RelationshipGraphResult {
    const sourceGraph = cloneGraph(snapshot.graph)
    sourceGraph.stats = buildStats(sourceGraph, snapshot.builtAt, cache.stale)
    const { graph, searchResults } = filterGraph(sourceGraph, prepared.options)
    graph.stats = buildStats(graph, snapshot.builtAt, cache.stale)

    return {
      success: true,
      graph,
      searchResults,
      diagnostics: snapshot.diagnostics,
      cache: {
        hit: cache.hit,
        stale: cache.stale,
        snapshotPath: prepared.snapshotPath,
        builtAt: snapshot.builtAt,
        ageMs: Date.now() - snapshot.builtAt,
        signature: snapshot.signature,
        reason: cache.reason,
        factsHit: snapshot.diagnostics?.factsCacheHit,
      },
      task: cache.stale ? this.activeTask || undefined : undefined,
      timeRange: snapshot.timeRange,
      algorithmVersion: snapshot.algorithmVersion,
      nodes: graph.nodes,
      links: graph.links,
      communities: graph.communities,
      rankings: graph.rankings,
      similar: graph.similar,
      stats: graph.stats,
    }
  }

  private startBackgroundRecompute(prepared: PreparedRequest): void {
    if (this.activeTask?.status === 'running' && this.activeSignature === prepared.signature) return

    const taskId = `relationship-graph-${Date.now()}-${++this.taskSeq}`
    this.activeSignature = prepared.signature
    this.activeTask = {
      id: taskId,
      status: 'running',
      stage: 'queued',
      message: '关系网络重算已排队',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.emitProgress({
      taskId,
      stage: 'queued',
      status: 'running',
      message: '关系网络重算已排队',
    })

    void relationshipGraphProcessService.build({
      taskId,
      options: prepared.options,
      expectedSignature: prepared.signature,
      cacheBaseDir: this.getCacheBaseDir(),
    }, (progress) => {
      this.activeTask = {
        ...(this.activeTask || { id: taskId }),
        id: taskId,
        status: 'running',
        stage: progress.stage,
        message: progress.message,
        current: progress.current,
        total: progress.total,
        updatedAt: Date.now(),
      }
      this.emitProgress(progress)
    }).then(({ snapshot, task }) => {
      if (this.activeSignature !== prepared.signature || snapshot.signature !== prepared.signature) {
        return
      }
      writeRelationshipGraphSnapshot(prepared.snapshotPath, snapshot)
      this.stale = false
      this.activeTask = {
        ...task,
        id: taskId,
        status: 'completed',
        stage: 'done',
        message: '关系网络构建完成',
        updatedAt: Date.now(),
        finishedAt: Date.now(),
      }
      this.emitProgress({
        taskId,
        stage: 'done',
        status: 'completed',
        message: '关系网络构建完成',
        current: snapshot.graph.nodes.length,
        total: snapshot.graph.nodes.length,
      })
    }).catch((error) => {
      if (this.activeSignature !== prepared.signature) return
      this.activeTask = {
        id: taskId,
        status: 'failed',
        stage: 'error',
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
        finishedAt: Date.now(),
      }
      this.emitProgress({
        taskId,
        stage: 'error',
        status: 'failed',
        message: this.activeTask.error || '关系网络构建失败',
      })
    })
  }

  private emitProgress(progress: RelationshipGraphBuildProgress): void {
    this.emit('progress', progress)
  }

  private getCacheBaseDir(): string {
    const configured = String(this.configService.get('cachePath') || '').trim()
    const dir = configured || join(getUserDataPath(), 'cache')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }
}

export const relationshipGraphService = new RelationshipGraphService()
