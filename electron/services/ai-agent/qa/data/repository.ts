import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { ConfigService } from '../../../config'
import { dbAdapter } from '../../../dbAdapter'
import { findMessageDbPaths } from '../../../dbStoragePaths'
import type {
  AgentContact,
  AgentContactKind,
  AgentCursor,
  AgentMemoryItem,
  AgentMemoryRef,
  AgentMessage,
  AgentSessionRef,
  AgentSourceMessage
} from './models'
import {
  decodeMessageContent,
  detectAgentMessageKind,
  extractXmlValue,
  parseChatHistory,
  parseFileInfo,
  parseMessageContent
} from './textParser'

type DbTablePair = {
  dbPath: string
  tableName: string
}

type MessageQueryOptions = {
  offset?: number
  limit?: number
  order?: 'asc' | 'desc'
  startTime?: number
  endTime?: number
  keyword?: string
  senderUsername?: string
}

type MessageRow = Record<string, unknown> & {
  local_id?: number
  server_id?: number
  local_type?: number
  type?: number
  create_time?: number
  sort_seq?: number
  is_send?: number | null
  computed_is_send?: number | null
  sender_username?: string | null
  message_content?: unknown
  compress_content?: unknown
}

type ContactRow = {
  username?: string
  remark?: string
  nick_name?: string
  alias?: string
  type?: number
  local_type?: number
  flag?: number
  quan_pin?: string
}

const MESSAGE_DB_CACHE_MS = 60_000
const DEFAULT_QUERY_LIMIT = 80
const MAX_QUERY_LIMIT = 20_000

function normalizeLimit(value: unknown, fallback = DEFAULT_QUERY_LIMIT, max = MAX_QUERY_LIMIT): number {
  const numberValue = Math.floor(Number(value || fallback))
  return Math.max(1, Math.min(Number.isFinite(numberValue) ? numberValue : fallback, max))
}

function toTimestampMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function compareCursorAsc(a: AgentCursor, b: AgentCursor): number {
  return Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
}

function compareCursorDesc(a: AgentCursor, b: AgentCursor): number {
  return compareCursorAsc(b, a)
}

function cleanAccountDirName(name: string): string {
  const trimmed = String(name || '').trim()
  if (!trimmed) return trimmed
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    return trimmed.match(/^(wxid_[a-zA-Z0-9]+)/i)?.[1] || trimmed
  }
  return trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)?.[1] || trimmed
}

function getTableNameHash(sessionId: string): string {
  return createHash('md5').update(sessionId).digest('hex').toLowerCase()
}

function detectSessionKind(sessionId: string): AgentSessionRef['kind'] {
  if (sessionId.includes('@chatroom')) return 'group'
  if (sessionId.startsWith('gh_')) return 'official'
  return 'friend'
}

