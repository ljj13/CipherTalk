import type { RelationshipGraphOptions, RelationshipGraphTimeRange, RelationshipGraphTimeRangePreset } from '../../../src/types/models'
import { DEFAULT_TIME_RANGE_PRESET } from './constants'

const YEAR_SECONDS = 365 * 24 * 60 * 60
const PRESET_YEARS: Record<Exclude<RelationshipGraphTimeRangePreset, 'all'>, number> = {
  '1y': 1,
  '2y': 2,
  '3y': 3,
  '5y': 5,
}

function normalizeSeconds(value?: number): number | undefined {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

export function resolveRelationshipTimeRange(
  options: RelationshipGraphOptions = {},
  nowSeconds = Math.floor(Date.now() / 1000),
): RelationshipGraphTimeRange {
  const preset = options.timeRangePreset || DEFAULT_TIME_RANGE_PRESET
  const explicitStart = normalizeSeconds(options.startTime)
  const explicitEnd = normalizeSeconds(options.endTime)
  const endTime = explicitEnd || nowSeconds
  const startTime = explicitStart || (preset === 'all' ? undefined : endTime - PRESET_YEARS[preset] * YEAR_SECONDS)

  return {
    preset,
    startTime,
    endTime,
  }
}

export function timeRangeKey(range: RelationshipGraphTimeRange): string {
  return `${range.preset}:${range.startTime || 0}:${range.endTime || 0}`
}
