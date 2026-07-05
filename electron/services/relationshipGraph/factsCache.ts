import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { RelationshipGraphLink, RelationshipGraphNode } from '../../../src/types/models'
import { getRelationshipGraphCacheDir } from './snapshot'

export interface RelationshipGraphGroupFacts {
  groupId: string
  selectedMemberIds: string[]
  memberMessageCounts: Record<string, number>
  memberLastActiveTimes: Record<string, number>
  links: RelationshipGraphLink[]
  skippedReason?: string
}

export interface RelationshipGraphFacts {
  key: string
  createdAt: number
  nodes: RelationshipGraphNode[]
  directLinks: RelationshipGraphLink[]
  groupFacts: RelationshipGraphGroupFacts[]
  diagnostics: {
    groupsConsidered: number
    groupsAccepted: number
    groupsSkipped: number
  }
}

type FactsFile = {
  version: 1
  entries: Record<string, RelationshipGraphFacts>
}

export class RelationshipGraphFactsCache {
  private readonly path: string

  constructor(cacheBaseDir: string) {
    this.path = join(getRelationshipGraphCacheDir(cacheBaseDir), 'relationship_graph_facts_cache.json')
  }

  get(key: string): RelationshipGraphFacts | null {
    const file = this.readFile()
    return file.entries[key] || null
  }

  put(key: string, facts: RelationshipGraphFacts): void {
    const file = this.readFile()
    file.entries[key] = { ...facts, key, createdAt: facts.createdAt || Date.now() }
    const entries = Object.entries(file.entries)
      .sort((a, b) => Number(b[1].createdAt || 0) - Number(a[1].createdAt || 0))
      .slice(0, 12)
    file.entries = Object.fromEntries(entries)
    this.writeFile(file)
  }

  private readFile(): FactsFile {
    try {
      if (!existsSync(this.path)) return { version: 1, entries: {} }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as FactsFile
      if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        return { version: 1, entries: {} }
      }
      return parsed
    } catch {
      return { version: 1, entries: {} }
    }
  }

  private writeFile(file: FactsFile): void {
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tempPath, JSON.stringify(file), 'utf8')
    try {
      renameSync(tempPath, this.path)
    } catch (error) {
      try { unlinkSync(tempPath) } catch { /* ignore */ }
      throw error
    }
  }
}
