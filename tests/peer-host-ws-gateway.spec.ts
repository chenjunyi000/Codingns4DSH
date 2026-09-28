import assert from 'node:assert/strict'
import test from 'node:test'
import WebSocket from 'ws'
import { PeerHostWebSocketGateway, PEER_HOST_WS_PATH } from '../data/build/dist/host/modules/peer-host/peer-host-ws-gateway.js'

test('插件自有 PeerHost WebSocket 网关只接受固定路径并能清理连接', async (t) => {
  let connected = 0
  let cleaned = 0
  const gateway = new PeerHostWebSocketGateway({
    listenHost: '127.0.0.1',
    listenPort: 0,
    authorizeUpgrade: () => true,
    onConnection: (socket) => {
      connected += 1
      socket.on('message', (value) => socket.send(String(value)))
      return () => { cleaned += 1 }
    },
  })
  let endpoint
  try { endpoint = await gateway.start() } catch (error) {
    if (isListenPermissionError(error)) { t.skip('当前测试环境禁止监听本地端口'); return }
    throw error
  }
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${PEER_HOST_WS_PATH}`)
  await onceOpen(socket)
  const echoed = onceMessage(socket)
  socket.send('scope')
  assert.equal(await echoed, 'scope')
  assert.equal(connected, 1)
  await gateway.close()
  assert.equal(cleaned, 1)
  assert.equal(socket.readyState, WebSocket.CLOSED)
})

test('插件自有 PeerHost WebSocket 网关拒绝未授权 upgrade', async (t) => {
  const gateway = new PeerHostWebSocketGateway({
    listenHost: '127.0.0.1',
    listenPort: 0,
    authorizeUpgrade: () => false,
    onConnection: () => undefined,
  })
  let endpoint
  try { endpoint = await gateway.start() } catch (error) {
    if (isListenPermissionError(error)) { t.skip('当前测试环境禁止监听本地端口'); return }
    throw error
  }
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${PEER_HOST_WS_PATH}`)
  await assert.rejects(onceOpen(socket), /Unexpected server response: 401/u)
  await gateway.close()
})

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
}

function isListenPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'EPERM'
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (value) => resolve(value.toString()))
    socket.once('error', reject)
  })
}
