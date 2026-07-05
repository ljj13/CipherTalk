import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { RelationshipGraphScope, RelationshipGraphTimeRangePreset } from '../../../src/types/models'
import { DEFAULT_GRAPH_SCOPE, DEFAULT_TIME_RANGE_PRESET } from './constants'
import type { RelationshipGraphSnapshot } from './types'

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function safeToken(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-')
}

export function getRelationshipGraphCacheDir(cacheBaseDir: string): string {
  const dir = join(cacheBaseDir, 'relationship-graph')
  ensureDir(dir)
  return dir
}

export function getRelationshipGraphSnapshotPath(
  cacheBaseDir: string,
  preset: RelationshipGraphTimeRangePreset = DEFAULT_TIME_RANGE_PRESET,
  scope: RelationshipGraphScope = DEFAULT_GRAPH_SCOPE,
): string {
  const dir = getRelationshipGraphCacheDir(cacheBaseDir)
  if (preset === DEFAULT_TIME_RANGE_PRESET && scope === DEFAULT_GRAPH_SCOPE) {
    return join(dir, 'relationship_graph_snapshot.json')
  }
  return join(dir, `relationship_graph_snapshot_${safeToken(preset)}_${safeToken(scope)}.json`)
}

export function readRelationshipGraphSnapshot(path: string): RelationshipGraphSnapshot | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RelationshipGraphSnapshot
    if (!parsed?.graph || !Array.isArray(parsed.graph.nodes) || !Array.isArray(parsed.graph.links)) return null
    return parsed
  } catch {
    return null
  }
}

export function writeRelationshipGraphSnapshot(path: string, snapshot: RelationshipGraphSnapshot): void {
  ensureDir(dirname(path))
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, JSON.stringify(snapshot), 'utf8')
  try {
    renameSync(tempPath, path)
  } catch (error) {
    try { unlinkSync(tempPath) } catch { /* ignore */ }
    throw error
  }
}
