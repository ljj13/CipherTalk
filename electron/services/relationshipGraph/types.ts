import type {
  RelationshipGraphData,
  RelationshipGraphDiagnostics,
  RelationshipGraphOptions,
  RelationshipGraphTaskInfo,
  RelationshipGraphTimeRange,
} from '../../../src/types/models'

export interface RelationshipGraphSnapshot {
  success: true
  graph: RelationshipGraphData
  diagnostics: RelationshipGraphDiagnostics
  timeRange: RelationshipGraphTimeRange
  algorithmVersion: string
  signature: string
  builtAt: number
}

export interface RelationshipGraphBuildRequest {
  taskId: string
  options: RelationshipGraphOptions
  expectedSignature: string
  cacheBaseDir: string
}

export interface RelationshipGraphBuildResult {
  snapshot: RelationshipGraphSnapshot
  task: RelationshipGraphTaskInfo
}
