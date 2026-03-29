import { basename, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { app } from 'electron'

export class WcdbService {
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null

  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbFreeString: any = null
  private wcdbGetLogs: any = null
  private wcdbGetSnsTimeline: any = null
  private wcdbExecQuery: any = null

  private getLibraryPath(): string {
    const baseDir = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')

    if (process.platform === 'darwin') {
      return join(baseDir, 'macos', 'libwcdb_api.dylib')
    }

    return join(baseDir, 'wcdb_api.dll')
  }

  private getWindowsCoreLibraryPath(): string {
    const baseDir = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(app.getAppPath(), 'resources')

    return join(baseDir, 'WCDB.dll')
  }

  private findSessionDb(dir: string, depth = 0): string | null {
    if (depth > 5) return null

    try {
      const entries = readdirSync(dir)

      for (const entry of entries) {
        if (entry.toLowerCase() === 'session.db') {
          const fullPath = join(dir, entry)
          if (statSync(fullPath).isFile()) {
            return fullPath
          }
        }
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            const found = this.findSessionDb(fullPath, depth + 1)
            if (found) return found
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      console.error('查找 session.db 失败:', e)
    }

    return null
  }

  private normalizeWxid(wxid: string): string {
    const trimmed = String(wxid || '').trim()
    if (!trimmed) return ''

    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      return match?.[1] || trimmed
    }

    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch ? suffixMatch[1] : trimmed
  }

  private isAccountDir(dirPath: string): boolean {
    return (
      existsSync(join(dirPath, 'db_storage')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image')) ||
      existsSync(join(dirPath, 'FileStorage', 'Image2')) ||
      existsSync(join(dirPath, 'msg', 'attach'))
    )
  }

  private resolveAccountRoot(dbPath: string, wxid: string): string | null {
    const normalizedDbPath = dbPath.replace(/[\\/]+$/, '')
    const direct = join(normalizedDbPath, wxid)
    if (existsSync(direct) && this.isAccountDir(direct)) {
      return direct
    }

    const normalizedWxid = this.normalizeWxid(wxid)
    const directNormalized = join(normalizedDbPath, normalizedWxid)
    if (existsSync(directNormalized) && this.isAccountDir(directNormalized)) {
      return directNormalized
    }

    if (this.isAccountDir(normalizedDbPath) && basename(normalizedDbPath) === wxid) {
      return normalizedDbPath
    }

    if (this.isAccountDir(normalizedDbPath) && basename(normalizedDbPath) === normalizedWxid) {
      return normalizedDbPath
    }

    try {
      for (const entry of readdirSync(normalizedDbPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const entryPath = join(normalizedDbPath, entry.name)
        if (!this.isAccountDir(entryPath)) continue

        const lowerEntry = entry.name.toLowerCase()
        const lowerWxid = wxid.toLowerCase()
        const lowerNormalizedWxid = normalizedWxid.toLowerCase()
        const cleanedEntry = this.normalizeWxid(entry.name).toLowerCase()

        if (
          lowerEntry === lowerWxid ||
          lowerEntry === lowerNormalizedWxid ||
          cleanedEntry === lowerWxid ||
          cleanedEntry === lowerNormalizedWxid ||
          lowerEntry.startsWith(`${lowerWxid}_`) ||
          lowerEntry.startsWith(`${lowerNormalizedWxid}_`)
        ) {
          return entryPath
        }
      }
    } catch {
      // ignore
    }

    return null
  }

  private resolveDbStoragePath(dbPath: string, wxid: string): string | null {
    const normalizedDbPath = dbPath.replace(/[\\/]+$/, '')
    if (basename(normalizedDbPath).toLowerCase() === 'db_storage' && existsSync(normalizedDbPath)) {
      return normalizedDbPath
    }

    const accountRoot = this.resolveAccountRoot(normalizedDbPath, wxid)
    if (!accountRoot) return null

    const dbStoragePath = join(accountRoot, 'db_storage')
    return existsSync(dbStoragePath) ? dbStoragePath : null
  }

  private async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) return { success: true }

    try {
      this.koffi = require('koffi')
      const libraryPath = this.getLibraryPath()

      if (!existsSync(libraryPath)) {
        return { success: false, error: `WCDB 原生库不存在: ${libraryPath}` }
      }

      if (process.platform === 'win32') {
        const wcdbCorePath = this.getWindowsCoreLibraryPath()
        if (existsSync(wcdbCorePath)) {
          try {
            this.koffi.load(wcdbCorePath)
          } catch (e: any) {
            console.warn('预加载 WCDB.dll 失败:', e.message || e)
          }
        }
      }

      this.lib = this.koffi.load(libraryPath)
      this.wcdbInit = this.lib.func('int32 wcdb_init()')
      this.wcdbShutdown = this.lib.func('int32 wcdb_shutdown()')
      this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')
      this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')
      this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)')
      this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
      this.wcdbGetSnsTimeline = this.lib.func('int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)')
      this.wcdbExecQuery = this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)')

      const initResult = this.wcdbInit()
      if (initResult !== 0) {
        return { success: false, error: `wcdb_init() 返回错误码: ${initResult}` }
      }

      this.initialized = true
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `WCDB 初始化异常: ${e.message}` }
    }
  }

  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      const initRes = await this.initialize()
      if (!initRes.success) {
        return { success: false, error: initRes.error || 'WCDB 初始化失败' }
      }

      const dbStoragePath = this.resolveDbStoragePath(dbPath, wxid)
      if (!dbStoragePath) {
        return { success: false, error: `未找到账号目录或 db_storage: ${dbPath}` }
      }

      const sessionDbPath = this.findSessionDb(dbStoragePath)
      if (!sessionDbPath) {
        return { success: false, error: '未找到 session.db 文件' }
      }

      const handleOut = [0]
      const result = this.wcdbOpenAccount(sessionDbPath, hexKey, handleOut)
      if (result !== 0) {
        await this.printLogs()
        return { success: false, error: this.mapStatusCode(result) }
      }

      const handle = handleOut[0]
      if (handle <= 0) {
        return { success: false, error: '无效的数据库句柄' }
      }

      this.handle = handle
      return { success: true, sessionCount: 0 }
    } catch (e) {
      console.error('测试连接异常:', e)
      return { success: false, error: String(e) }
    }
  }

  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    const result = await this.testConnection(dbPath, hexKey, wxid)
    return result.success
  }

  close(): void {
    if (this.handle !== null && this.wcdbCloseAccount) {
      try {
        this.wcdbCloseAccount(this.handle)
      } catch (e) {
        console.error('关闭 WCDB 句柄失败:', e)
      }
    }

    if (this.initialized && this.wcdbShutdown) {
      try {
        this.wcdbShutdown()
      } catch (e) {
        console.error('WCDB shutdown 失败:', e)
      }
    }

    this.handle = null
    this.initialized = false
    this.lib = null
  }

  shutdown(): void {
    this.close()
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }

    try {
      const outJson = [null]
      const usernamesJson = usernames && usernames.length > 0 ? JSON.stringify(usernames) : ''
      const result = this.wcdbGetSnsTimeline(
        this.handle,
        limit,
        offset,
        usernamesJson,
        keyword || '',
        startTime || 0,
        endTime || 0,
        outJson
      )

      if (result !== 0) {
        return { success: false, error: this.mapStatusCode(result) }
      }

      if (!outJson[0]) {
        return { success: true, timeline: [] }
      }

      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, timeline: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  async execQuery(kind: string, path: string, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }

    try {
      const outJson = [null]
      const result = this.wcdbExecQuery(this.handle, kind, path || '', sql, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }

      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  async decryptSnsImage(encryptedData: Buffer, _key: string): Promise<Buffer> {
    return encryptedData
  }

  async decryptSnsVideo(encryptedData: Buffer, _key: string): Promise<Buffer> {
    return encryptedData
  }

  private async printLogs(): Promise<void> {
    try {
      if (!this.wcdbGetLogs) return
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
        console.error('WCDB 内部日志:', jsonStr)
        this.wcdbFreeString(outPtr[0])
      }
    } catch (e) {
      console.error('获取 WCDB 日志失败:', e)
    }
  }

  private mapStatusCode(code: number): string {
    switch (code) {
      case 0:
        return '成功'
      case -1:
        return '参数错误'
      case -2:
        return '密钥错误'
      case -3:
      case -4:
        return '数据库打开失败'
      case -5:
        return '查询执行失败'
      case -6:
        return 'WCDB 尚未初始化'
      default:
        return `WCDB 错误码: ${code}`
    }
  }
}

export const wcdbService = new WcdbService()
