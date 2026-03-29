import { basename, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'

export class DbPathService {
  async autoDetect(): Promise<{ success: boolean; path?: string; error?: string }> {
    try {
      for (const candidate of this.getPossibleRoots()) {
        if (!existsSync(candidate)) continue

        if (this.isAccountDir(candidate)) {
          return { success: true, path: candidate }
        }

        if (this.findAccountDirs(candidate).length > 0) {
          return { success: true, path: candidate }
        }
      }

      return { success: false, error: '未能自动检测到微信数据库目录' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  scanWxids(rootPath: string): string[] {
    try {
      if (this.isAccountDir(rootPath)) {
        return [basename(rootPath)]
      }
      return this.findAccountDirs(rootPath)
    } catch {
      return []
    }
  }

  getDefaultPath(): string {
    const home = homedir()
    if (process.platform === 'darwin') {
      const appSupportBase = join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Library',
        'Application Support',
        'com.tencent.xinWeChat'
      )

      for (const entry of this.safeReadDir(appSupportBase)) {
        if (this.isMacVersionDir(entry)) {
          return join(appSupportBase, entry)
        }
      }

      return join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files')
    }

    return join(home, 'Documents', 'xwechat_files')
  }

  private getPossibleRoots(): string[] {
    const home = homedir()
    const possiblePaths: string[] = []

    if (process.platform === 'darwin') {
      const appSupportBase = join(
        home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Library',
        'Application Support',
        'com.tencent.xinWeChat'
      )

      for (const entry of this.safeReadDir(appSupportBase)) {
        if (this.isMacVersionDir(entry)) {
          possiblePaths.push(join(appSupportBase, entry))
        }
      }

      possiblePaths.push(
        join(home, 'Library', 'Containers', 'com.tencent.xinWeChat', 'Data', 'Documents', 'xwechat_files'),
        join(home, 'Documents', 'xwechat_files'),
        join(home, 'Documents', 'WeChat Files')
      )
      return possiblePaths
    }

    return [
      join(home, 'Documents', 'xwechat_files'),
      join(home, 'Documents', 'WeChat Files')
    ]
  }

  private findAccountDirs(rootPath: string): string[] {
    const accounts: string[] = []

    try {
      for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!this.isPotentialAccountName(entry.name)) continue

        const entryPath = join(rootPath, entry.name)
        if (this.isAccountDir(entryPath)) {
          accounts.push(entry.name)
        }
      }
    } catch {
      // ignore
    }

    return accounts.sort((a, b) => {
      const aTime = this.getAccountModifiedTime(join(rootPath, a))
      const bTime = this.getAccountModifiedTime(join(rootPath, b))
      if (bTime !== aTime) return bTime - aTime
      return a.localeCompare(b)
    })
  }

  private isAccountDir(entryPath: string): boolean {
    return (
      existsSync(join(entryPath, 'db_storage')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image')) ||
      existsSync(join(entryPath, 'FileStorage', 'Image2')) ||
      existsSync(join(entryPath, 'msg', 'attach'))
    )
  }

  private isPotentialAccountName(name: string): boolean {
    const lower = name.toLowerCase()
    return !(
      lower.startsWith('all') ||
      lower.startsWith('applet') ||
      lower.startsWith('backup') ||
      lower.startsWith('wmpf') ||
      lower.startsWith('app_data')
    )
  }

  private isMacVersionDir(name: string): boolean {
    return /^\d+\.\d+b\d+\.\d+/.test(name) || /^\d+\.\d+\.\d+/.test(name)
  }

  private getAccountModifiedTime(entryPath: string): number {
    try {
      const accountStat = statSync(entryPath)
      let latest = accountStat.mtimeMs

      for (const candidate of [
        join(entryPath, 'db_storage'),
        join(entryPath, 'FileStorage', 'Image'),
        join(entryPath, 'FileStorage', 'Image2'),
        join(entryPath, 'msg', 'attach')
      ]) {
        if (existsSync(candidate)) {
          latest = Math.max(latest, statSync(candidate).mtimeMs)
        }
      }

      return latest
    } catch {
      return 0
    }
  }

  private safeReadDir(dirPath: string): string[] {
    try {
      if (!existsSync(dirPath)) return []
      return readdirSync(dirPath)
    } catch {
      return []
    }
  }
}

export const dbPathService = new DbPathService()
