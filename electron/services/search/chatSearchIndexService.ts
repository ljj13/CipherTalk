import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { chatService, type Message } from '../chatService'
import { ConfigService } from '../config'

export type ChatSearchIndexProgressStage =
  | 'preparing_index'
  | 'indexing_messages'
  | 'searching_index'
  | 'completed'

export interface ChatSearchIndexProgress {
  stage: ChatSearchIndexProgressStage
  message: string
  sessionId: string
  messagesScanned?: number
  indexedCount?: number
}

export interface ChatSearchIndexState {
  sessionId: string
  indexedCount: number
  newestSortSeq: number
  newestCreateTime: number
  newestLocalId: number
  updatedAt: number
  isComplete: boolean
}

export interface ChatSearchIndexHit {
  sessionId: string
  message: Message
  excerpt: string
  matchedField: 'text' | 'raw'
  score: number
}

export interface ChatSearchSessionOptions {
  sessionId: string
  query: string
  limit: number
  matchMode?: 'substring' | 'exact'
  startTimeMs?: number
  endTimeMs?: number
  direction?: 'in' | 'out'
  senderUsername?: string
  onProgress?: (progress: ChatSearchIndexProgress) => void | Promise<void>
}

export interface ChatSearchSessionResult {
  hits: ChatSearchIndexHit[]
  indexedCount: number
  truncated: boolean
}

export type ChatVectorIndexProgressStage =
  | 'preparing'
  | 'indexing_messages'
  | 'vectorizing_messages'
  | 'completed'

export type ChatVectorIndexProgressStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ChatVectorIndexProgress {
  sessionId: string
  stage: ChatVectorIndexProgressStage
  status: ChatVectorIndexProgressStatus
  processedCount: number
  totalCount: number
  message: string
  vectorModel: string
}

export interface ChatVectorIndexState {
  sessionId: string
  indexedCount: number
  vectorizedCount: number
  pendingCount: number
  isVectorComplete: boolean
  isVectorRunning: boolean
  vectorModel: string
}

export interface ChatVectorSearchSessionResult {
  hits: ChatSearchIndexHit[]
  indexedCount: number
  vectorizedCount: number
  truncated: boolean
  model: string
}

type MessageIndexRow = {
  id: number
  session_id: string
  local_id: number
  server_id: number
  local_type: number
  create_time: number
  sort_seq: number
  is_send: number | null
  sender_username: string | null
  parsed_content: string
  raw_content: string
  search_text: string
  token_text: string
  message_json: string
}

type MessageVectorRow = MessageIndexRow & {
  vector_json: string
}

type SparseVector = Array<[number, number]>

interface LocalVectorProvider {
  id: string
  buildVector(text: string): SparseVector
  parseVector(value: string): SparseVector
  toWeightMap(vector: SparseVector): Map<number, number>
  dot(queryWeights: Map<number, number>, vector: SparseVector): number
}

type SessionVectorStateRow = {
  session_id: string
  vector_model: string
  confirmed_at: number | null
  completed_at: number | null
  updated_at: number
  is_complete: number
  last_error: string | null
}

type VectorTask = {
  promise: Promise<ChatVectorIndexState>
  cancelRequested: boolean
}

const INDEX_DB_NAME = 'chat_search_index.db'
const INDEX_SCHEMA_VERSION = '1'
const INDEX_BATCH_SIZE = 800
const MAX_INDEX_TEXT_CHARS = 8000
const MAX_EXCERPT_RADIUS = 48
const MAX_INDEX_SEARCH_CANDIDATES = 240
const VECTOR_MODEL_ID = 'local-chargram-hash-v1'
const VECTOR_DIMENSIONS = 2048
const VECTOR_BATCH_SIZE = 800
const MAX_VECTOR_TEXT_CHARS = 2400
const MAX_VECTOR_SCAN_ROWS = 120000
const VECTOR_MIN_SCORE = 0.055
// Vector hits are recall supplements, so keep them below high-confidence keyword hits.
const VECTOR_SCORE_BASE = 560
const VECTOR_SCORE_SCALE = 420
const VECTOR_INDEX_CANCELLED_ERROR = 'VECTOR_INDEX_CANCELLED'
const VECTOR_STOP_PHRASES = [
  '有没有',
  '是不是',
  '是否',
  '什么',
  '哪个',
  '哪些',
  '什么时候',
  '为什么',
  '怎么',
  '如何',
  '帮我',
  '看看',
  '请问',
  '问一下',
  '聊天记录',
  '聊天',
  '消息',
  '记录',
  '内容',
  '这个',
  '那个',
  '我们',
  '他们',
  '对方',
  '最近',
  '说过',
  '提到',
  '关于',
  '一下'
]
const VECTOR_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'what',
  'when',
  'where',
  'which',
  'why',
  'how',
  'have',
  'has',
  '是否',
  '什么',
  '哪个',
  '哪些',
  '怎么',
  '如何',
  '我们',
  '他们',
  '对方',
  '消息',
  '聊天',
  '记录',
  '内容'
])

function cursorKey(message: Pick<Message, 'localId' | 'createTime' | 'sortSeq'>): string {
  return `${Number(message.localId || 0)}:${Number(message.createTime || 0)}:${Number(message.sortSeq || 0)}`
}

function compareCursorAsc(
  a: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>,
  b: Pick<Message, 'sortSeq' | 'createTime' | 'localId'>
): number {
  return Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
}

function compareIndexRowCursorAsc(
  a: Pick<MessageIndexRow, 'sort_seq' | 'create_time' | 'local_id'>,
  b: Pick<MessageIndexRow, 'sort_seq' | 'create_time' | 'local_id'>
): number {
  return Number(a.sort_seq || 0) - Number(b.sort_seq || 0)
    || Number(a.create_time || 0) - Number(b.create_time || 0)
    || Number(a.local_id || 0) - Number(b.local_id || 0)
}

