import { memoryDatabase } from '../memory/memoryDatabase'
import type { MemoryKeywordSearchHit } from '../memory/memoryDatabase'
import { evidenceService } from '../memory/evidenceService'
import type { MemoryItem } from '../memory/memorySchema'
import { chatSearchIndexService } from '../search/chatSearchIndexService'
import { localRerankerService, type RerankDocument } from './rerankerService'
import { reciprocalRankFusion } from './rrf'
import type {
  RetrievalCandidate,
  RetrievalEngineOptions,
  RetrievalEngineResult,
  RetrievalHit,
  RetrievalRerankStats,
  RetrievalSourceName,
  RetrievalSourceStats
} from './retrievalTypes'

type SourceHit = {
  source: RetrievalSourceName
  memory: MemoryItem
  rank: number
  score: number
}

const DEFAULT_LIMIT = 20
const DEFAULT_KEYWORD_LIMIT = 80
const DEFAULT_ANN_LIMIT = 80
const DEFAULT_RERANK_LIMIT = 120
const DEFAULT_RRF_K = 60

function compactText(value: string, limit: number): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function uniqueQueries(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const query = String(value || '').replace(/\s+/g, ' ').trim()
    const key = query.toLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    result.push(query)
  }
  return result
}

function memoryKey(memory: MemoryItem): string {
  return String(memory.id)
}

function messageMemoryUid(sessionId: string, message: { localId: number; createTime: number; sortSeq: number }): string {
  return `message:${sessionId}:${Number(message.localId || 0)}:${Number(message.createTime || 0)}:${Number(message.sortSeq || 0)}`
}

function buildRerankDocument(candidate: RetrievalCandidate): RerankDocument {
  const memory = candidate.memory
  const sourceRefs = memory.sourceRefs
    .slice(0, 3)
    .map((ref) => `${ref.senderUsername || 'unknown'} ${ref.createTime}: ${ref.excerpt || ''}`)
    .filter(Boolean)
    .join('\n')
  const text = [
    `type: ${memory.sourceType}`,
    memory.title ? `title: ${memory.title}` : '',
    memory.timeStart || memory.timeEnd ? `time: ${memory.timeStart || ''}-${memory.timeEnd || ''}` : '',
    `content: ${memory.content}`,
    sourceRefs ? `evidence:\n${sourceRefs}` : ''
  ].filter(Boolean).join('\n')

  return {
    id: candidate.key,
    text: compactText(text, 4000),
    originalScore: candidate.rrfScore,
    metadata: {
      memoryId: memory.id,
      sourceType: memory.sourceType,
      sources: candidate.sources
    }
  }
}

function toCandidate(hit: SourceHit): RetrievalCandidate {
  return {
    key: memoryKey(hit.memory),
    memory: hit.memory,
    sources: [hit.source],
    sourceRanks: { [hit.source]: hit.rank },
    sourceScores: { [hit.source]: hit.score },
    rrfScore: 0
  }
}

function mergeSourceDetails(candidate: RetrievalCandidate, hits: SourceHit[]): RetrievalCandidate {
  const sources: RetrievalSourceName[] = []
  const sourceRanks: RetrievalCandidate['sourceRanks'] = {}
  const sourceScores: RetrievalCandidate['sourceScores'] = {}

  for (const hit of hits) {
    if (!sources.includes(hit.source)) sources.push(hit.source)
    sourceRanks[hit.source] = Math.min(sourceRanks[hit.source] || Number.MAX_SAFE_INTEGER, hit.rank)
    sourceScores[hit.source] = Math.max(sourceScores[hit.source] || 0, hit.score)
  }

  return {
    ...candidate,
    sources,
    sourceRanks,
    sourceScores
  }
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const numberValue = Math.floor(Number(value || fallback))
  return Math.max(1, Math.min(Number.isFinite(numberValue) ? numberValue : fallback, max))
}

