import { createElement, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { GitChangeItem, GitDiff, GitStatus } from '../shared/contracts/git.js'
import type { SessionChangedFiles } from '../shared/contracts/file-management.js'
import type { CodingNsRpcClient } from './features/types.js'
import { callCodingNsRpc } from './settings-bridge.js'
import { resolveGitWorkspaceId } from './git-management.js'

export const SESSION_CHANGED_FILES_VIEW_ID = 'codingns4dsh/session-changed-files'

interface SessionChangedFilesViewRegistration {
  readonly dispose: () => void
}

interface SessionChangedFilesViewProps {
  readonly sessionId: string
  readonly rpc: CodingNsRpcClient
  readonly remote?: unknown
}

interface DirectoryNode {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: readonly TreeNode[]
}

interface FileNode {
  readonly kind: 'file'
  readonly name: string
  readonly change: GitChangeItem
}

type TreeNode = DirectoryNode | FileNode
interface MutableDirectory {
  kind: 'directory'
  name: string
  path: string
  children: Map<string, MutableDirectory | FileNode>
}

/** 会话“修改文件”视图；数据只通过插件 RPC 和现有 Git RPC 读取。 */
export function SessionChangedFilesView(props: SessionChangedFilesViewProps): ReactElement {
  const [workspaceId, setWorkspaceId] = useState<string>()
  const [changes, setChanges] = useState<readonly GitChangeItem[]>([])
  const [selectedPath, setSelectedPath] = useState<string>()
  const [diff, setDiff] = useState<GitDiff>()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [hoveredPath, setHoveredPath] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const resolved = await resolveGitWorkspaceId(props.remote, props.sessionId)
      if (resolved === undefined) throw new Error('当前会话没有可用的工作区')
      const [sessionFiles, status] = await Promise.all([
        call<SessionChangedFiles>(props.rpc, 'fileManagement/session-changes', { sessionId: props.sessionId, workspaceId: resolved }),
        call<GitStatus>(props.rpc, 'git/status', { workspaceId: resolved }),
      ])
      const touched = new Set(sessionFiles.paths.map(normalizePath))
      const next = status.changes.filter((item) => touched.has(normalizePath(item.path)) || item.oldPath !== null && touched.has(normalizePath(item.oldPath)))
      setWorkspaceId(resolved)
      setChanges(next)
      setSelectedPath((current) => current !== undefined && next.some((item) => item.path === current) ? current : next[0]?.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setChanges([])
      setWorkspaceId(undefined)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setDiff(undefined)
    setCollapsed(new Set())
    void load()
    const timer = globalThis.setInterval(() => { void load() }, 5_000)
    return () => globalThis.clearInterval(timer)
  }, [props.sessionId, props.remote])

  useEffect(() => {
    if (workspaceId === undefined || selectedPath === undefined) {
      setDiff(undefined)
      return
    }
    const selected = changes.find((item) => item.path === selectedPath)
    if (selected === undefined) return
    let cancelled = false
    void call<GitDiff>(props.rpc, 'git/diff', { workspaceId, path: selected.path, staged: selected.staged })
      .then((value) => { if (!cancelled) setDiff(value) })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [changes, props.rpc, selectedPath, workspaceId])

  const tree = useMemo(() => buildTree(changes), [changes])
  const unstaged = changes.filter((item) => !item.staged)
  const stageTargets = async (targets: readonly string[], action: 'stage' | 'unstage' | 'discard'): Promise<void> => {
    if (workspaceId === undefined || targets.length === 0) return
    setBusy(true)
    try {
      await call<GitStatus>(props.rpc, `git/${action}`, { workspaceId, targets })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return createElement('div', { style: rootStyle },
    createElement('div', { style: toolbarStyle },
      createElement('strong', { style: { fontSize: 15 } }, '修改文件'),
      createElement('span', { style: countStyle }, `${changes.length} 个文件`),
      createElement('span', { style: { flex: 1 } }),
      createElement('button', { type: 'button', disabled: loading || busy, onClick: () => void load(), style: buttonStyle }, '刷新'),
      createElement('button', { type: 'button', disabled: busy || unstaged.length === 0, onClick: () => void stageTargets(unstaged.map((item) => item.path), 'stage'), style: primaryButtonStyle }, '全部暂存'),
    ),
    error === undefined ? null : createElement('div', { role: 'alert', style: errorStyle }, error),
    createElement('div', { style: contentStyle },
      createElement('div', { style: treePaneStyle },
        loading ? createElement('div', { style: emptyStyle }, '正在读取会话修改…')
          : changes.length === 0 ? createElement('div', { style: emptyStyle }, '本次会话没有已识别的修改文件')
            : tree.map((node) => renderNode(node, 0, collapsed, hoveredPath, selectedPath, toggle, setSelectedPath, setHoveredPath, stageTargets)),
      ),
      createElement('div', { style: diffPaneStyle },
        selectedPath === undefined ? createElement('div', { style: emptyStyle }, '选择文件查看 Diff')
          : createElement('pre', { style: diffStyle }, diff?.content || '当前文件没有可显示的 Diff'),
      ),
    ),
  )
}

/** 注册 DSH 原生 conversation.view Slot；标签由 DSH 根据 Slot 的 id/label 自动投影。 */
export function registerSessionChangedFilesView(ctx: unknown, rpc: CodingNsRpcClient, remote?: unknown): (() => void) | undefined {
  const runtime = globalThis as typeof globalThis & {
    __CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__?: SessionChangedFilesViewRegistration
  }
  // DSH 热重启可能先保留旧 Context 的 Slot；复用旧注册避免 id 冲突。
  if (runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__ !== undefined) return undefined
  const value = asRecord(ctx)
  const slots = value?.slots as { inject?: (key: string, callback: () => unknown) => (() => void) } | undefined
  if (typeof slots?.inject !== 'function') return undefined
  let disposeSlot: (() => void) | undefined
  try {
    disposeSlot = slots.inject('conversation.view', () => {
      const register = (slots as { register?: (options: unknown, component: unknown) => () => void }).register
      if (typeof register !== 'function') return () => undefined
      return register({
        name: 'conversation.view',
        id: SESSION_CHANGED_FILES_VIEW_ID,
        order: 100,
        label: () => '修改文件',
        inject: () => ({ rpc, remote }),
      }, SessionChangedFilesView)
    })
  } catch (error) {
    if (isDuplicateRegistrationError(error)) {
      disposeSlot?.()
      return undefined
    }
    disposeSlot?.()
    throw error
  }
  const dispose = (): void => {
    disposeSlot?.()
    if (runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__?.dispose === dispose) {
      delete runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__
    }
  }
  runtime.__CODINGNS4DSH_SESSION_CHANGED_FILES_VIEW__ = { dispose }
  return dispose
}

function isDuplicateRegistrationError(error: unknown): boolean {
  return error instanceof Error && /already registered|已注册/u.test(error.message)
}

function renderNode(
  node: TreeNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  hoveredPath: string | undefined,
  selectedPath: string | undefined,
  toggle: (path: string) => void,
  select: (path: string) => void,
  hover: (path: string | undefined) => void,
  stageTargets: (targets: readonly string[], action: 'stage' | 'unstage' | 'discard') => Promise<void>,
): ReactElement {
  if (node.kind === 'directory') {
    const expanded = !collapsed.has(node.path)
    const files = flattenFiles(node)
    return createElement('div', { key: `directory:${node.path}` },
      createElement('div', { style: rowStyle(depth), onMouseEnter: () => hover(node.path), onMouseLeave: () => hover(undefined) },
        createElement('button', { type: 'button', onClick: () => toggle(node.path), style: treeButtonStyle }, `${expanded ? '⌄' : '›'} ${node.name}`),
        hoveredPath === node.path ? createElement('button', { type: 'button', title: '暂存目录', disabled: files.every((item) => item.staged), onClick: () => void stageTargets(files.filter((item) => !item.staged).map((item) => item.path), 'stage'), style: iconButtonStyle }, '+') : null,
      ),
      expanded ? createElement('div', null, node.children.map((child) => renderNode(child, depth + 1, collapsed, hoveredPath, selectedPath, toggle, select, hover, stageTargets))) : null,
    )
  }
  const item = node.change
  const isHovered = hoveredPath === item.path
  return createElement('div', { key: `file:${item.path}`, style: { ...rowStyle(depth), ...(selectedPath === item.path ? selectedRowStyle : {}) }, onMouseEnter: () => hover(item.path), onMouseLeave: () => hover(undefined) },
    createElement('button', { type: 'button', onClick: () => select(item.path), style: fileButtonStyle },
      createElement('span', { style: fileIconStyle }, fileIcon(node.name)),
      createElement('span', { style: fileNameStyle, title: item.path }, node.name),
      createElement('span', { style: statusStyle }, item.status),
    ),
    isHovered ? createElement('span', { style: actionsStyle },
      createElement('button', { type: 'button', title: item.staged ? '撤销暂存' : '添加到暂存区', onClick: () => void stageTargets([item.path], item.staged ? 'unstage' : 'stage'), style: iconButtonStyle }, item.staged ? '↶' : '+'),
      createElement('button', { type: 'button', title: '撤销变更', disabled: item.staged, onClick: () => void stageTargets([item.path], 'discard'), style: dangerButtonStyle }, '×'),
    ) : null,
  )
}

function buildTree(changes: readonly GitChangeItem[]): readonly TreeNode[] {
  const root = new Map<string, MutableDirectory | FileNode>()
  for (const change of changes) {
    const parts = normalizePath(change.path).split('/').filter(Boolean)
    let entries = root
    let currentPath = ''
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part
      const key = index === parts.length - 1 ? `file:${currentPath}` : `directory:${currentPath}`
      if (index === parts.length - 1) entries.set(key, { kind: 'file', name: part, change })
      else {
        const existing = entries.get(key)
        const directory: MutableDirectory = existing?.kind === 'directory'
          ? existing
          : { kind: 'directory', name: part, path: currentPath, children: new Map() }
        entries.set(key, directory)
        entries = directory.children
      }
    })
  }
  return sortNodes(finalizeTree([...root.values()]))
}

function finalizeTree(nodes: readonly (MutableDirectory | FileNode)[]): TreeNode[] {
  return nodes.map((node) => node.kind === 'directory'
    ? { kind: 'directory', name: node.name, path: node.path, children: finalizeTree([...node.children.values()]) }
    : node)
}

function sortNodes(nodes: readonly TreeNode[]): readonly TreeNode[] {
  return [...nodes].sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name, 'zh-CN') : left.kind === 'directory' ? -1 : 1).map((node) => node.kind === 'directory' ? { ...node, children: sortNodes(node.children) } : node)
}

