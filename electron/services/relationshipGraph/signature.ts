import * as crypto from 'crypto'
import type { RelationshipGraphTimeRange } from '../../../src/types/models'

export interface RelationshipGraphSignatureInput {
  algorithmVersion: string
  timeRange: RelationshipGraphTimeRange
  graphScope: string
  currentWxid: string
  dbVersion: string
  contactVersion: string
  groupMetadataVersion: string
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256Short(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function buildRelationshipGraphSignature(input: RelationshipGraphSignatureInput): string {
  return sha256Short(stableStringify(input))
}

export function buildRelationshipGraphFactsCacheKey(input: Pick<RelationshipGraphSignatureInput, 'algorithmVersion' | 'timeRange' | 'dbVersion'>): string {
  return sha256Short(stableStringify(input))
}
