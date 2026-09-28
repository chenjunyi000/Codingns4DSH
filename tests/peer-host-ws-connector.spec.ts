import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostRemoteConnector, PEER_HOST_REMOTE_WS_PATH } from '../data/build/dist/host/modules/peer-host/host-ws-connector.js'

class FakeRawSocket {
  readyState = 0
  readonly sent: string[] = []
  readonly closed: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  once(event: string, listener: (...args: any[]) => void): void {
    const wrapped = (...args: any[]): void => {
      this.off(event, wrapped)
      listener(...args)
    }
    this.on(event, wrapped)
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
  }

  send(value: string): void { this.sent.push(value) }
  close(code?: number, reason?: string): void { this.readyState = 3; this.closed.push({ code, reason }) }
  emit(event: string, ...args: any[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
}

const record = {
  id: 'peer-1',
  route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: 'http://127.0.0.1:13080' },
} as const

const scope = {
  hostId: 'host-local',
  targetHostId: 'peer-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  scopeGeneration: 4,
} as const

test('LAN connector 只连接固定 DSH /ws 入口，并在 Host 出站握手注入 token', async () => {
  const socket = new FakeRawSocket()
  let capturedUrl = ''
  let capturedHeaders: Record<string, string> | undefined
  const connector = createPeerHostRemoteConnector({
    websocketFactory: (url, options) => {
      capturedUrl = url
      capturedHeaders = { ...options.headers }
      queueMicrotask(() => { socket.readyState = 1; socket.emit('open') })
      return socket
    },
  })
  const remote = await connector(record, 'access-secret', scope)
  const parsed = new URL(capturedUrl)
  assert.equal(`${parsed.protocol}//${parsed.host}${parsed.pathname}`, 'ws://127.0.0.1:13080' + PEER_HOST_REMOTE_WS_PATH)
  assert.equal(parsed.searchParams.get('access_token'), 'access-secret')
  assert.deepEqual(capturedHeaders, { authorization: 'Bearer access-secret' })
  remote.send('{"type":"session.subscribe"}')
  assert.deepEqual(socket.sent, ['{"type":"session.subscribe"}'])
})

test('LAN connector 拒绝不属于目标 PeerHost 的作用域和中转路由', async () => {
  const connector = createPeerHostRemoteConnector({ websocketFactory: () => { throw new Error('不应建立连接') } })
  await assert.rejects(connector(record, 'secret', { ...scope, targetHostId: 'peer-2' }), /作用域无效/u)
  await assert.rejects(connector({ id: 'peer-1', route: { kind: 'relay', deviceId: 'device', relayEntryId: 'entry', transportVersion: 'v1' } } as never, 'secret', scope), /中转 PeerHost/u)
})

test('LAN connector 在目标 Host 未打开 WebSocket 时有界失败', async () => {
  const socket = new FakeRawSocket()
  const connector = createPeerHostRemoteConnector({ timeoutMs: 10, websocketFactory: () => socket })
  await assert.rejects(connector(record, 'secret', scope), /超时/u)
  assert.equal(socket.readyState, 0)
})

test('LAN connector 将目标 401/403 握手映射为登录态失效', async () => {
  const socket = new FakeRawSocket()
  const connector = createPeerHostRemoteConnector({
    websocketFactory: () => {
      queueMicrotask(() => socket.emit('unexpected-response', {}, { statusCode: 401 }))
      return socket
    },
  })
  await assert.rejects(connector(record, 'expired-secret', scope), /登录态已失效/u)
})
