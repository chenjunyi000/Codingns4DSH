import type { HostScope } from '../shared/contracts/peer-host.js'
import type { CodingNsRpcClient } from './features/types.js'

export interface PeerHostEventSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message' | 'close' | 'error', listener: (...args: any[]) => void): void
}

export interface PeerHostEventSubscription {
  readonly close: () => void
}

export type PeerHostEventSocketFactory = (scope: HostScope) => Promise<PeerHostEventSocket>

export type PeerHostEventListener = (event: Record<string, unknown>) => void

export interface PeerHostProxyResponse {
  readonly status: number
  readonly headers: readonly [string, string][]
  readonly body: string
}

export interface PeerHostScopedClient {
  request(scope: HostScope, path: string, options?: { readonly method?: string; readonly body?: string }): Promise<PeerHostProxyResponse>
  loadSessionHistory(scope: HostScope, cursor?: string): Promise<PeerHostProxyResponse>
  sendMessage(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  stopSession(scope: HostScope): Promise<PeerHostProxyResponse>
  replyPermission(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  answerQuestion(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  readFile(scope: HostScope, path: string): Promise<PeerHostProxyResponse>
  writeFile(scope: HostScope, body: string): Promise<PeerHostProxyResponse>
  gitStatus(scope: HostScope): Promise<PeerHostProxyResponse>
  terminal(scope: HostScope, action: 'create' | 'input' | 'resize' | 'close', body?: string): Promise<PeerHostProxyResponse>
  rightTool(scope: HostScope, action: 'open' | 'refresh' | 'close', body?: string): Promise<PeerHostProxyResponse>
  /**
   * 接入已经完成 Host 侧升级握手的事件流。
   *
   * 当前 DSH WebServer 没有公开升级注册契约，因此调用方必须显式提供
   * socketFactory；没有可用传输时不允许退化成无作用域的全局订阅。
   */
  openEventStream(scope: HostScope, socketFactory: PeerHostEventSocketFactory, listener: PeerHostEventListener): Promise<PeerHostEventSubscription>
}

/** Client 侧远端资源适配器；每一次请求都从 HostScope 生成，不保存目标凭据。 */
export function createPeerHostScopedClient(rpc: CodingNsRpcClient): PeerHostScopedClient {
  const request = async (scope: HostScope, path: string, options: { readonly method?: string; readonly body?: string } = {}): Promise<PeerHostProxyResponse> => {
    assertPeerScope(scope)
    if (!path.startsWith('/api/') || path.includes('://')) throw new TypeError('PeerHost 代理路径必须是固定 API 路径')
    const result = await rpc.call('codingns', 'peerHost/request', {
      peerHostId: scope.targetHostId,
      scope,
      path,
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.body === undefined ? {} : { body: options.body }),
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value as PeerHostProxyResponse
  }
  return {
    request,
    loadSessionHistory: (scope, cursor) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/history${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`),
    sendMessage: (scope, body) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/messages`, { method: 'POST', body }),
    stopSession: (scope) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/stop`, { method: 'POST', body: '{}' }),
    replyPermission: (scope, body) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/permission`, { method: 'POST', body }),
    answerQuestion: (scope, body) => request(requireSession(scope), `/api/sessions/${encodeURIComponent(scope.sessionId!)}/answer`, { method: 'POST', body }),
    readFile: (scope, path) => request(scope, `/api/files?path=${encodeURIComponent(path)}`),
    writeFile: (scope, body) => request(scope, '/api/files', { method: 'PUT', body }),
    gitStatus: (scope) => request(scope, '/api/git/status'),
    terminal: (scope, action, body) => request(scope, `/api/terminal/${action}`, { method: 'POST', ...(body === undefined ? {} : { body }) }),
    rightTool: (scope, action, body) => request(scope, `/api/right-tools/${action}`, { method: 'POST', ...(body === undefined ? {} : { body }) }),
    openEventStream: (scope, socketFactory, listener) => openEventStream(scope, socketFactory, listener),
  }
}

const OPEN = 1
const PEER_HOST_EVENT_TYPES = new Set([
  'system.connected', 'workbench.snapshot', 'workbench.delta', 'fileTree.snapshot',
  'git.snapshot', 'session.subscribed', 'session.backfill', 'session.delta',
  'session.runtime_message', 'session.runtime_status', 'session.activity',
  'session.permission_request', 'session.error', 'terminal.output', 'terminal.status',
  'terminal.exit', 'terminal.error', 'rightTool.snapshot', 'rightTool.delta',
])

async function openEventStream(scope: HostScope, socketFactory: PeerHostEventSocketFactory, listener: PeerHostEventListener): Promise<PeerHostEventSubscription> {
  assertPeerScope(scope)
  const socket = await socketFactory(scope)
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    if (socket.readyState === OPEN) socket.close(1000, 'PeerHost 作用域已清理')
  }
  socket.on('message', (data: unknown, isBinary?: boolean) => {
    if (closed || isBinary === true || typeof data !== 'string') return
    const event = parseScopedEvent(data, scope)
    if (event !== null) listener(event)
  })
  socket.on('close', () => { closed = true })
  socket.on('error', close)
  return { close }
}

function parseScopedEvent(raw: string, expected: HostScope): Record<string, unknown> | null {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string' || !PEER_HOST_EVENT_TYPES.has(event.type)) return null
  if (event.hostId !== expected.hostId || event.targetHostId !== expected.targetHostId || event.workspaceId !== expected.workspaceId || event.scopeGeneration !== expected.scopeGeneration) return null
  if (expected.sessionId !== null && event.sessionId !== expected.sessionId) return null
  return event
}

function requireSession(scope: HostScope): HostScope {
  assertPeerScope(scope)
  if (scope.sessionId === null || scope.sessionId.trim() === '') throw new TypeError('会话操作必须包含 sessionId')
  return scope
}

function assertPeerScope(scope: HostScope): void {
  if (scope.targetHostId === null || scope.targetHostId.trim() === '') throw new TypeError('PeerHost 作用域必须包含 targetHostId')
  if (scope.hostId.trim() === '' || scope.workspaceId.trim() === '' || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0) throw new TypeError('PeerHost 作用域无效')
}