export class RetrievalEngine {
  async search(options: RetrievalEngineOptions): Promise<RetrievalEngineResult> {
    const startedAt = Date.now()
    const query = String(options.query || '').trim()
    if (!query) {
      return {
        query,
        semanticQuery: '',
        hits: [],
        sourceStats: [],
        rerank: { attempted: false, applied: false, skippedReason: 'empty_query' },
        latencyMs: Date.now() - startedAt
      }
    }

    const limit = normalizeLimit(options.limit, DEFAULT_LIMIT, 100)
    const keywordLimit = normalizeLimit(options.keywordLimit, DEFAULT_KEYWORD_LIMIT, 500)
    const annLimit = normalizeLimit(options.annLimit, DEFAULT_ANN_LIMIT, 500)
    const rerankLimit = normalizeLimit(options.rerankLimit, DEFAULT_RERANK_LIMIT, 500)
    const keywordQueries = uniqueQueries([query, ...(options.keywordQueries || [])])
    const semanticQueries = uniqueQueries([
      options.semanticQuery || query,
      ...(options.semanticQueries || [])
    ])
    const semanticQuery = semanticQueries[0] || query
    const sourceStats: RetrievalSourceStats[] = []

    const keywordHits = this.collectKeywordHits(options, keywordQueries, keywordLimit, sourceStats)
    const annHits = await this.collectAnnHits(options, semanticQueries, annLimit, sourceStats)
    const candidates = this.fuseCandidates([...keywordHits, ...annHits], options.rrfK)
    const rerankStats: RetrievalRerankStats = { attempted: false, applied: false }
    const ranked = await this.applyRerank(query, semanticQuery, candidates, rerankLimit, rerankStats, options.rerank !== false)
    const selected = ranked.slice(0, limit)
    const hits = await this.expandHits(selected, options.expandEvidence !== false)

    return {
      query,
      semanticQuery,
      hits,
      sourceStats,
      rerank: rerankStats,
      latencyMs: Date.now() - startedAt
    }
  }

  private collectKeywordHits(
    options: RetrievalEngineOptions,
    queries: string[],
    limit: number,
    sourceStats: RetrievalSourceStats[]
  ): SourceHit[] {
    const hits: SourceHit[] = []
    let error: string | undefined

    for (const query of queries) {
      try {
        const rows = memoryDatabase.searchMemoryItemsByKeyword({
          query,
          sessionId: options.sessionId,
          sourceTypes: options.sourceTypes,
          startTimeMs: options.startTimeMs,
          endTimeMs: options.endTimeMs,
          limit
        })
        hits.push(...rows.map((row) => this.keywordRowToSourceHit(row)))
      } catch (searchError) {
        error = String(searchError)
      }
    }

    const ftsCount = hits.filter((hit) => hit.source === 'memory_fts').length
    const likeCount = hits.filter((hit) => hit.source === 'memory_like').length
    sourceStats.push({ name: 'memory_fts', attempted: true, hitCount: ftsCount, ...(error ? { error } : {}) })
    sourceStats.push({ name: 'memory_like', attempted: true, hitCount: likeCount, ...(error ? { error } : {}) })
    return this.dedupeSourceHits(hits)
  }

  private keywordRowToSourceHit(row: MemoryKeywordSearchHit): SourceHit {
    return {
      source: row.retrievalSource,
      memory: row.item,
      rank: row.rank,
      score: row.score
    }
  }

  private async collectAnnHits(
    options: RetrievalEngineOptions,
    queries: string[],
    limit: number,
    sourceStats: RetrievalSourceStats[]
  ): Promise<SourceHit[]> {
    if (!options.sessionId) {
      sourceStats.push({ name: 'message_ann', attempted: false, hitCount: 0, skippedReason: 'session_required' })
      return []
    }

    const vectorState = chatSearchIndexService.getSessionVectorIndexState(options.sessionId)
    if (!vectorState.vectorProviderAvailable) {
      sourceStats.push({ name: 'message_ann', attempted: false, hitCount: 0, skippedReason: 'vector_provider_unavailable' })
      return []
    }
    if (!vectorState.isVectorComplete) {
      sourceStats.push({ name: 'message_ann', attempted: false, hitCount: 0, skippedReason: 'vector_index_incomplete' })
      return []
    }

    const hits: SourceHit[] = []
    let error: string | undefined
    for (const query of queries) {
      try {
        const result = await chatSearchIndexService.searchSessionByVector({
          sessionId: options.sessionId,
          query,
          limit,
          startTimeMs: options.startTimeMs,
          endTimeMs: options.endTimeMs,
          direction: options.direction,
          senderUsername: options.senderUsername
        })
        result.hits.forEach((hit, index) => {
          const uid = messageMemoryUid(hit.sessionId, hit.message)
          const memory = memoryDatabase.getMemoryItemByUid(uid)
          if (!memory) return
          hits.push({
            source: 'message_ann',
            memory,
            rank: index + 1,
            score: hit.score
          })
        })
      } catch (searchError) {
        error = String(searchError)
      }
    }

    sourceStats.push({
      name: 'message_ann',
      attempted: true,
      hitCount: hits.length,
      ...(error ? { error } : {})
    })
    return this.dedupeSourceHits(hits)
  }

