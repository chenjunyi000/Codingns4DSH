import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'

export const PEER_HOST_WS_PATH = '/api/codingns/peer-host/ws'

export interface PeerHostWsGatewayEndpoint {
  readonly host: string
  readonly port: number
  readonly path: string
}

export interface PeerHostWsGatewayOptions {
  readonly listenHost?: string
  readonly listenPort?: number
  readonly path?: string
  readonly authorizeUpgrade?: (request: IncomingMessage) => boolean | Promise<boolean>
  readonly onConnection: (socket: WebSocket, request: IncomingMessage) => void | Promise<void | (() => void)>
}

/** 插件自有的 WebSocket upgrade 入口，不修改 DSH WebServer。 */
export class PeerHostWebSocketGateway {
  private readonly server: Server
  private readonly websocketServer: WebSocketServer
  private readonly path: string
  private readonly listenHost: string
  private readonly listenPort: number
  private readonly cleanups = new Map<WebSocket, () => void>()
  private endpointValue: PeerHostWsGatewayEndpoint | null = null
  private closed = false

  constructor(private readonly options: PeerHostWsGatewayOptions) {
    this.path = normalizePath(options.path ?? PEER_HOST_WS_PATH)
    this.listenHost = normalizeHost(options.listenHost ?? '127.0.0.1')
    this.listenPort = normalizePort(options.listenPort ?? 0)
    this.server = createServer((_request, response) => {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'PeerHost WebSocket 入口只接受 upgrade 请求' }))
    })
    this.websocketServer = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 256 * 1024 })
    this.server.on('upgrade', (request, socket, head) => { void this.handleUpgrade(request, socket, head) })
  }

  async start(): Promise<PeerHostWsGatewayEndpoint> {
    if (this.endpointValue !== null) return this.endpointValue
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { this.server.removeListener('listening', onListening); reject(error) }
      const onListening = (): void => { this.server.removeListener('error', onError); resolve() }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen({ host: this.listenHost, port: this.listenPort })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('PeerHost WebSocket 监听器未返回有效端口')
    this.endpointValue = { host: this.listenHost, port: address.port, path: this.path }
    return this.endpointValue
  }

  endpoint(): PeerHostWsGatewayEndpoint | null { return this.endpointValue }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const closing: Promise<void>[] = []
    for (const [socket, cleanup] of this.cleanups) {
      cleanup()
      if (socket.readyState === WebSocket.CLOSED) continue
      closing.push(new Promise<void>((resolve) => {
        const timeout = setTimeout(() => socket.terminate(), 1000)
        socket.once('close', () => {
          clearTimeout(timeout)
          resolve()
        })
        socket.close(1001, 'PeerHost WebSocket 网关已关闭')
      }))
    }
    this.cleanups.clear()
    this.websocketServer.close()
    await Promise.all(closing)
    // 让远端 ws 客户端先处理 TCP FIN，再向调用方返回已关闭状态。
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    await new Promise<void>((resolve) => {
      if (!this.server.listening) { resolve(); return }
      this.server.close(() => resolve())
    })
    this.endpointValue = null
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.closed || request.method !== 'GET' || readPath(request.url) !== this.path) {
      rejectUpgrade(socket, 404, 'PeerHost WebSocket 路径不存在')
      return
    }
    try {
      if (this.options.authorizeUpgrade !== undefined && !(await this.options.authorizeUpgrade(request))) {
        rejectUpgrade(socket, 401, 'PeerHost WebSocket 未授权')
        return
      }
    } catch {
      rejectUpgrade(socket, 401, 'PeerHost WebSocket 未授权')
      return
    }
    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.websocketServer.emit('connection', websocket, request)
      void this.attach(websocket, request)
    })
  }

  private async attach(socket: WebSocket, request: IncomingMessage): Promise<void> {
    let cleanup: (() => void) | undefined
    try {
      const result = this.options.onConnection(socket, request)
      if (result instanceof Promise) {
        const resolved = await result
        cleanup = typeof resolved === 'function' ? resolved : undefined
      } else if (typeof result === 'function') {
        cleanup = result
      }
      this.cleanups.set(socket, cleanup ?? (() => undefined))
    } catch {
      socket.close(1011, 'PeerHost WebSocket 连接失败')
      cleanup?.()
      return
    }
    socket.once('close', () => {
      const current = this.cleanups.get(socket)
      if (current !== undefined) current()
      this.cleanups.delete(socket)
    })
  }
}

function normalizePath(value: string): string {
  const path = value.trim()
  if (!/^\/api\/[A-Za-z0-9_./-]+$/u.test(path) || path.includes('..')) throw new TypeError('PeerHost WebSocket 路径无效')
  return path
}

function normalizeHost(value: string): string {
  const host = value.trim()
  if (host === '') throw new TypeError('PeerHost WebSocket 监听地址不能为空')
  return host
}

function normalizePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) throw new TypeError('PeerHost WebSocket 监听端口无效')
  return value
}

function readPath(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined) return null
  try { return new URL(rawUrl, 'http://peer-host.invalid').pathname } catch { return null }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return
  const statusText = status === 401 ? 'Unauthorized' : 'Not Found'
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`)
}