function normalizeSearchText(value?: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactSearchText(value: string): string {
  const normalized = normalizeSearchText(value)
  return normalized.length > MAX_INDEX_TEXT_CHARS
    ? normalized.slice(0, MAX_INDEX_TEXT_CHARS)
    : normalized
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const normalized = normalizeSearchText(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

function extractMessageSearchText(message: Message): string {
  const chatRecordText = Array.isArray(message.chatRecordList)
    ? message.chatRecordList
      .flatMap((item) => [
        item.datadesc,
        item.datatitle,
        item.sourcename,
        item.fileext
      ])
      .filter(Boolean)
      .join(' ')
    : ''

  const mediaFallback = (() => {
    switch (Number(message.localType || 0)) {
      case 3:
        return '[图片]'
      case 34:
        return '[语音]'
      case 43:
        return '[视频]'
      case 47:
        return '[表情]'
      case 49:
        return '[文件]'
      default:
        return ''
    }
  })()

  return [
    message.parsedContent,
    message.quotedContent,
    message.fileName,
    chatRecordText,
    message.rawContent,
    mediaFallback
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(' ')
}

function buildSearchTokens(value: string): string {
  const normalized = normalizeSearchText(value)
  const tokens: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const segment = match[0]
    if (segment.length <= 3) {
      tokens.push(segment)
    }

    for (let size = 2; size <= 3; size += 1) {
      if (segment.length < size) continue
      for (let index = 0; index <= segment.length - size; index += 1) {
        tokens.push(segment.slice(index, index + size))
      }
    }
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    tokens.push(match[0])
  }

  return uniqueStrings(tokens).join(' ')
}

function normalizeVectorText(value: string): string {
  let normalized = normalizeSearchText(value).slice(0, MAX_VECTOR_TEXT_CHARS)

  for (const phrase of VECTOR_STOP_PHRASES) {
    normalized = normalized.replace(new RegExp(phrase, 'gi'), ' ')
  }

  return normalized.replace(/\s+/g, ' ').trim()
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function addVectorFeature(weights: Map<number, number>, feature: string, weight: number): void {
  if (!feature || VECTOR_STOP_WORDS.has(feature)) return

  const hash = hashString(feature)
  const dimension = hash % VECTOR_DIMENSIONS
  const signedWeight = (hash & 0x80000000) ? -weight : weight
  weights.set(dimension, (weights.get(dimension) || 0) + signedWeight)
}

function addChineseVectorFeatures(weights: Map<number, number>, segment: string): void {
  if (!segment || VECTOR_STOP_WORDS.has(segment)) return

  if (segment.length >= 2 && segment.length <= 12) {
    addVectorFeature(weights, `zh:${segment}`, 1.35)
  }

  for (let size = 2; size <= 4; size += 1) {
    if (segment.length < size) continue
    const weight = size === 2 ? 0.9 : size === 3 ? 1.1 : 0.85
    for (let index = 0; index <= segment.length - size; index += 1) {
      const gram = segment.slice(index, index + size)
      if (VECTOR_STOP_WORDS.has(gram)) continue
      addVectorFeature(weights, `c${size}:${gram}`, weight)
    }
  }
}

function buildLocalSearchVector(value: string): SparseVector {
  const normalized = normalizeVectorText(value)
  if (!normalized) return []

  const weights = new Map<number, number>()
  const latinWords: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    addChineseVectorFeatures(weights, match[0])
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    const word = match[0]
    if (VECTOR_STOP_WORDS.has(word)) continue
    latinWords.push(word)
    addVectorFeature(weights, `w:${word}`, 1.2)
  }

  for (let index = 0; index < latinWords.length - 1; index += 1) {
    addVectorFeature(weights, `wb:${latinWords[index]} ${latinWords[index + 1]}`, 1.35)
  }

  let norm = 0
  for (const weight of weights.values()) {
    norm += weight * weight
  }

  if (norm <= 0) return []

  const scale = Math.sqrt(norm)
  return Array.from(weights.entries())
    .map(([dimension, weight]) => [dimension, Number((weight / scale).toFixed(6))] as [number, number])
    .filter(([, weight]) => Math.abs(weight) > 0.000001)
    .sort((a, b) => a[0] - b[0])
}

function parseSparseVector(value: string): SparseVector {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []

    const vector: SparseVector = []
    for (const item of parsed) {
      if (!Array.isArray(item) || item.length < 2) continue
      const dimension = Number(item[0])
      const weight = Number(item[1])
      if (!Number.isInteger(dimension) || dimension < 0 || !Number.isFinite(weight)) continue
      vector.push([dimension, weight])
    }
    return vector
  } catch {
    return []
  }
}

function dotSparseVector(queryWeights: Map<number, number>, vector: SparseVector): number {
  let score = 0
  for (const [dimension, weight] of vector) {
    const queryWeight = queryWeights.get(dimension)
    if (queryWeight) score += queryWeight * weight
  }
  return score
}

function sparseVectorToMap(vector: SparseVector): Map<number, number> {
  return new Map(vector)
}

const localVectorProvider: LocalVectorProvider = {
  id: VECTOR_MODEL_ID,
  buildVector: buildLocalSearchVector,
  parseVector: parseSparseVector,
  toWeightMap: sparseVectorToMap,
  dot: dotSparseVector
}

function createVectorExcerpt(row: Pick<MessageIndexRow, 'parsed_content' | 'search_text'>, query: string): string {
  const text = String(row.parsed_content || row.search_text || '')
  if (!text) return ''

  const normalizedQuery = normalizeSearchText(query)
  const exactIndex = normalizedQuery ? normalizeSearchText(text).indexOf(normalizedQuery) : -1
  if (exactIndex >= 0) {
    return createExcerpt(text, Math.min(exactIndex, Math.max(0, text.length - 1)), Math.max(normalizedQuery.length, 1))
  }

  const token = buildQueryTokens(query)[0]
  if (token) {
    const tokenIndex = normalizeSearchText(text).indexOf(token)
    if (tokenIndex >= 0) {
      return createExcerpt(text, Math.min(tokenIndex, Math.max(0, text.length - 1)), token.length)
    }
  }

  return createExcerpt(text, 0, Math.min(text.length, 24))
}

function buildQueryTokens(query: string): string[] {
  const normalized = normalizeSearchText(query)
  const tokens: string[] = []

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const segment = match[0]
    if (segment.length <= 3) {
      tokens.push(segment)
    }

    const gramSize = segment.length <= 4 ? 2 : 3
    if (segment.length >= gramSize) {
      for (let index = 0; index <= segment.length - gramSize; index += 1) {
        tokens.push(segment.slice(index, index + gramSize))
      }
    }
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    tokens.push(match[0])
  }

  return uniqueStrings(tokens).slice(0, 12)
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

function buildFtsQuery(query: string): string {
  return buildQueryTokens(query).map(quoteFtsTerm).join(' ')
}

function createExcerpt(source: string, matchedIndex: number, queryLength: number): string {
  if (!source) return ''
  const safeIndex = Math.max(0, matchedIndex)
  const start = Math.max(0, safeIndex - MAX_EXCERPT_RADIUS)
  const end = Math.min(source.length, safeIndex + queryLength + MAX_EXCERPT_RADIUS)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < source.length ? '...' : ''
  return `${prefix}${source.slice(start, end)}${suffix}`
}

function findMatchInIndexedText(
  row: Pick<MessageIndexRow, 'parsed_content' | 'raw_content' | 'search_text' | 'token_text'>,
  query: string,
  matchMode: 'substring' | 'exact' = 'substring'
): { matchedField: 'text' | 'raw'; excerpt: string; score: number } {
  const exactQuery = String(query || '').trim()
  const normalizedQuery = normalizeSearchText(query)
  const compactQuery = normalizedQuery.replace(/\s+/g, '')
  const text = String(row.parsed_content || '')
  const raw = String(row.raw_content || '')
  const normalizedText = normalizeSearchText(text)
  const normalizedRaw = normalizeSearchText(raw)
  const normalizedSearchText = String(row.search_text || '')

  const matchIndex = matchMode === 'exact'
    ? text.indexOf(exactQuery)
    : normalizedText.indexOf(normalizedQuery)

  if (matchIndex >= 0) {
    return {
      matchedField: 'text',
      excerpt: createExcerpt(text || normalizedText, matchIndex, normalizedQuery.length),
      score: 1400 - Math.min(matchIndex, 500)
    }
  }

  const compactSearchIndex = compactQuery
    ? normalizedSearchText.replace(/\s+/g, '').indexOf(compactQuery)
    : -1
  if (compactSearchIndex >= 0) {
    return {
      matchedField: 'text',
      excerpt: createExcerpt(text || normalizedSearchText, Math.min(compactSearchIndex, Math.max(0, (text || normalizedSearchText).length - 1)), normalizedQuery.length),
      score: 1180 - Math.min(compactSearchIndex, 500)
    }
  }

  const rawIndex = matchMode === 'exact'
    ? raw.indexOf(exactQuery)
    : normalizedRaw.indexOf(normalizedQuery)
  if (rawIndex >= 0) {
    return {
      matchedField: 'raw',
      excerpt: createExcerpt(raw || normalizedRaw, rawIndex, normalizedQuery.length),
      score: 880 - Math.min(rawIndex, 500)
    }
  }

  const queryTokens = buildQueryTokens(query)
  const tokenText = String(row.token_text || '')
  const matchedTokens = queryTokens.filter((token) => tokenText.includes(token))
  const ratio = queryTokens.length > 0 ? matchedTokens.length / queryTokens.length : 0
  return {
    matchedField: 'text',
    excerpt: createExcerpt(text || normalizedSearchText, 0, Math.max(normalizedQuery.length, 1)),
    score: Number((720 + ratio * 260 + matchedTokens.length * 8).toFixed(2))
  }
}

function hasExactMessageMatch(row: Pick<MessageIndexRow, 'parsed_content' | 'raw_content'>, query: string): boolean {
  const exactQuery = String(query || '').trim()
  if (!exactQuery) return false
  return String(row.parsed_content || '').includes(exactQuery)
    || String(row.raw_content || '').includes(exactQuery)
}

function rowToMessage(row: MessageIndexRow): Message {
  try {
    const parsed = JSON.parse(row.message_json) as Message
    return {
      ...parsed,
      localId: Number(parsed.localId ?? row.local_id ?? 0),
      serverId: Number(parsed.serverId ?? row.server_id ?? 0),
      localType: Number(parsed.localType ?? row.local_type ?? 0),
      createTime: Number(parsed.createTime ?? row.create_time ?? 0),
      sortSeq: Number(parsed.sortSeq ?? row.sort_seq ?? 0),
      isSend: parsed.isSend ?? row.is_send ?? null,
      senderUsername: parsed.senderUsername ?? row.sender_username ?? null,
      parsedContent: String(parsed.parsedContent ?? row.parsed_content ?? ''),
      rawContent: String(parsed.rawContent ?? row.raw_content ?? '')
    }
  } catch {
    return {
      localId: Number(row.local_id || 0),
      serverId: Number(row.server_id || 0),
      localType: Number(row.local_type || 0),
      createTime: Number(row.create_time || 0),
      sortSeq: Number(row.sort_seq || 0),
      isSend: row.is_send ?? null,
      senderUsername: row.sender_username ?? null,
      parsedContent: String(row.parsed_content || ''),
      rawContent: String(row.raw_content || '')
    }
  }
}

function toTimestampSeconds(value?: number): number | undefined {
  if (!value || !Number.isFinite(value)) return undefined
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
}

export class ChatSearchIndexService {
  private db: Database.Database | null = null
  private dbPath: string | null = null
  private vectorTasks = new Map<string, VectorTask>()

  private getCacheBasePath(): string {
    const configService = new ConfigService()
    try {
      const cachePath = String(configService.get('cachePath') || '').trim()
      return cachePath || join(process.cwd(), 'cache')
    } finally {
      configService.close()
    }
  }

  private getDb(): Database.Database {
    const basePath = this.getCacheBasePath()
    if (!existsSync(basePath)) {
      mkdirSync(basePath, { recursive: true })
    }

    const nextDbPath = join(basePath, INDEX_DB_NAME)
    if (this.db && this.dbPath === nextDbPath) {
      return this.db
    }

    if (this.db) {
      try {
        this.db.close()
      } catch {
        // ignore
      }
    }

    const db = new Database(nextDbPath)
    this.db = db
    this.dbPath = nextDbPath
    this.ensureSchema(db)
    return db
  }

  private ensureSchema(db: Database.Database): void {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
    if (row?.value && row.value !== INDEX_SCHEMA_VERSION) {
      this.resetSchema(db)
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS message_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        local_id INTEGER NOT NULL,
        server_id INTEGER NOT NULL DEFAULT 0,
        local_type INTEGER NOT NULL DEFAULT 0,
        create_time INTEGER NOT NULL DEFAULT 0,
        sort_seq INTEGER NOT NULL DEFAULT 0,
        is_send INTEGER,
        sender_username TEXT,
        parsed_content TEXT NOT NULL DEFAULT '',
        raw_content TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        token_text TEXT NOT NULL DEFAULT '',
        message_json TEXT NOT NULL DEFAULT '{}',
        indexed_at INTEGER NOT NULL,
        UNIQUE(session_id, local_id, create_time, sort_seq)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS message_index_fts USING fts5(
        session_id UNINDEXED,
        cursor_key UNINDEXED,
        search_text,
        token_text,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS session_index_state (
        session_id TEXT PRIMARY KEY,
        newest_sort_seq INTEGER NOT NULL DEFAULT 0,
        newest_create_time INTEGER NOT NULL DEFAULT 0,
        newest_local_id INTEGER NOT NULL DEFAULT 0,
        indexed_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        is_complete INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS message_vector_index (
        message_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        vector_model TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        feature_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_vector_state (
        session_id TEXT NOT NULL,
        vector_model TEXT NOT NULL,
        confirmed_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        is_complete INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY(session_id, vector_model)
      );

      CREATE INDEX IF NOT EXISTS idx_message_index_session_time
        ON message_index(session_id, sort_seq DESC, create_time DESC, local_id DESC);
      CREATE INDEX IF NOT EXISTS idx_message_index_session_sender
        ON message_index(session_id, sender_username);
      CREATE INDEX IF NOT EXISTS idx_message_vector_session_model
        ON message_vector_index(session_id, vector_model);
      CREATE INDEX IF NOT EXISTS idx_session_vector_state_session
        ON session_vector_state(session_id);
    `)

    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', INDEX_SCHEMA_VERSION)
  }

  private resetSchema(db: Database.Database): void {
    db.exec(`
      DROP TABLE IF EXISTS message_index_fts;
      DROP TABLE IF EXISTS message_vector_index;
      DROP TABLE IF EXISTS session_vector_state;
      DROP TABLE IF EXISTS message_index;
      DROP TABLE IF EXISTS session_index_state;
      DELETE FROM meta WHERE key = 'schema_version';
    `)
  }

  private getSessionState(db: Database.Database, sessionId: string): ChatSearchIndexState | null {
    const row = db.prepare('SELECT * FROM session_index_state WHERE session_id = ?').get(sessionId) as any
    if (!row) return null

    return {
      sessionId,
      indexedCount: Number(row.indexed_count || 0),
      newestSortSeq: Number(row.newest_sort_seq || 0),
      newestCreateTime: Number(row.newest_create_time || 0),
      newestLocalId: Number(row.newest_local_id || 0),
      updatedAt: Number(row.updated_at || 0),
      isComplete: Number(row.is_complete || 0) === 1
    }
  }

  private getIndexedCount(db: Database.Database, sessionId: string): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM message_index WHERE session_id = ?').get(sessionId) as { count?: number }
    return Number(row?.count || 0)
  }

  private getVectorizedCount(db: Database.Database, sessionId: string): number {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM message_index m
      JOIN message_vector_index v ON v.message_id = m.id
      WHERE m.session_id = ? AND v.vector_model = ?
    `).get(sessionId, localVectorProvider.id) as { count?: number }
    return Number(row?.count || 0)
  }

  private getVectorTaskKey(sessionId: string): string {
    return `${sessionId}:${localVectorProvider.id}`
  }

  private getVectorStateRow(db: Database.Database, sessionId: string): SessionVectorStateRow | null {
    const row = db.prepare(`
      SELECT *
      FROM session_vector_state
      WHERE session_id = ? AND vector_model = ?
    `).get(sessionId, localVectorProvider.id) as SessionVectorStateRow | undefined
    return row || null
  }

  private isSessionVectorComplete(db: Database.Database, sessionId: string): boolean {
    return Number(this.getVectorStateRow(db, sessionId)?.is_complete || 0) === 1
  }

  private setSessionVectorState(db: Database.Database, input: {
    sessionId: string
    confirmedAt?: number | null
    completedAt?: number | null
    isComplete: boolean
    lastError?: string | null
  }): void {
    const now = Date.now()
    db.prepare(`
      INSERT INTO session_vector_state (
        session_id,
        vector_model,
        confirmed_at,
        completed_at,
        updated_at,
        is_complete,
        last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, vector_model) DO UPDATE SET
        confirmed_at = COALESCE(excluded.confirmed_at, session_vector_state.confirmed_at),
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at,
        is_complete = excluded.is_complete,
        last_error = excluded.last_error
    `).run(
      input.sessionId,
      localVectorProvider.id,
      input.confirmedAt ?? null,
      input.completedAt ?? null,
      now,
      input.isComplete ? 1 : 0,
      input.lastError ?? null
    )
  }

  getSessionVectorIndexState(sessionId: string): ChatVectorIndexState {
    const db = this.getDb()
    const indexedCount = this.getIndexedCount(db, sessionId)
    const vectorizedCount = this.getVectorizedCount(db, sessionId)
    const isRunning = this.vectorTasks.has(this.getVectorTaskKey(sessionId))
    const row = this.getVectorStateRow(db, sessionId)
    const isComplete = Number(row?.is_complete || 0) === 1
      && vectorizedCount >= indexedCount

    return {
      sessionId,
      indexedCount,
      vectorizedCount,
      pendingCount: Math.max(0, indexedCount - vectorizedCount),
      isVectorComplete: isComplete,
      isVectorRunning: isRunning,
      vectorModel: localVectorProvider.id
    }
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  private async reportVectorProgress(
    progress: Omit<ChatVectorIndexProgress, 'vectorModel'>,
    onProgress?: (progress: ChatVectorIndexProgress) => void | Promise<void>
  ): Promise<void> {
    await onProgress?.({
      ...progress,
      vectorModel: localVectorProvider.id
    })
  }

  private upsertVectorRows(
    db: Database.Database,
    rows: Array<Pick<MessageIndexRow, 'id' | 'session_id' | 'search_text'> & { indexed_at?: number }>
  ): void {
    if (rows.length === 0) return

    const upsertVector = db.prepare(`
      INSERT INTO message_vector_index (
        message_id,
        session_id,
        vector_model,
        vector_json,
        feature_count,
        indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        session_id = excluded.session_id,
        vector_model = excluded.vector_model,
        vector_json = excluded.vector_json,
        feature_count = excluded.feature_count,
        indexed_at = excluded.indexed_at
    `)

    const run = db.transaction((items: Array<Pick<MessageIndexRow, 'id' | 'session_id' | 'search_text'> & { indexed_at?: number }>) => {
      const now = Date.now()
      for (const row of items) {
        const vector = localVectorProvider.buildVector(row.search_text)
        upsertVector.run(
          row.id,
          row.session_id,
          localVectorProvider.id,
          JSON.stringify(vector),
          vector.length,
          row.indexed_at || now
        )
      }
    })

    run(rows)
  }

  private upsertMessages(db: Database.Database, sessionId: string, messages: Message[], options: {
    vectorize?: boolean
  } = {}): void {
    if (messages.length === 0) return

    const upsert = db.prepare(`
      INSERT INTO message_index (
        session_id,
        local_id,
        server_id,
        local_type,
        create_time,
        sort_seq,
        is_send,
        sender_username,
        parsed_content,
        raw_content,
        search_text,
        token_text,
        message_json,
        indexed_at
      ) VALUES (
        @sessionId,
        @localId,
        @serverId,
        @localType,
        @createTime,
        @sortSeq,
        @isSend,
        @senderUsername,
        @parsedContent,
        @rawContent,
        @searchText,
        @tokenText,
        @messageJson,
        @indexedAt
      )
      ON CONFLICT(session_id, local_id, create_time, sort_seq) DO UPDATE SET
        server_id = excluded.server_id,
        local_type = excluded.local_type,
        is_send = excluded.is_send,
        sender_username = excluded.sender_username,
        parsed_content = excluded.parsed_content,
        raw_content = excluded.raw_content,
        search_text = excluded.search_text,
        token_text = excluded.token_text,
        message_json = excluded.message_json,
        indexed_at = excluded.indexed_at
    `)
    const selectId = db.prepare(`
      SELECT id FROM message_index
      WHERE session_id = ? AND local_id = ? AND create_time = ? AND sort_seq = ?
    `)
    const deleteFts = db.prepare('DELETE FROM message_index_fts WHERE rowid = ?')
    const insertFts = db.prepare(`
      INSERT INTO message_index_fts(rowid, session_id, cursor_key, search_text, token_text)
      VALUES (?, ?, ?, ?, ?)
    `)
    const upsertVector = db.prepare(`
      INSERT INTO message_vector_index (
        message_id,
        session_id,
        vector_model,
        vector_json,
        feature_count,
        indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        session_id = excluded.session_id,
        vector_model = excluded.vector_model,
        vector_json = excluded.vector_json,
        feature_count = excluded.feature_count,
        indexed_at = excluded.indexed_at
    `)

    const run = db.transaction((items: Message[]) => {
      const indexedAt = Date.now()
      for (const message of items) {
        const searchText = compactSearchText(extractMessageSearchText(message))
        const tokenText = buildSearchTokens(searchText)
        const payload = {
          sessionId,
          localId: Number(message.localId || 0),
          serverId: Number(message.serverId || 0),
          localType: Number(message.localType || 0),
          createTime: Number(message.createTime || 0),
          sortSeq: Number(message.sortSeq || 0),
          isSend: message.isSend ?? null,
          senderUsername: message.senderUsername ?? null,
          parsedContent: String(message.parsedContent || ''),
          rawContent: String(message.rawContent || ''),
          searchText,
          tokenText,
          messageJson: JSON.stringify(message),
          indexedAt
        }

        upsert.run(payload)
        const row = selectId.get(sessionId, payload.localId, payload.createTime, payload.sortSeq) as { id?: number } | undefined
        if (!row?.id) continue

        deleteFts.run(row.id)
        insertFts.run(row.id, sessionId, cursorKey(message), searchText, tokenText)
        if (options.vectorize) {
          const vector = localVectorProvider.buildVector(searchText)
          upsertVector.run(
            row.id,
            sessionId,
            localVectorProvider.id,
            JSON.stringify(vector),
            vector.length,
            indexedAt
          )
        }
      }
    })

    run(messages)
  }

  private updateSessionState(db: Database.Database, sessionId: string, newest: Message | null, isComplete: boolean): ChatSearchIndexState {
    const indexedCount = this.getIndexedCount(db, sessionId)
    const previous = this.getSessionState(db, sessionId)
    const previousNewest = previous
      ? {
        localId: previous.newestLocalId,
        createTime: previous.newestCreateTime,
        sortSeq: previous.newestSortSeq
      }
      : null
    const selectedNewest = newest && (!previousNewest || compareCursorAsc(previousNewest, newest) <= 0)
      ? newest
      : previousNewest

    const state = {
      sessionId,
      indexedCount,
      newestSortSeq: Number(selectedNewest?.sortSeq || 0),
      newestCreateTime: Number(selectedNewest?.createTime || 0),
      newestLocalId: Number(selectedNewest?.localId || 0),
      updatedAt: Date.now(),
      isComplete
    }

    db.prepare(`
      INSERT INTO session_index_state (
        session_id,
        newest_sort_seq,
        newest_create_time,
        newest_local_id,
        indexed_count,
        updated_at,
        is_complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        newest_sort_seq = excluded.newest_sort_seq,
        newest_create_time = excluded.newest_create_time,
        newest_local_id = excluded.newest_local_id,
        indexed_count = excluded.indexed_count,
        updated_at = excluded.updated_at,
        is_complete = excluded.is_complete
    `).run(
      state.sessionId,
      state.newestSortSeq,
      state.newestCreateTime,
      state.newestLocalId,
      state.indexedCount,
      state.updatedAt,
      state.isComplete ? 1 : 0
    )

    return state
  }

  private async report(progress: ChatSearchIndexProgress, onProgress?: ChatSearchSessionOptions['onProgress']): Promise<void> {
    await onProgress?.(progress)
  }

  async ensureSessionIndexed(
    sessionId: string,
    onProgress?: ChatSearchSessionOptions['onProgress']
  ): Promise<ChatSearchIndexState> {
    const db = this.getDb()
    const state = this.getSessionState(db, sessionId)
    const vectorizeDuringIndexing = this.isSessionVectorComplete(db, sessionId)
    let newest: Message | null = state?.isComplete && state.newestSortSeq > 0
      ? {
        localId: state.newestLocalId,
        serverId: 0,
        localType: 0,
        createTime: state.newestCreateTime,
        sortSeq: state.newestSortSeq,
        isSend: null,
        senderUsername: null,
        parsedContent: '',
        rawContent: ''
      }
      : null
    let scanned = 0

    await this.report({
      stage: 'preparing_index',
      sessionId,
      message: state?.isComplete ? '正在检查会话搜索索引增量' : '正在建立当前会话搜索索引',
      indexedCount: state?.indexedCount || 0
    }, onProgress)

    if (state?.isComplete && state.newestSortSeq > 0) {
      let cursor = {
        sortSeq: state.newestSortSeq,
        createTime: state.newestCreateTime,
        localId: state.newestLocalId
      }
      let hasMore = true

      while (hasMore) {
        const result = await chatService.getMessagesAfter(
          sessionId,
          cursor.sortSeq,
          INDEX_BATCH_SIZE,
          cursor.createTime,
          cursor.localId
        )
        if (!result.success) {
          throw new Error(result.error || '更新搜索索引失败')
        }

        const messages = result.messages || []
        if (messages.length === 0) break
        this.upsertMessages(db, sessionId, messages, { vectorize: vectorizeDuringIndexing })
        scanned += messages.length
        newest = messages[messages.length - 1] || newest
        cursor = {
          sortSeq: newest.sortSeq,
          createTime: newest.createTime,
          localId: newest.localId
        }

        await this.report({
          stage: 'indexing_messages',
          sessionId,
          message: `已更新 ${scanned} 条新消息到搜索索引`,
          messagesScanned: scanned,
          indexedCount: this.getIndexedCount(db, sessionId)
        }, onProgress)

        hasMore = Boolean(result.hasMore)
      }

      const nextState = this.updateSessionState(db, sessionId, newest, true)
      await this.report({
        stage: 'completed',
        sessionId,
        message: `搜索索引已就绪，共 ${nextState.indexedCount} 条消息`,
        messagesScanned: scanned,
        indexedCount: nextState.indexedCount
      }, onProgress)
      return nextState
    }

    db.prepare('DELETE FROM message_index_fts WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM message_vector_index WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM session_index_state WHERE session_id = ?').run(sessionId)

    const firstPage = await chatService.getMessages(sessionId, 0, INDEX_BATCH_SIZE)
    if (!firstPage.success) {
      throw new Error(firstPage.error || '建立搜索索引失败')
    }

    let messages = firstPage.messages || []
    let hasMore = Boolean(firstPage.hasMore)
    if (messages.length > 0) {
      this.upsertMessages(db, sessionId, messages, { vectorize: vectorizeDuringIndexing })
      scanned += messages.length
      newest = messages[messages.length - 1]
      await this.report({
        stage: 'indexing_messages',
        sessionId,
        message: `已索引 ${scanned} 条消息`,
        messagesScanned: scanned,
        indexedCount: this.getIndexedCount(db, sessionId)
      }, onProgress)
    }

    while (hasMore && messages.length > 0) {
      const oldest = messages[0]
      const result = await chatService.getMessagesBefore(
        sessionId,
        oldest.sortSeq,
        INDEX_BATCH_SIZE,
        oldest.createTime,
        oldest.localId
      )
      if (!result.success) {
        throw new Error(result.error || '继续建立搜索索引失败')
      }

      messages = result.messages || []
      if (messages.length === 0) break
      this.upsertMessages(db, sessionId, messages, { vectorize: vectorizeDuringIndexing })
      scanned += messages.length
      hasMore = Boolean(result.hasMore)

      await this.report({
        stage: 'indexing_messages',
        sessionId,
        message: `已索引 ${scanned} 条消息`,
        messagesScanned: scanned,
        indexedCount: this.getIndexedCount(db, sessionId)
      }, onProgress)
    }

    const nextState = this.updateSessionState(db, sessionId, newest, true)
    await this.report({
      stage: 'completed',
      sessionId,
      message: `搜索索引已就绪，共 ${nextState.indexedCount} 条消息`,
      messagesScanned: scanned,
      indexedCount: nextState.indexedCount
    }, onProgress)
    return nextState
  }

  async prepareSessionVectorIndex(
    sessionId: string,
    onProgress?: (progress: ChatVectorIndexProgress) => void | Promise<void>
  ): Promise<ChatVectorIndexState> {
    const key = this.getVectorTaskKey(sessionId)
    const existingTask = this.vectorTasks.get(key)
    if (existingTask) {
      await this.reportVectorProgress({
        sessionId,
        stage: 'preparing',
        status: 'running',
        processedCount: this.getSessionVectorIndexState(sessionId).vectorizedCount,
        totalCount: this.getSessionVectorIndexState(sessionId).indexedCount,
        message: '当前会话正在向量化，复用已有任务'
      }, onProgress)
      return existingTask.promise
    }

    const task: VectorTask = {
      cancelRequested: false,
      promise: Promise.resolve(this.getSessionVectorIndexState(sessionId))
    }
    task.promise = this.runPrepareSessionVectorIndex(sessionId, task, onProgress)
    this.vectorTasks.set(key, task)

    try {
      return await task.promise
    } finally {
      this.vectorTasks.delete(key)
    }
  }

  cancelSessionVectorIndex(sessionId: string): ChatVectorIndexState {
    const task = this.vectorTasks.get(this.getVectorTaskKey(sessionId))
    if (task) {
      task.cancelRequested = true
    }
    return this.getSessionVectorIndexState(sessionId)
  }

  private async runPrepareSessionVectorIndex(
    sessionId: string,
    task: VectorTask,
    onProgress?: (progress: ChatVectorIndexProgress) => void | Promise<void>
  ): Promise<ChatVectorIndexState> {
    const db = this.getDb()

    await this.reportVectorProgress({
      sessionId,
      stage: 'preparing',
      status: 'running',
      processedCount: 0,
      totalCount: 0,
      message: '正在准备当前会话搜索索引'
    }, onProgress)

    try {
      const searchState = await this.ensureSessionIndexed(sessionId, async (progress) => {
        if (task.cancelRequested) {
          throw new Error(VECTOR_INDEX_CANCELLED_ERROR)
        }
        await this.reportVectorProgress({
          sessionId,
          stage: 'indexing_messages',
          status: 'running',
          processedCount: progress.indexedCount ?? progress.messagesScanned ?? 0,
          totalCount: progress.indexedCount ?? 0,
          message: progress.message
        }, onProgress)
        if (task.cancelRequested) {
          throw new Error(VECTOR_INDEX_CANCELLED_ERROR)
        }
      })

      let currentState = this.getSessionVectorIndexState(sessionId)
      if (currentState.isVectorComplete) {
        await this.reportVectorProgress({
          sessionId,
          stage: 'completed',
          status: 'completed',
          processedCount: currentState.vectorizedCount,
          totalCount: currentState.indexedCount,
          message: `本地向量索引已就绪，共 ${currentState.vectorizedCount} 条消息`
        }, onProgress)
        return currentState
      }

      this.setSessionVectorState(db, {
        sessionId,
        confirmedAt: Date.now(),
        completedAt: null,
        isComplete: false,
        lastError: null
      })

      if (searchState.indexedCount === 0) {
        this.setSessionVectorState(db, {
          sessionId,
          completedAt: Date.now(),
          isComplete: true,
          lastError: null
        })
        currentState = this.getSessionVectorIndexState(sessionId)
        await this.reportVectorProgress({
          sessionId,
          stage: 'completed',
          status: 'completed',
          processedCount: 0,
          totalCount: 0,
          message: '当前会话暂无可向量化消息'
        }, onProgress)
        return currentState
      }

      while (true) {
        if (task.cancelRequested) {
          this.setSessionVectorState(db, {
            sessionId,
            completedAt: null,
            isComplete: false,
            lastError: 'cancelled'
          })
          currentState = this.getSessionVectorIndexState(sessionId)
          await this.reportVectorProgress({
            sessionId,
            stage: 'vectorizing_messages',
            status: 'cancelled',
            processedCount: currentState.vectorizedCount,
            totalCount: currentState.indexedCount,
            message: '已取消当前会话向量化'
          }, onProgress)
          return currentState
        }

        const rows = db.prepare(`
          SELECT m.id, m.session_id, m.search_text, m.indexed_at
          FROM message_index m
          LEFT JOIN message_vector_index v
            ON v.message_id = m.id AND v.vector_model = ?
          WHERE m.session_id = ? AND v.message_id IS NULL
          ORDER BY m.id ASC
          LIMIT ?
        `).all(localVectorProvider.id, sessionId, VECTOR_BATCH_SIZE) as Array<Pick<MessageIndexRow, 'id' | 'session_id' | 'search_text'> & { indexed_at?: number }>

        if (rows.length === 0) break

        this.upsertVectorRows(db, rows)
        currentState = this.getSessionVectorIndexState(sessionId)
        await this.reportVectorProgress({
          sessionId,
          stage: 'vectorizing_messages',
          status: 'running',
          processedCount: currentState.vectorizedCount,
          totalCount: currentState.indexedCount,
          message: `已向量化 ${currentState.vectorizedCount}/${currentState.indexedCount} 条消息`
        }, onProgress)
        await this.yieldToEventLoop()
      }

      this.setSessionVectorState(db, {
        sessionId,
        completedAt: Date.now(),
        isComplete: true,
        lastError: null
      })
      currentState = this.getSessionVectorIndexState(sessionId)

      await this.reportVectorProgress({
        sessionId,
        stage: 'completed',
        status: 'completed',
        processedCount: currentState.vectorizedCount,
        totalCount: currentState.indexedCount,
        message: `本地向量索引已完成，共 ${currentState.vectorizedCount} 条消息`
      }, onProgress)

      return currentState
    } catch (error) {
      if (error instanceof Error && error.message === VECTOR_INDEX_CANCELLED_ERROR) {
        this.setSessionVectorState(db, {
          sessionId,
          completedAt: null,
          isComplete: false,
          lastError: 'cancelled'
        })
        const cancelledState = this.getSessionVectorIndexState(sessionId)
        await this.reportVectorProgress({
          sessionId,
          stage: 'indexing_messages',
          status: 'cancelled',
          processedCount: cancelledState.vectorizedCount,
          totalCount: cancelledState.indexedCount,
          message: '已取消当前会话向量化'
        }, onProgress)
        return cancelledState
      }

      this.setSessionVectorState(db, {
        sessionId,
        completedAt: null,
        isComplete: false,
        lastError: String(error)
      })
      const failedState = this.getSessionVectorIndexState(sessionId)
      await this.reportVectorProgress({
        sessionId,
        stage: 'vectorizing_messages',
        status: 'failed',
        processedCount: failedState.vectorizedCount,
        totalCount: failedState.indexedCount,
        message: `向量化失败：${String(error)}`
      }, onProgress)
      throw error
    }
  }

  async searchSession(options: ChatSearchSessionOptions): Promise<ChatSearchSessionResult> {
    const db = this.getDb()
    const state = await this.ensureSessionIndexed(options.sessionId, options.onProgress)
    const query = normalizeSearchText(options.query)
    if (!query) {
      return {
        hits: [],
        indexedCount: state.indexedCount,
        truncated: false
      }
    }

    await this.report({
      stage: 'searching_index',
      sessionId: options.sessionId,
      message: `正在搜索本地索引：${options.query}`,
      indexedCount: state.indexedCount
    }, options.onProgress)

    const startTime = toTimestampSeconds(options.startTimeMs)
    const endTime = toTimestampSeconds(options.endTimeMs)
    const senderUsername = normalizeSearchText(options.senderUsername)
    const direction = options.direction
    const candidateLimit = Math.min(MAX_INDEX_SEARCH_CANDIDATES, Math.max(options.limit * 8, options.limit + 20))
    const sqlFilters: string[] = ['m.session_id = @sessionId']
    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      limit: candidateLimit + 1
    }

    if (startTime) {
      sqlFilters.push('m.create_time >= @startTime')
      params.startTime = startTime
    }
    if (endTime) {
      sqlFilters.push('m.create_time <= @endTime')
      params.endTime = endTime
    }
    if (direction) {
      sqlFilters.push(direction === 'out' ? 'm.is_send = 1' : '(m.is_send IS NULL OR m.is_send != 1)')
    }
    if (senderUsername) {
      sqlFilters.push('lower(COALESCE(m.sender_username, \'\')) = @senderUsername')
      params.senderUsername = senderUsername
    }

    const rowsById = new Map<number, MessageIndexRow>()
    const ftsQuery = buildFtsQuery(query)
    if (ftsQuery) {
      const ftsRows = db.prepare(`
        SELECT m.*, bm25(message_index_fts) AS rank
        FROM message_index_fts
        JOIN message_index m ON m.id = message_index_fts.rowid
        WHERE message_index_fts MATCH @ftsQuery
          AND ${sqlFilters.join(' AND ')}
        ORDER BY rank ASC, m.sort_seq DESC, m.create_time DESC, m.local_id DESC
        LIMIT @limit
      `).all({
        ...params,
        ftsQuery
      }) as MessageIndexRow[]

      for (const row of ftsRows) {
        rowsById.set(row.id, row)
      }
    }

    const likeQuery = `%${query}%`
    const compactQuery = query.replace(/\s+/g, '')
    const likeRows = db.prepare(`
      SELECT m.*
      FROM message_index m
      WHERE ${sqlFilters.join(' AND ')}
        AND (
          m.search_text LIKE @likeQuery
          OR replace(m.search_text, ' ', '') LIKE @compactLikeQuery
        )
      ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
      LIMIT @limit
    `).all({
      ...params,
      likeQuery,
      compactLikeQuery: `%${compactQuery || query}%`
    }) as MessageIndexRow[]

    for (const row of likeRows) {
      rowsById.set(row.id, row)
    }

    const rows = Array.from(rowsById.values())
    const filteredRows = options.matchMode === 'exact'
      ? rows.filter((row) => hasExactMessageMatch(row, options.query))
      : rows
    const hits = filteredRows.map((row) => {
      const match = findMatchInIndexedText(row, options.query, options.matchMode)
      return {
        sessionId: options.sessionId,
        message: rowToMessage(row),
        excerpt: match.excerpt,
        matchedField: match.matchedField,
        score: match.score
      } satisfies ChatSearchIndexHit
    })
      .sort((a, b) => b.score - a.score || compareCursorAsc(b.message, a.message))

    return {
      hits: hits.slice(0, options.limit),
      indexedCount: state.indexedCount,
      truncated: rows.length > options.limit
    }
  }

  async searchSessionByVector(options: ChatSearchSessionOptions): Promise<ChatVectorSearchSessionResult> {
    const db = this.getDb()
    const state = await this.ensureSessionIndexed(options.sessionId, options.onProgress)
    const vectorState = this.getSessionVectorIndexState(options.sessionId)
    const queryVector = localVectorProvider.buildVector(options.query)
    const vectorizedCount = vectorState.vectorizedCount

    if (!vectorState.isVectorComplete || queryVector.length === 0) {
      return {
        hits: [],
        indexedCount: state.indexedCount,
        vectorizedCount,
        truncated: false,
        model: localVectorProvider.id
      }
    }

    await this.report({
      stage: 'searching_index',
      sessionId: options.sessionId,
      message: `正在进行本地向量检索：${options.query}`,
      indexedCount: state.indexedCount
    }, options.onProgress)

    const startTime = toTimestampSeconds(options.startTimeMs)
    const endTime = toTimestampSeconds(options.endTimeMs)
    const senderUsername = normalizeSearchText(options.senderUsername)
    const direction = options.direction
    const scanLimit = MAX_VECTOR_SCAN_ROWS
    const sqlFilters: string[] = [
      'v.session_id = @sessionId',
      'v.vector_model = @vectorModel'
    ]
    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      vectorModel: localVectorProvider.id,
      scanLimit: scanLimit + 1
    }

    if (startTime) {
      sqlFilters.push('m.create_time >= @startTime')
      params.startTime = startTime
    }
    if (endTime) {
      sqlFilters.push('m.create_time <= @endTime')
      params.endTime = endTime
    }
    if (direction) {
      sqlFilters.push(direction === 'out' ? 'm.is_send = 1' : '(m.is_send IS NULL OR m.is_send != 1)')
    }
    if (senderUsername) {
      sqlFilters.push('lower(COALESCE(m.sender_username, \'\')) = @senderUsername')
      params.senderUsername = senderUsername
    }

    const rows = db.prepare(`
      SELECT m.*, v.vector_json
      FROM message_vector_index v
      JOIN message_index m ON m.id = v.message_id
      WHERE ${sqlFilters.join(' AND ')}
        AND v.feature_count > 0
      ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
      LIMIT @scanLimit
    `).all(params) as MessageVectorRow[]
    const queryWeights = localVectorProvider.toWeightMap(queryVector)
    const scored = rows
      .map((row) => {
        const vectorScore = localVectorProvider.dot(queryWeights, localVectorProvider.parseVector(row.vector_json))
        return {
          row,
          vectorScore
        }
      })
      .filter((item) => item.vectorScore >= VECTOR_MIN_SCORE)
      .sort((a, b) => b.vectorScore - a.vectorScore || compareIndexRowCursorAsc(b.row, a.row))
      .slice(0, options.limit)

    const hits = scored.map(({ row, vectorScore }) => ({
      sessionId: options.sessionId,
      message: rowToMessage(row),
      excerpt: createVectorExcerpt(row, options.query),
      matchedField: 'text' as const,
      score: Number((VECTOR_SCORE_BASE + vectorScore * VECTOR_SCORE_SCALE).toFixed(2))
    } satisfies ChatSearchIndexHit))

    return {
      hits,
      indexedCount: state.indexedCount,
      vectorizedCount,
      truncated: rows.length > scanLimit,
      model: localVectorProvider.id
    }
  }
}

export const chatSearchIndexService = new ChatSearchIndexService()