function flattenFiles(node: DirectoryNode): readonly GitChangeItem[] {
  return node.children.flatMap((child) => child.kind === 'directory' ? flattenFiles(child) : [child.change])
}

function normalizePath(value: string): string { return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '') }
function fileIcon(name: string): string { return name.split('.').pop()?.slice(0, 2).toUpperCase() || 'F' }
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined }
async function call<T>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> { return await callCodingNsRpc<T>(rpc, endpoint, payload) }

const rootStyle: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsw-alias-label-primary,inherit)', background: 'var(--dsw-alias-bg-base,transparent)', fontSize: 13 }
const toolbarStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l3,#ddd)', flex: '0 0 auto' }
const countStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary,#777)' }
const contentStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(260px, 42%) minmax(0, 1fr)', flex: '1 1 auto', minHeight: 0 }
const treePaneStyle: CSSProperties = { overflow: 'auto', padding: '8px 0', borderRight: '1px solid var(--dsw-alias-border-l3,#ddd)' }
const diffPaneStyle: CSSProperties = { overflow: 'auto', minWidth: 0, background: 'var(--dsw-alias-bg-layer-1,transparent)' }
const rowStyle = (depth: number): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 4, minHeight: 34, padding: `2px 8px ${2}px ${12 + depth * 16}px` })
const treeButtonStyle: CSSProperties = { border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left', flex: 1, minWidth: 0, padding: '5px 2px', fontWeight: 600 }
const fileButtonStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left', flex: 1, minWidth: 0, padding: '4px 2px' }
const selectedRowStyle: CSSProperties = { background: 'var(--dsw-alias-interactive-bg-selected,rgba(80,120,200,.16))' }
const fileIconStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 20, borderRadius: 4, color: 'var(--dsw-alias-state-business-primary,#356ae6)', background: 'var(--dsw-alias-interactive-bg-selected,rgba(80,120,200,.14))', fontSize: 10, fontWeight: 700, flex: '0 0 22px' }
const fileNameStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }
const statusStyle: CSSProperties = { color: 'var(--dsw-alias-label-tertiary,#777)', flex: '0 0 auto', fontWeight: 700 }
const actionsStyle: CSSProperties = { display: 'inline-flex', gap: 2, flex: '0 0 auto' }
const iconButtonStyle: CSSProperties = { width: 26, height: 26, border: '1px solid var(--dsw-alias-border-l2,#ccc)', borderRadius: 5, background: 'var(--dsw-alias-bg-layer-1,transparent)', color: 'inherit', cursor: 'pointer' }
const dangerButtonStyle: CSSProperties = { ...iconButtonStyle, color: 'var(--dsw-alias-state-danger,#c43d3d)' }
const buttonStyle: CSSProperties = { border: '1px solid var(--dsw-alias-border-l2,#ccc)', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: '6px 10px', font: 'inherit' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, background: 'var(--dsw-alias-interactive-bg-selected,rgba(80,120,200,.18))' }
const emptyStyle: CSSProperties = { padding: 24, color: 'var(--dsw-alias-label-tertiary,#777)', textAlign: 'center' }
const errorStyle: CSSProperties = { padding: '8px 16px', color: 'var(--dsw-alias-state-danger,#c43d3d)', borderBottom: '1px solid var(--dsw-alias-border-l3,#ddd)' }
const diffStyle: CSSProperties = { margin: 0, padding: 16, minHeight: '100%', whiteSpace: 'pre-wrap', wordBreak: 'break-word', font: '12px/1.55 var(--dsw-font-mono,ui-monospace,monospace)' }
