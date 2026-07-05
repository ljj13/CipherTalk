import { existsSync, statSync } from 'fs'
import { basename } from 'path'
import { chatService } from '../chatService'
import { findDbByName, findMessageDbPaths, findSessionDbPath } from '../dbStoragePaths'
import type { RelationshipGraphOptions, RelationshipGraphScope, RelationshipGraphTimeRange } from '../../../src/types/models'
import { DEFAULT_GRAPH_SCOPE, RELATIONSHIP_GRAPH_ALGORITHM_VERSION } from './constants'
import { buildRelationshipGraphFactsCacheKey, buildRelationshipGraphSignature, sha256Short } from './signature'

type FileVersionItem = {
  name: string
  size: number
  mtimeMs: number
}

function fileVersion(path: string | null): FileVersionItem | null {
  if (!path || !existsSync(path)) return null
  try {
    const stat = statSync(path)
    return {
      name: basename(path),
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    }
  } catch {
    return null
  }
}

function hashFileVersions(paths: string[]): string {
  const items = paths
    .map(fileVersion)
    .filter(Boolean)
    .sort((a, b) => a!.name.localeCompare(b!.name))
  return sha256Short(JSON.stringify(items))
}

export interface CurrentRelationshipGraphSignature {
  algorithmVersion: string
  currentWxid: string
  dbVersion: string
  contactVersion: string
  groupMetadataVersion: string
  factsCacheKey: string
  signature: string
  graphScope: RelationshipGraphScope
}

export async function buildCurrentRelationshipGraphSignature(
  options: RelationshipGraphOptions,
  timeRange: RelationshipGraphTimeRange,
): Promise<CurrentRelationshipGraphSignature> {
  const myInfo = await chatService.getMyUserInfo()
  if (!myInfo.success || !myInfo.userInfo?.wxid) {
    throw new Error(myInfo.error || '请先连接微信数据库')
  }

  const messageDbPaths = findMessageDbPaths()
  const dbVersion = hashFileVersions(messageDbPaths)
  const sessionVersion = fileVersion(findSessionDbPath())
  const contactVersion = sha256Short(JSON.stringify([
    fileVersion(findDbByName('contact.db')),
    sessionVersion,
  ]))
  const groupMetadataVersion = sha256Short(JSON.stringify([
    fileVersion(findDbByName('contact.db')),
    sessionVersion,
  ]))
  const graphScope = options.graphScope || DEFAULT_GRAPH_SCOPE
  const algorithmVersion = RELATIONSHIP_GRAPH_ALGORITHM_VERSION
  const factsCacheKey = buildRelationshipGraphFactsCacheKey({
    algorithmVersion,
    timeRange,
    dbVersion,
  })
  const signature = buildRelationshipGraphSignature({
    algorithmVersion,
    timeRange,
    graphScope,
    currentWxid: myInfo.userInfo.wxid,
    dbVersion,
    contactVersion,
    groupMetadataVersion,
  })

  return {
    algorithmVersion,
    currentWxid: myInfo.userInfo.wxid,
    dbVersion,
    contactVersion,
    groupMetadataVersion,
    factsCacheKey,
    signature,
    graphScope,
  }
}