  private dedupeSourceHits(hits: SourceHit[]): SourceHit[] {
    const byKey = new Map<string, SourceHit>()
    for (const hit of hits) {
      const key = `${hit.source}:${memoryKey(hit.memory)}`
      const existing = byKey.get(key)
      if (!existing || hit.rank < existing.rank || hit.score > existing.score) {
        byKey.set(key, hit)
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.rank - b.rank || b.score - a.score)
  }

  private fuseCandidates(sourceHits: SourceHit[], rrfK?: number): RetrievalCandidate[] {
    const hitsByMemory = new Map<string, SourceHit[]>()
    const listsBySource = new Map<RetrievalSourceName, SourceHit[]>()

    for (const hit of sourceHits) {
      const key = memoryKey(hit.memory)
      const grouped = hitsByMemory.get(key) || []
      grouped.push(hit)
      hitsByMemory.set(key, grouped)

      const list = listsBySource.get(hit.source) || []
      list.push(hit)
      listsBySource.set(hit.source, list)
    }

    const fused = reciprocalRankFusion(
      Array.from(listsBySource.values()).map((list) => list
        .sort((a, b) => a.rank - b.rank || b.score - a.score)
        .map((hit, index) => ({ item: hit, rank: hit.rank || index + 1, score: hit.score }))),
      (hit) => memoryKey(hit.memory),
      rrfK || DEFAULT_RRF_K
    )

    return fused.map((item) => {
      const candidate = toCandidate(item.item)
      candidate.rrfScore = Number(item.rrfScore.toFixed(8))
      return mergeSourceDetails(candidate, hitsByMemory.get(item.key) || [item.item])
    })
  }

  private async applyRerank(
    query: string,
    semanticQuery: string,
    candidates: RetrievalCandidate[],
    limit: number,
    stats: RetrievalRerankStats,
    enabled: boolean
  ): Promise<RetrievalCandidate[]> {
    if (!enabled) {
      stats.skippedReason = 'disabled'
      return candidates
    }
    if (candidates.length === 0) {
      stats.skippedReason = 'no_candidates'
      return candidates
    }
    if (!localRerankerService.isEnabled()) {
      stats.skippedReason = 'config_disabled'
      return candidates
    }

    stats.attempted = true
    const rerankInput = candidates.slice(0, limit)
    try {
      const reranked = await localRerankerService.rerank(
        [query, semanticQuery].filter(Boolean).join('\n'),
        rerankInput.map(buildRerankDocument),
        { limit }
      )
      const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
      const rerankedKeys = new Set<string>()
      const rankedCandidates = reranked
        .map((result) => {
          const candidate = byKey.get(result.id)
          if (!candidate) return null
          rerankedKeys.add(result.id)
          return {
            ...candidate,
            rrfScore: candidate.rrfScore,
            rerankScore: result.rerankScore,
            finalScore: result.combinedScore
          }
        })
        .filter((item): item is RetrievalCandidate & { rerankScore: number; finalScore: number } => Boolean(item))
        .sort((a, b) => b.finalScore - a.finalScore)

      stats.applied = rankedCandidates.length > 0
      const rest = candidates.filter((candidate) => !rerankedKeys.has(candidate.key))
      return [...rankedCandidates, ...rest]
    } catch (error) {
      stats.error = String(error)
      stats.skippedReason = 'rerank_failed'
      return candidates
    }
  }

  private async expandHits(candidates: RetrievalCandidate[], expandEvidence: boolean): Promise<RetrievalHit[]> {
    const hits: RetrievalHit[] = []
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index] as RetrievalCandidate & { rerankScore?: number; finalScore?: number }
      const evidence = expandEvidence ? await evidenceService.expandMemoryEvidence(candidate.memory) : []
      hits.push({
        ...candidate,
        rank: index + 1,
        score: Number((candidate.finalScore ?? candidate.rerankScore ?? candidate.rrfScore).toFixed(8)),
        ...(candidate.rerankScore != null ? { rerankScore: candidate.rerankScore } : {}),
        evidence
      })
    }
    return hits
  }
}

export const retrievalEngine = new RetrievalEngine()
