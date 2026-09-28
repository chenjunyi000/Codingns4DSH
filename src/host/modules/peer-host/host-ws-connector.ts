import WebSocket from 'ws'
import type { HostScope, PeerHostRecord } from '../../../shared/contracts/peer-host.js'
import type { PeerHostRemoteConnector, PeerHostSocket } from './host-ws-proxy-service.js'

/** DSH 原生工作台 WebSocket 的固定入口；不接受客户端传入路径。 */
export const PEER_HOST_REMOTE_WS_PATH = '/ws'

export interface PeerHostRawWebSocket {
  readonly readyState: number
  on(event: 'open' | 'message' | 'close' | 'error' | 'unexpected-response', listener: (...args: any[]) => void): unknown
  once(event: 'open' | 'close' | 'error' | 'unexpected-response', listener: (...args: any[]) => void): unknown
  off?(event: 'open' | 'close' | 'error' | 'unexpected-response', listener: (...args: any[]) => void): unknown
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate?(): void
}

export class PeerHostConnectorError extends Error {
  constructor(readonly code: 'PEER_HOST_SESSION_REQUIRED' | 'PEER_HOST_PROXY_UNREACHABLE' | 'PEER_HOST_RELAY_UNAVAILABLE', message: string) {
    super(message)
    this.name = 'PeerHostConnectorError'
  }
}

export interface PeerHostWsConnectorOptions {
  readonly timeoutMs?: number
  readonly websocketFactory?: (url: string, options: { readonly headers: Readonly<Record<string, string>> }) => PeerHostRawWebSocket
}

/**
 * 创建当前 Host 到目标 DSH 的 LAN 工作台 connector。
 *
 * 目标 URL、access token 和 WebSocket 路径均由 Host 侧生成；Client 只能通过
 * 上层代理提交 HostScope。目标 DSH 的消息白名单仍由 `PeerHostWsProxyService`
 * 在双端转发前执行，这里只负责固定端点的认证握手和消息类型的文本适配。
 */
export function createPeerHostRemoteConnector(options: PeerHostWsConnectorOptions = {}): PeerHostRemoteConnector {
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError('PeerHost WebSocket connector 超时时间无效')
  const websocketFactory = options.websocketFactory ?? ((url, init) => new WebSocket(url, { headers: init.headers }) as unknown as PeerHostRawWebSocket)
  return async (record, accessToken, scope) => {
    if (record.route.kind !== 'lan') throw new PeerHostConnectorError('PEER_HOST_RELAY_UNAVAILABLE', '中转 PeerHost 暂不支持 Host-to-Host WebSocket')
    if (accessToken.trim() === '') throw new Error('PeerHost 目标登录态为空')
    assertScope(scope, record.id)
    const url = buildRemoteWebSocketUrl(record.route.normalizedOrigin, accessToken)
    const socket = websocketFactory(url, { headers: { authorization: `Bearer ${accessToken}` } })
    await waitForOpen(socket, timeoutMs)
    return adaptSocket(socket)
  }
}

function buildRemoteWebSocketUrl(origin: string, accessToken: string): string {
  const url = new URL(PEER_HOST_REMOTE_WS_PATH, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('access_token', accessToken)
  return url.toString()
}

function assertScope(scope: HostScope, peerHostId: string): void {
  if (scope.targetHostId !== peerHostId || scope.hostId.trim() === '' || scope.workspaceId.trim() === '' || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0) throw new Error('PeerHost connector 作用域无效')
  if (scope.sessionId !== null && scope.sessionId.trim() === '') throw new Error('PeerHost connector 会话作用域无效')
}

async function waitForOpen(socket: PeerHostRawWebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === 1) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      remove(socket, 'open', onOpen)
      remove(socket, 'error', onError)
      remove(socket, 'close', onClose)
      remove(socket, 'unexpected-response', onUnexpectedResponse)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onOpen = (): void => finish()
    const onError = (): void => finish(new PeerHostConnectorError('PEER_HOST_PROXY_UNREACHABLE', '目标 Host WebSocket 连接失败'))
    const onClose = (): void => finish(new PeerHostConnectorError('PEER_HOST_PROXY_UNREACHABLE', '目标 Host WebSocket 在打开前关闭'))
    const onUnexpectedResponse = (_request: unknown, response: { readonly statusCode?: number }): void => {
      const code = response.statusCode === 401 || response.statusCode === 403 ? 'PEER_HOST_SESSION_REQUIRED' : 'PEER_HOST_PROXY_UNREACHABLE'
      finish(new PeerHostConnectorError(code, code === 'PEER_HOST_SESSION_REQUIRED' ? '目标 Host 登录态已失效' : '目标 Host WebSocket 握手失败'))
    }
    const timer = setTimeout(() => {
      socket.terminate?.()
      finish(new PeerHostConnectorError('PEER_HOST_PROXY_UNREACHABLE', '目标 Host WebSocket 连接超时'))
    }, timeoutMs)
    socket.once('open', onOpen)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.once('unexpected-response', onUnexpectedResponse)
  })
}

function adaptSocket(socket: PeerHostRawWebSocket): PeerHostSocket {
  return {
    get readyState() { return socket.readyState },
    send(data: string): void { socket.send(data) },
    close(code?: number, reason?: string): void { socket.close(code, reason) },
    on(event, listener): void {
      if (event === 'message') {
        socket.on('message', (value: unknown, isBinary?: boolean) => listener(toText(value), isBinary))
        return
      }
      socket.on(event, (...args: any[]) => listener(...args))
    },
  }
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  return String(value)
}

function remove(socket: PeerHostRawWebSocket, event: 'open' | 'close' | 'error' | 'unexpected-response', listener: (...args: any[]) => void): void {
  socket.off?.(event, listener)
}