function detectContactKind(row: ContactRow): AgentContactKind {
  const username = String(row.username || '')
  if (username.includes('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  if (Number(row.local_type ?? row.type ?? row.flag ?? 0) === 0) return 'former_friend'
  if (username) return 'friend'
  return 'other'
}

function safeJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseMemoryRefs(value: unknown): AgentMemoryRef[] {
  return safeJsonArray(value)
    .map((item): AgentMemoryRef | null => {
      if (!item || typeof item !== 'object') return null
      const raw = item as Record<string, unknown>
      const sessionId = String(raw.sessionId || '').trim()
      const localId = Number(raw.localId)
      const createTime = Number(raw.createTime)
      const sortSeq = Number(raw.sortSeq)
      if (!sessionId || !Number.isFinite(localId) || !Number.isFinite(createTime) || !Number.isFinite(sortSeq)) return null
      const senderUsername = String(raw.senderUsername || '').trim()
      const excerpt = String(raw.excerpt || '').trim()
      return {
        sessionId,
        localId,
        createTime,
        sortSeq,
        ...(senderUsername ? { senderUsername } : {}),
        ...(excerpt ? { excerpt } : {})
      }
    })
    .filter((item): item is AgentMemoryRef => Boolean(item))
}

function compactSearchText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

export function buildAgentQueryTokens(query: string): string[] {
  const normalized = compactSearchText(query)
  const tokens: string[] = []
  const seen = new Set<string>()
  const push = (value: string) => {
    const token = compactSearchText(value)
    if (!token || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }

  for (const match of normalized.matchAll(/[\u3400-\u9fff]+/g)) {
    const segment = match[0]
    if (segment.length <= 3) push(segment)
    const size = segment.length <= 4 ? 2 : 3
    for (let index = 0; index <= segment.length - size; index += 1) {
      push(segment.slice(index, index + size))
    }
  }

  for (const match of normalized.matchAll(/[a-z0-9_@.\-]{2,}/g)) {
    push(match[0])
  }
  return tokens.slice(0, 12)
}

export function buildAgentFtsQuery(query: string): string {
  return buildAgentQueryTokens(query).map(quoteFtsTerm).join(' ')
}

export class AgentDataRepository {
  private dbCache = new Map<string, Database.Database>()
  private tableCache = new Map<string, { dbPath: string; tableName: string }[]>()
  private tableCacheExpiresAt = 0
  private displayNameCache = new Map<string, { value: Map<string, string>; expiresAt: number }>()
  private tableExistsCache = new Map<string, boolean>()
  private myRowIdCache = new Map<string, number | null>()

  getCacheBasePath(): string {
    const config = new ConfigService()
    try {
      return String(config.get('cachePath') || '').trim() || join(process.cwd(), 'cache')
    } finally {
      config.close()
    }
  }

  getCurrentWxid(): string {
    const config = new ConfigService()
    try {
      return String(config.get('myWxid') || '').trim()
    } finally {
      config.close()
    }
  }

  openReadonly(dbPath: string): Database.Database | null {
    const existing = this.dbCache.get(dbPath)
    if (existing) return existing
    if (!existsSync(dbPath)) return null
    try {
      const db = new Database(dbPath, { readonly: true })
      this.dbCache.set(dbPath, db)
      return db
    } catch {
      return null
    }
  }

  getSessionRef(sessionId: string, displayNameMap?: Map<string, string>): AgentSessionRef {
    return {
      sessionId,
      displayName: displayNameMap?.get(sessionId) || sessionId,
      kind: detectSessionKind(sessionId)
    }
  }

  async listContacts(): Promise<AgentContact[]> {
    try {
      const columns = await dbAdapter.all<{ name: string }>('contact', '', 'PRAGMA table_info(contact)')
      const columnNames = new Set(columns.map((column) => String(column.name || '')))
      const selectCols = ['username', 'remark', 'nick_name', 'alias', 'quan_pin']
        .filter((column) => columnNames.has(column))
      for (const optional of ['type', 'local_type', 'flag']) {
        if (columnNames.has(optional)) selectCols.push(optional)
      }
      if (!selectCols.includes('username')) return []

      const rows = await dbAdapter.all<ContactRow>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact`
      )
      return rows.flatMap((row): AgentContact[] => {
        const contactId = String(row.username || '').trim()
        if (!contactId) return []
        const displayName = String(row.remark || row.nick_name || row.alias || contactId).trim()
        return [{
          contactId,
          sessionId: contactId,
          displayName,
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          kind: detectContactKind(row)
        }]
      })
    } catch {
      return []
    }
  }

  async loadGroupMembers(chatroomId: string): Promise<AgentContact[]> {
    try {
      const tables = await dbAdapter.all<{ name: string }>('contact', '', "SELECT name FROM sqlite_master WHERE type='table'")
      const tableNames = new Set(tables.map((item) => item.name.toLowerCase()))
      if (!tableNames.has('chatroom_member') || !tableNames.has('name2id')) return []
      const rows = await dbAdapter.all<ContactRow>('contact', '', `
        SELECT n.username, c.nick_name, c.remark
        FROM chatroom_member m
        JOIN name2id n ON m.member_id = n.rowid
        LEFT JOIN contact c ON n.username = c.username
        WHERE m.room_id = (SELECT rowid FROM name2id WHERE username = ?)
      `, [chatroomId])
      return rows.flatMap((row): AgentContact[] => {
        const username = String(row.username || '').trim()
        if (!username) return []
        return [{
          contactId: username,
          sessionId: username,
          displayName: String(row.remark || row.nick_name || username).trim(),
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          kind: 'friend' as const
        }]
      })
    } catch {
      return []
    }
  }

  async loadDisplayNameMap(sessionId: string): Promise<Map<string, string>> {
    const cached = this.displayNameCache.get(sessionId)
    if (cached && cached.expiresAt > Date.now()) return new Map(cached.value)

    const map = new Map<string, string>()
    for (const contact of await this.listContacts()) {
      if (contact.contactId && contact.displayName) map.set(contact.contactId, contact.displayName)
    }
    if (sessionId.includes('@chatroom')) {
      for (const member of await this.loadGroupMembers(sessionId)) {
        if (member.contactId && member.displayName) map.set(member.contactId, member.displayName)
      }
    }
    this.displayNameCache.set(sessionId, { value: map, expiresAt: Date.now() + MESSAGE_DB_CACHE_MS })
    return new Map(map)
  }

  private async findMessageTable(dbPath: string, sessionId: string): Promise<string | null> {
    const hash = getTableNameHash(sessionId)
    try {
      const rows = await dbAdapter.all<{ name: string }>(
        'message',
        dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
      )
      for (const row of rows) {
        const tableName = String(row.name || '')
        const match = tableName.match(/msg_([0-9a-f]{32})/i)
        if (match?.[1]?.toLowerCase() === hash || tableName.toLowerCase().includes(hash)) return tableName
      }
    } catch {
      return null
    }
    return null
  }

  private async tableExists(dbPath: string, tableName: string): Promise<boolean> {
    const cacheKey = `${dbPath}:${tableName}`
    const cached = this.tableExistsCache.get(cacheKey)
    if (cached !== undefined) return cached
    try {
      const row = await dbAdapter.get<{ name: string }>(
        'message',
        dbPath,
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        [tableName]
      )
      const exists = Boolean(row)
      this.tableExistsCache.set(cacheKey, exists)
      return exists
    } catch {
      this.tableExistsCache.set(cacheKey, false)
      return false
    }
  }

  private async getMyRowId(dbPath: string): Promise<number | null> {
    const wxid = this.getCurrentWxid()
    const cleaned = cleanAccountDirName(wxid)
    if (!wxid) return null
    for (const candidate of Array.from(new Set([wxid, cleaned]))) {
      if (!candidate) continue
      const cacheKey = `${dbPath}:${candidate}`
      const cached = this.myRowIdCache.get(cacheKey)
      if (cached !== undefined) {
        if (cached !== null) return cached
        continue
      }
      try {
        const row = await dbAdapter.get<{ rowid?: number }>(
          'message',
          dbPath,
          'SELECT rowid FROM Name2Id WHERE user_name = ?',
          [candidate]
        )
        if (row?.rowid) {
          const rowId = Number(row.rowid)
          this.myRowIdCache.set(cacheKey, rowId)
          return rowId
        }
        this.myRowIdCache.set(cacheKey, null)
      } catch {
        return null
      }
    }
    return null
  }

  async findSessionTables(sessionId: string): Promise<DbTablePair[]> {
    const now = Date.now()
    if (this.tableCacheExpiresAt < now) {
      this.tableCache.clear()
      this.tableCacheExpiresAt = now + MESSAGE_DB_CACHE_MS
    }

    const cached = this.tableCache.get(sessionId)
    if (cached?.length) {
      return cached.map((item) => ({ dbPath: item.dbPath, tableName: item.tableName }))
    }

    const pairs: DbTablePair[] = []
    for (const dbPath of findMessageDbPaths()) {
      const tableName = await this.findMessageTable(dbPath, sessionId)
      if (tableName) pairs.push({ dbPath, tableName })
    }
    this.tableCache.set(sessionId, pairs.map((item) => ({ dbPath: item.dbPath, tableName: item.tableName })))
    return pairs
  }

  private rowToSourceMessage(row: MessageRow): AgentSourceMessage {
    const rawContent = decodeMessageContent(row.message_content, row.compress_content)
    const localType = Number(row.local_type || row.type || 1)
    const parsedContent = parseMessageContent(rawContent, localType)
    const xmlType = rawContent ? extractXmlValue(rawContent, 'type') : ''
    const fileInfo = localType === 49 ? parseFileInfo(rawContent) : {}
    return {
      localId: Number(row.local_id || 0),
      serverId: Number(row.server_id || 0),
      localType,
      createTime: Number(row.create_time || 0),
      sortSeq: Number(row.sort_seq || 0),
      isSend: row.computed_is_send ?? row.is_send ?? null,
      senderUsername: row.sender_username ? String(row.sender_username) : null,
      parsedContent,
      rawContent,
      chatRecordList: rawContent && (xmlType === '19' || localType === 49) ? parseChatHistory(rawContent) : undefined,
      fileName: fileInfo.fileName
    }
  }

  sourceToAgentMessage(sessionId: string, source: AgentSourceMessage, displayNameMap?: Map<string, string>): AgentMessage {
    const direction = Number(source.isSend) === 1 ? 'out' : 'in'
    const senderUsername = source.senderUsername || ''
    const fallbackUsername = senderUsername || (sessionId.includes('@chatroom') ? '' : sessionId)
    const displayName = direction === 'out'
      ? '我'
      : displayNameMap?.get(fallbackUsername) || fallbackUsername || null
    return {
      messageId: Number(source.localId || source.serverId || 0),
      timestamp: Number(source.createTime || 0),
      timestampMs: toTimestampMs(Number(source.createTime || 0)),
      direction,
      kind: detectAgentMessageKind(source),
      text: String(source.parsedContent || source.rawContent || ''),
      sender: {
        username: source.senderUsername || null,
        displayName,
        isSelf: direction === 'out'
      },
      cursor: {
        localId: Number(source.localId || 0),
        createTime: Number(source.createTime || 0),
        sortSeq: Number(source.sortSeq || 0)
      },
      raw: source
    }
  }

  private buildMessageSql(tableName: string, hasName2Id: boolean, myRowId: number | null, options: MessageQueryOptions, perDbLimit: number): { sql: string; params: unknown[] } {
    const alias = hasName2Id ? 'm.' : ''
    const where: string[] = []
    const params: unknown[] = []

    if (options.startTime) {
      where.push(`${alias}create_time >= ?`)
      params.push(Math.floor(options.startTime))
    }
    if (options.endTime) {
      where.push(`${alias}create_time <= ?`)
      params.push(Math.floor(options.endTime))
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const orderDirection = options.order === 'asc' ? 'ASC' : 'DESC'

    if (hasName2Id && myRowId !== null) {
      return {
        sql: `SELECT m.*, CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send, n.user_name AS sender_username
              FROM ${tableName} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
              ${whereSql}
              ORDER BY m.sort_seq ${orderDirection}, m.create_time ${orderDirection}, m.local_id ${orderDirection}
              LIMIT ?`,
        params: [myRowId, ...params, perDbLimit]
      }
    }

    if (hasName2Id) {
      return {
        sql: `SELECT m.*, n.user_name AS sender_username
              FROM ${tableName} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
              ${whereSql}
              ORDER BY m.sort_seq ${orderDirection}, m.create_time ${orderDirection}, m.local_id ${orderDirection}
              LIMIT ?`,
        params: [...params, perDbLimit]
      }
    }

    return {
      sql: `SELECT * FROM ${tableName}
            ${whereSql}
            ORDER BY sort_seq ${orderDirection}, create_time ${orderDirection}, local_id ${orderDirection}
            LIMIT ?`,
      params: [...params, perDbLimit]
    }
  }

  async getMessages(sessionId: string, options: MessageQueryOptions = {}): Promise<{ items: AgentMessage[]; hasMore: boolean; scanned: number }> {
    const limit = normalizeLimit(options.limit, DEFAULT_QUERY_LIMIT)
    const offset = Math.max(0, Math.floor(Number(options.offset || 0)))
    const perDbLimit = Math.min(MAX_QUERY_LIMIT, Math.max(offset + limit + 1, limit + 1, 100))
    const displayMap = await this.loadDisplayNameMap(sessionId)
    const pairs = await this.findSessionTables(sessionId)
    const messages: AgentMessage[] = []
    let scanned = 0

    for (const pair of pairs) {
      const hasName2Id = await this.tableExists(pair.dbPath, 'Name2Id')
      const myRowId = hasName2Id ? await this.getMyRowId(pair.dbPath) : null
      const query = this.buildMessageSql(pair.tableName, hasName2Id, myRowId, options, perDbLimit)
      try {
        const rows = await dbAdapter.all<MessageRow>('message', pair.dbPath, query.sql, query.params)
        scanned += rows.length
        for (const row of rows) {
          const source = this.rowToSourceMessage(row)
          const message = this.sourceToAgentMessage(sessionId, source, displayMap)
          if (options.senderUsername && message.sender.username !== options.senderUsername) continue
          if (options.keyword) {
            const haystack = `${message.text}\n${source.rawContent}`.toLowerCase()
            if (!haystack.includes(String(options.keyword).toLowerCase())) continue
          }
          messages.push(message)
        }
      } catch {
        continue
      }
    }

    const seen = new Set<string>()
    const unique = messages.filter((message) => {
      const key = this.cursorKey(message.cursor)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    unique.sort((a, b) => options.order === 'asc' ? compareCursorAsc(a.cursor, b.cursor) : compareCursorDesc(a.cursor, b.cursor))

    const sliced = unique.slice(offset, offset + limit)
    return { items: sliced, hasMore: unique.length > offset + limit, scanned }
  }

  async getContextAround(sessionId: string, cursor: AgentCursor, beforeLimit: number, afterLimit: number): Promise<AgentMessage[]> {
    const before = await this.getMessagesBefore(sessionId, cursor, beforeLimit)
    const anchor = await this.getMessageByCursor(sessionId, cursor)
    const after = await this.getMessagesAfter(sessionId, cursor, afterLimit)
    return this.dedupeMessagesByCursor([...before, ...(anchor ? [anchor] : []), ...after])
  }

  async getMessagesBefore(sessionId: string, cursor: AgentCursor, limit: number): Promise<AgentMessage[]> {
    const result = await this.getMessages(sessionId, { order: 'desc', endTime: cursor.createTime, limit: Math.max(limit * 4, limit + 20) })
    return result.items
      .filter((message) => compareCursorAsc(message.cursor, cursor) < 0)
      .sort((a, b) => compareCursorDesc(a.cursor, b.cursor))
      .slice(0, limit)
      .sort((a, b) => compareCursorAsc(a.cursor, b.cursor))
  }

  async getMessagesAfter(sessionId: string, cursor: AgentCursor, limit: number): Promise<AgentMessage[]> {
    const result = await this.getMessages(sessionId, { order: 'asc', startTime: cursor.createTime, limit: Math.max(limit * 4, limit + 20) })
    return result.items
      .filter((message) => compareCursorAsc(message.cursor, cursor) > 0)
      .sort((a, b) => compareCursorAsc(a.cursor, b.cursor))
      .slice(0, limit)
  }

  async getMessageByCursor(sessionId: string, cursor: AgentCursor): Promise<AgentMessage | null> {
    const displayMap = await this.loadDisplayNameMap(sessionId)
    for (const pair of await this.findSessionTables(sessionId)) {
      try {
        const hasName2Id = await this.tableExists(pair.dbPath, 'Name2Id')
        const myRowId = hasName2Id ? await this.getMyRowId(pair.dbPath) : null
        const row = hasName2Id && myRowId !== null
          ? await dbAdapter.get<MessageRow>('message', pair.dbPath, `SELECT m.*, CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send, n.user_name AS sender_username FROM ${pair.tableName} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid WHERE m.local_id = ? AND m.create_time = ? AND m.sort_seq = ?`, [myRowId, cursor.localId, cursor.createTime, cursor.sortSeq])
          : hasName2Id
            ? await dbAdapter.get<MessageRow>('message', pair.dbPath, `SELECT m.*, n.user_name AS sender_username FROM ${pair.tableName} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid WHERE m.local_id = ? AND m.create_time = ? AND m.sort_seq = ?`, [cursor.localId, cursor.createTime, cursor.sortSeq])
            : await dbAdapter.get<MessageRow>('message', pair.dbPath, `SELECT * FROM ${pair.tableName} WHERE local_id = ? AND create_time = ? AND sort_seq = ?`, [cursor.localId, cursor.createTime, cursor.sortSeq])
        if (row) return this.sourceToAgentMessage(sessionId, this.rowToSourceMessage(row as MessageRow), displayMap)
      } catch {
        continue
      }
    }
    return null
  }

  evidenceRefToMessage(ref: AgentMemoryRef, displayNameMap?: Map<string, string>): AgentMessage {
    const source: AgentSourceMessage = {
      localId: ref.localId,
      serverId: 0,
      localType: 1,
      createTime: ref.createTime,
      sortSeq: ref.sortSeq,
      isSend: null,
      senderUsername: ref.senderUsername || null,
      parsedContent: ref.excerpt || '',
      rawContent: ref.excerpt || ''
    }
    return this.sourceToAgentMessage(ref.sessionId, source, displayNameMap)
  }

  dedupeMessagesByCursor(messages: AgentMessage[]): AgentMessage[] {
    const seen = new Set<string>()
    const result: AgentMessage[] = []
    for (const message of messages) {
      const key = this.cursorKey(message.cursor)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(message)
    }
    return result.sort((a, b) => compareCursorAsc(a.cursor, b.cursor))
  }

  cursorKey(cursor: AgentCursor): string {
    return `${cursor.localId}:${cursor.createTime}:${cursor.sortSeq}`
  }

  getSearchIndexDb(): Database.Database | null {
    return this.openReadonly(join(this.getCacheBasePath(), 'chat_search_index.db'))
  }

  getMemoryDb(): Database.Database | null {
    return this.openReadonly(join(this.getCacheBasePath(), 'agent_memory.db'))
  }

  parseMemoryRow(row: Record<string, unknown>): AgentMemoryItem {
    return {
      id: Number(row.id || 0),
      sourceType: String(row.source_type || 'message'),
      sessionId: row.session_id == null ? null : String(row.session_id),
      title: String(row.title || ''),
      content: String(row.content || ''),
      importance: Number(row.importance || 0),
      confidence: Number(row.confidence || 0),
      timeStart: row.time_start == null ? null : Number(row.time_start),
      timeEnd: row.time_end == null ? null : Number(row.time_end),
      sourceRefs: parseMemoryRefs(row.source_refs_json),
      updatedAt: Number(row.updated_at || 0)
    }
  }

  close(): void {
    for (const db of this.dbCache.values()) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
    this.dbCache.clear()
    this.tableCache.clear()
    this.displayNameCache.clear()
    this.tableExistsCache.clear()
    this.myRowIdCache.clear()
  }
}

export const agentDataRepository = new AgentDataRepository()
