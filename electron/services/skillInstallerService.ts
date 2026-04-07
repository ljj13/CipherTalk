import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import AdmZip from 'adm-zip'

export type SupportedAgentKind = 'codex' | 'agents'

export interface SkillInstallTarget {
  agentKind: SupportedAgentKind
  agentLabel: string
  source: 'known' | 'discovered'
  skillsDir: string
  supported: boolean
  installed: boolean
  bundledVersion: string
  installedVersion?: string
  updateAvailable: boolean
  installPath?: string
  error?: string
}

type SkillSource = {
  name: string
  relativePath: string
}

type SkillMeta = {
  name: string
  version: string
  description?: string
}

const MANAGED_SKILLS: Record<string, SkillSource> = {
  'ct-mcp-copilot': {
    name: 'ct-mcp-copilot',
    relativePath: join('sikll', 'ct-mcp-copilot')
  }
}

function getHomeDir() {
  return homedir() || process.env.USERPROFILE || process.env.HOME || ''
}

function getKnownAgentTargets(): Array<{ agentKind: SupportedAgentKind; agentLabel: string; skillsDir: string; source: 'known' }> {
  const home = getHomeDir()
  if (!home) return []
  return [
    { agentKind: 'codex', agentLabel: 'Codex', skillsDir: join(home, '.codex', 'skills'), source: 'known' },
    { agentKind: 'agents', agentLabel: '.agents', skillsDir: join(home, '.agents', 'skills'), source: 'known' }
  ]
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const bParts = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const maxLen = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < maxLen; i += 1) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

export class SkillInstallerService {
  private readSkillMeta(skillDir: string): SkillMeta | null {
    try {
      const metaPath = join(skillDir, '.skill-meta.json')
      if (!existsSync(metaPath)) return null
      return JSON.parse(readFileSync(metaPath, 'utf8')) as SkillMeta
    } catch {
      return null
    }
  }

  private getSkillSourcePath(skillName: string): string | null {
    const source = MANAGED_SKILLS[skillName]
    if (!source) return null
    return join(app.getAppPath(), source.relativePath)
  }

  private getBundledVersion(skillName: string): string {
    const sourcePath = this.getSkillSourcePath(skillName)
    if (!sourcePath) return '0.0.0'
    return this.readSkillMeta(sourcePath)?.version || '0.0.0'
  }

  private collectDiscoveredSkillDirs(): Array<{ agentKind: SupportedAgentKind; agentLabel: string; skillsDir: string; source: 'discovered' }> {
    const home = getHomeDir()
    if (!home || !existsSync(home)) return []

    const results: Array<{ agentKind: SupportedAgentKind; agentLabel: string; skillsDir: string; source: 'discovered' }> = []
    const seen = new Set<string>()
    const projectRoot = app.getAppPath().toLowerCase()

    const addIfMatch = (candidate: string) => {
      const normalized = candidate.toLowerCase()
      if (seen.has(normalized)) return
      if (!existsSync(candidate)) return
      if (!statSync(candidate).isDirectory()) return
      if (!normalized.endsWith('\\skills') && !normalized.endsWith('/skills')) return
      if (normalized.includes(projectRoot)) return

      const parentHint = dirname(candidate).toLowerCase()
      if (!/(codex|agent|agents|claude)/.test(parentHint)) return

      seen.add(normalized)
      results.push({
        agentKind: /codex/.test(parentHint) ? 'codex' : 'agents',
        agentLabel: parentHint.includes('claude') ? '发现的 Claude/Agent Skills' : '发现的 Skills 目录',
        skillsDir: candidate,
        source: 'discovered'
      })
    }

    try {
      for (const entry of readdirSync(home, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('.')) continue
        const levelOne = join(home, entry.name)
        addIfMatch(join(levelOne, 'skills'))

        for (const nested of readdirSync(levelOne, { withFileTypes: true })) {
          if (!nested.isDirectory()) continue
          addIfMatch(join(levelOne, nested.name, 'skills'))
        }
      }
    } catch {
      // ignore scan errors
    }

    return results
  }

  detectTargets(skillName: string): SkillInstallTarget[] {
    const sourcePath = this.getSkillSourcePath(skillName)
    const hasSource = Boolean(sourcePath && existsSync(join(sourcePath, 'SKILL.md')))
    const bundledVersion = this.getBundledVersion(skillName)

    const mergedTargets = [...getKnownAgentTargets(), ...this.collectDiscoveredSkillDirs()]
      .filter((target, index, arr) => arr.findIndex((item) => item.skillsDir.toLowerCase() === target.skillsDir.toLowerCase()) === index)

    return mergedTargets.map(({ agentKind, agentLabel, skillsDir, source }) => {
      const installPath = join(skillsDir, skillName)
      const installed = existsSync(join(installPath, 'SKILL.md'))
      const installedVersion = installed ? (this.readSkillMeta(installPath)?.version || undefined) : undefined

      return {
        agentKind,
        agentLabel,
        source,
        skillsDir,
        supported: hasSource && Boolean(getHomeDir()),
        installed,
        bundledVersion,
        installedVersion,
        updateAvailable: Boolean(installedVersion && compareVersions(installedVersion, bundledVersion) < 0),
        installPath,
        error: hasSource ? undefined : `Skill source not found for ${skillName}`
      }
    })
  }

  installSkill(skillName: string): { success: boolean; results: SkillInstallTarget[]; error?: string } {
    const sourcePath = this.getSkillSourcePath(skillName)
    if (!sourcePath || !existsSync(join(sourcePath, 'SKILL.md'))) {
      return {
        success: false,
        error: `Skill source not found for ${skillName}`,
        results: this.detectTargets(skillName)
      }
    }

    const results = this.detectTargets(skillName).map((target) => {
      if (!target.supported || !target.installPath) {
        return {
          ...target,
          installed: false,
          error: target.error || 'Target is not supported on this device'
        }
      }

      try {
        mkdirSync(dirname(target.installPath), { recursive: true })
        if (existsSync(target.installPath)) {
          rmSync(target.installPath, { recursive: true, force: true })
        }
        mkdirSync(target.skillsDir, { recursive: true })
        cpSync(sourcePath, target.installPath, { recursive: true, force: true })
        const installedMeta = this.readSkillMeta(target.installPath)
        return {
          ...target,
          installed: true,
          installedVersion: installedMeta?.version || target.bundledVersion,
          updateAvailable: false,
          error: undefined
        }
      } catch (error) {
        return {
          ...target,
          installed: false,
          error: String(error)
        }
      }
    })

    return {
      success: results.some((item) => item.installed),
      results,
      error: results.every((item) => !item.installed)
        ? results.map((item) => `${item.agentLabel}: ${item.error || 'install failed'}`).join(' | ')
        : undefined
    }
  }

  exportSkillZip(skillName: string): { success: boolean; outputPath?: string; fileName?: string; version?: string; error?: string } {
    const sourcePath = this.getSkillSourcePath(skillName)
    if (!sourcePath || !existsSync(join(sourcePath, 'SKILL.md'))) {
      return { success: false, error: `Skill source not found for ${skillName}` }
    }

    try {
      const downloadsDir = app.getPath('downloads')
      const version = this.getBundledVersion(skillName)
      const fileName = `${skillName}-v${version}.zip`
      const outputPath = join(downloadsDir, fileName)
      const zip = new AdmZip()
      zip.addLocalFolder(sourcePath, skillName)
      zip.writeZip(outputPath)
      return { success: true, outputPath, fileName, version }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }
}

export const skillInstallerService = new SkillInstallerService()
