import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createPeerHostRelayConnector,
  PeerHostReconnectManager,
} from '../data/build/dist/host/modules/peer-host/peer-host-relay.js'

const record = {
  id: 'peer-relay-1',
  ownerUserId: 'local-host',
  displayName: 'relay',
  route: { kind: 'relay', deviceId: 'device-1', relayEntryId: 'entry-1', transportVersion: 'dsh-envelope-v1' },
  status: 'ready',
} as any

const scope = {
  hostId: 'host-local',
  targetHostId: 'peer-relay-1',
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  scopeGeneration: 7,
} as const

class FakeSocket {
  readyState = 1
  readonly closed: string[] = []
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>()
  on(event: 'message' | 'close' | 'error', listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  send(_value: string): void {}
  close(_code?: number, reason?: string): void { this.readyState = 3; this.closed.push(reason ?? '') ; this.emit('close') }
  emit(event: 'close' | 'error', ...args: any[]): void { for (const listener of this.listeners.get(event) ?? []) listener(...args) }
}

test('relay connector 未注入已验证 Transport 时保持不可用', async () => {
  const connector = createPeerHostRelayConnector()
  await assert.rejects(connector(record, 'short-lived-token', scope), (error: any) => error.code === 'PEER_HOST_RELAY_UNAVAILABLE')
})

test('relay connector 只接受匹配 transportVersion 的 Host 适配器', async () => {
  const socket = new FakeSocket()
  const seen: any[] = []
  const connector = createPeerHostRelayConnector({ transport: {
    transportVersion: 'other-version',
    open: async (input) => { seen.push(input); return socket as any },
  } })
  await assert.rejects(connector(record, 'short-lived-token', scope), (error: any) => error.code === 'PEER_HOST_RELAY_UNAVAILABLE')
  assert.equal(seen.length, 0)
})

test('reconnect manager 断线使用有界退避并重建 generation', async () => {
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = []
  const sockets: FakeSocket[] = []
  const generations: number[] = []
  const manager = new PeerHostReconnectManager({
    connect: async (_record, _token, nextScope) => {
      generations.push(nextScope.scopeGeneration)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as any
    },
    initialDelayMs: 10,
    maxDelayMs: 20,
    maxAttempts: 3,
    setTimer: (callback, delay) => { const item = { callback, delay, cleared: false }; timers.push(item); return item as any },
    clearTimer: (timer: any) => { timer.cleared = true },
  })
  const first = await manager.connect(record, 'ephemeral-token', scope)
  assert.deepEqual(generations, [7])
  first.close(1011, 'network')
  assert.equal(manager.snapshot(record.id)?.state, 'reconnecting')
  assert.equal(timers[0]?.delay, 10)
  timers[0]!.callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(generations, [7, 8])
  assert.equal(manager.snapshot(record.id)?.state, 'ready')
  await manager.close()
  assert.equal(manager.snapshot(record.id), null)
})

test('reconnect manager 达到重试上限后不再创建无限计时器', async () => {
  const timers: Array<{ callback: () => void; delay: number }> = []
  let attempts = 0
  const manager = new PeerHostReconnectManager({
    connect: async () => { attempts += 1; throw new Error('offline') },
    maxAttempts: 2,
    initialDelayMs: 10,
    maxDelayMs: 20,
    setTimer: (callback, delay) => { const item = { callback, delay }; timers.push(item); return item as any },
    clearTimer: () => undefined,
  })
  await assert.rejects(manager.connect(record, 'ephemeral-token', scope))
  timers[0]!.callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(attempts, 2)
  assert.equal(manager.snapshot(record.id)?.state, 'unreachable')
  assert.equal(timers.length, 1)
  await manager.close()
})
