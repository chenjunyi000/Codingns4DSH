import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve } from 'node:path'
import type { SessionChangedFiles } from '../shared/contracts/file-management.js'
import type { CodingNsHostServices } from './features/types.js'

const PATH_KEYS = new Set([
  'path', 'paths', 'filePath', 'file_path', 'srcPath', 'src_path',
  'dstPath', 'dst_path', 'oldPath', 'old_path', 'newPath', 'new_path',
  'sourcePath', 'source_path', 'targetPath', 'target_path',
])

/** 优先从 DSH 原生 Session 事件读取，原生事件不可用时回退到 JSONL。 */
export async function readSessionChangedFiles(
  services: CodingNsHostServices,
  sessionId: string,
  workspaceRoot: string,
): Promise<SessionChangedFiles> {
  let session = services.nativeSessions?.get(sessionId)
  if (session === undefined && services.nativeSessions?.listRemote !== undefined) {
    try {
      const candidates = await services.nativeSessions.listRemote()
      session = candidates.find((candidate) => sessionIdentity(candidate) === sessionId)
    } catch {
      // 原生列表接口不可用时继续走 JSONL 降级。
    }
  }
  const root = resolve(workspaceRoot)
  const nativeEvents = snapshotEvents(session)
  const nativePaths = extractToolPaths(nativeEvents, root)
  if (nativePaths.size > 0) return { paths: [...nativePaths].sort() }

  const jsonlPath = findJsonlReference(session)
  if (jsonlPath === undefined) return { paths: [] }
  try {
    const content = await readFile(jsonlPath, 'utf8')
    const events = content.split(/\r?\n/u).flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line)
        return [parsed]
      } catch {
        return []
      }
    })
    return { paths: [...extractToolPaths(events, root)].sort() }
  } catch {
    // JSONL 是降级数据源；文件不存在或不可读时保持可解释的空结果。
    return { paths: [] }
  }
}

function snapshotEvents(value: unknown): readonly unknown[] {
  if (!isRecord(value)) return []
  if (typeof value.snapshotEvents === 'function') {
    try {
      const events: unknown = value.snapshotEvents()
      if (Array.isArray(events)) return events
    } catch {
      // 单个会话损坏时继续尝试其内嵌事件数组。
    }
  }
  return Array.isArray(value.events) ? value.events : []
}

function extractToolPaths(events: readonly unknown[], workspaceRoot: string): Set<string> {
  const paths = new Set<string>()
  for (const candidate of events) {
    const event = isRecord(candidate) ? candidate : undefined
    if (event === undefined) continue
    const data = isRecord(event.data) ? event.data : event
    if (event.type === 'tool/call') {
      collectInputPaths(data.arguments, workspaceRoot, paths)
      continue
    }
    if (event.type === 'tool/result') {
      collectInputPaths(data.meta, workspaceRoot, paths)
      continue
    }
    if (event.type !== 'assistant/message') continue
    const message = isRecord(data.message) ? data.message : undefined
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool-call') continue
      collectInputPaths(block.arguments, workspaceRoot, paths)
    }
  }
  return paths
}

function collectInputPaths(value: unknown, workspaceRoot: string, paths: Set<string>): void {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) {
      for (const item of value) collectInputPaths(item, workspaceRoot, paths)
      return
    }
    if (isRecord(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (typeof nested === 'string' && PATH_KEYS.has(key)) addPath(nested, workspaceRoot, paths)
        else collectInputPaths(nested, workspaceRoot, paths)
      }
    }
    return
  }
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    for (const line of trimmed.split(/\r?\n/u)) {
      const match = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/u.exec(line)
        ?? /^\*\*\* Move to:\s+(.+)$/u.exec(line)
      if (match?.[1] !== undefined) addPath(match[1], workspaceRoot, paths)
    }
    return
  }
  try { collectInputPaths(JSON.parse(trimmed) as unknown, workspaceRoot, paths) } catch {
    // 工具参数不是 JSON 时只使用 apply_patch 文本格式。
  }
}

function addPath(value: string, workspaceRoot: string, paths: Set<string>): void {
  const trimmed = value.trim().replace(/^['"]+|['"]+$/gu, '')
  if (trimmed === '' || trimmed === '.' || trimmed === './') return
  const candidate = isAbsolute(trimmed) ? normalize(trimmed) : resolve(workspaceRoot, trimmed)
  const relativePath = relative(workspaceRoot, candidate).replaceAll('\\', '/')
  if (relativePath === '' || relativePath.startsWith('../') || isAbsolute(relativePath)) return
  paths.add(relativePath.replace(/^\.\//u, ''))
}

function findJsonlReference(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) return undefined
  for (const key of ['rawStoreRef', 'jsonlPath', 'sessionPath', 'filePath']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && /\.jsonl(?:\.zstd)?$/u.test(candidate.trim())) return candidate.trim()
  }
  for (const nested of Object.values(value)) {
    const result = findJsonlReference(nested, depth + 1)
    if (result !== undefined) return result
  }
  return undefined
}

function sessionIdentity(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  for (const key of ['sessionId', 'id']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  const header = value.header
  return isRecord(header) && typeof header.id === 'string' ? header.id.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
