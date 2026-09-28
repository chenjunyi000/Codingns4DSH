import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostManagementApi } from '../data/build/dist/client/peer-host-management-api.js'
import { startPeerHostManagementPanel } from '../data/build/dist/client/peer-host-management-panel.js'
import { createPeerHostScopedClient } from '../data/build/dist/client/peer-host-scoped-client.js'
import { toPeerHostClientRecord } from '../data/build/dist/host/features/peer-host.js'
import { HostRouter } from '../data/build/dist/client/host-router.js'
import { PeerHostSessionController } from '../data/build/dist/client/peer-host-session-controller.js'

test('PeerHost 管理 API 只向 Host RPC 发送目标 ID 和一次性登录参数', async () => {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const rpc = {
    async call(_channel: string, endpoint: string, payload: unknown) {
      calls.push({ endpoint, payload })
      if (endpoint === 'peerHost/list') return { ok: true as const, value: [] }
      if (endpoint === 'peerHost/login') return { ok: true as const, value: { peerHostId: 'peer-1', status: 'logged_in', expiresAt: 123 } }
      if (endpoint === 'peerHost/remove') return { ok: true as const, value: null }
      return { ok: true as const, value: { id: 'peer-1' } }
    },
  }
  const api = createPeerHostManagementApi(rpc)
  await api.list()
  await api.login({ peerHostId: 'peer-1', username: 'alice', password: 'password-secret' })
  await api.remove('peer-1')

  assert.deepEqual(calls.map((call) => call.endpoint), ['peerHost/list', 'peerHost/login', 'peerHost/remove'])
  assert.deepEqual(calls[1]?.payload, { peerHostId: 'peer-1', username: 'alice', password: 'password-secret' })
  assert.equal(JSON.stringify(calls[0]?.payload).includes('token'), false)
  assert.equal(JSON.stringify(calls[2]?.payload), JSON.stringify({ peerHostId: 'peer-1' }))
})

test('PeerHost 管理 API 将 Host 错误转换为可读异常', async () => {
  const api = createPeerHostManagementApi({
    async call() {
      return { ok: false as const, error: { code: 'PEER_HOST_NOT_READY', message: 'PeerHost 尚未准备好' } }
    },
  })
  await assert.rejects(api.check('peer-1'), /PeerHost 尚未准备好/u)
})

test('PeerHost 管理面板关闭后可重新打开，dispose 会移除事件监听和 DOM', async () => {
  const dom = new FakeDocument()
  const api = { list: async () => [] }
  const controller = startPeerHostManagementPanel({ document: dom as never, rpc: {} as never, api: api as never })
  dom.defaultView.dispatchEvent(new Event('codingns4dsh:peer-host-open'))
  await Promise.resolve()
  assert.equal(dom.body.children.length, 1)
  const first = dom.body.children[0]!
  const close = first.find((node) => node.tagName === 'BUTTON' && node.textContent === '关闭')
  assert.ok(close)
  close.dispatchEvent(new Event('click'))
  assert.equal(dom.body.children.length, 0)
  dom.defaultView.dispatchEvent(new Event('codingns4dsh:peer-host-open'))
  await Promise.resolve()
  assert.equal(dom.body.children.length, 1)
  controller.dispose()
  assert.equal(dom.body.children.length, 0)
  dom.defaultView.dispatchEvent(new Event('codingns4dsh:peer-host-open'))
  assert.equal(dom.body.children.length, 0)
})

test('PeerHost 作用域客户端为会话请求绑定完整 HostScope，不接受目标 URL', async () => {
  const calls: unknown[] = []
  const client = createPeerHostScopedClient({
    async call(_channel: string, endpoint: string, payload: unknown) {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: { status: 200, headers: [], body: '{}' } }
    },
  })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7 }
  await client.sendMessage(scope, '{"text":"hello"}')
  assert.deepEqual(calls, [{
    endpoint: 'peerHost/request',
    payload: {
      peerHostId: 'peer-1',
      scope,
      path: '/api/sessions/session-1/messages',
      method: 'POST',
      body: '{"text":"hello"}',
    },
  }])
  assert.throws(() => client.sendMessage({ ...scope, targetHostId: null }, '{}'), /必须包含 targetHostId/u)
  await assert.rejects(client.request(scope, 'https://target.example/api/sessions'), /固定 API 路径/u)
})

test('Host 返回的 PeerHost DTO 不包含完整路由地址或 fingerprint', () => {
  const value = toPeerHostClientRecord({
    id: 'peer-1', ownerUserId: 'user-1', displayName: '开发机',
    route: { kind: 'lan', baseUrl: 'http://192.168.1.20:13080', normalizedOrigin: 'http://192.168.1.20:13080' },
    status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:full-fingerprint-secret', lastCheckedAt: 1, lastErrorCode: null, createdAt: 1, updatedAt: 1,
  })
  assert.deepEqual(value.route, { kind: 'lan' })
  assert.equal(value.fingerprint, 'sha256:f...cret')
  assert.equal(JSON.stringify(value).includes('192.168.1.20'), false)
  assert.equal(JSON.stringify(value).includes('full-fingerprint-secret'), false)
})

test('PeerHost 事件流只接收同一 HostScope 的白名单事件，并可在关闭时清理', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  let closed = false
  const socket = {
    readyState: 1,
    send() {},
    close() { closed = true },
    on(event: string, listener: (...args: any[]) => void) { listeners.set(event, listener) },
  }
  const received: Record<string, unknown>[] = []
  const client = createPeerHostScopedClient({ async call() { return { ok: true as const, value: { status: 200, headers: [], body: '{}' } } } })
  const scope = { hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7 }
  const subscription = await client.openEventStream(scope, async () => socket, (event) => received.push(event))
  listeners.get('message')?.(JSON.stringify({ type: 'session.delta', hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7, body: 'ok' }))
  listeners.get('message')?.(JSON.stringify({ type: 'session.delta', hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 6, body: 'stale' }))
  listeners.get('message')?.(JSON.stringify({ type: 'unregistered', hostId: 'host-local', targetHostId: 'peer-1', workspaceId: 'workspace-1', sessionId: 'session-1', scopeGeneration: 7 }))
  assert.equal(received.length, 1)
  assert.equal(received[0]?.body, 'ok')
  subscription.close()
  assert.equal(closed, true)
})

test('PeerHost 会话控制器切换作用域后拒绝旧历史结果并清理旧订阅', async () => {
  let resolveHistory: ((value: unknown) => void) | undefined
  let closeCount = 0
  const client = {
    async loadSessionHistory() { return await new Promise((resolve) => { resolveHistory = resolve }) as never },
    async sendMessage() { return { status: 200, headers: [], body: '{}' } },
    async stopSession() { return { status: 200, headers: [], body: '{}' } },
    async replyPermission() { return { status: 200, headers: [], body: '{}' } },
    async answerQuestion() { return { status: 200, headers: [], body: '{}' } },
    async openEventStream() { return { close: () => { closeCount += 1 } } },
  }
  const router = new HostRouter()
  const controller = new PeerHostSessionController(router, client as never)
  const first = await controller.select({ hostId: 'host', targetHostId: 'peer-1', workspaceId: 'w', sessionId: 's-1' })
  const pending = controller.loadHistory(first)
  const second = await controller.select({ hostId: 'host', targetHostId: 'peer-1', workspaceId: 'w', sessionId: 's-2' })
  resolveHistory?.({ status: 200, headers: [], body: '{}' })
  await assert.rejects(pending, /HostScope 已失效/u)
  await controller.subscribe(second, async () => ({ readyState: 1, send() {}, close() { closeCount += 1 }, on() {} }), () => undefined)
  await router.clear()
  assert.equal(closeCount, 1)
})

class FakeElement {
  readonly children: FakeElement[] = []
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Set<(event: Event) => void>>()
  parentElement: FakeElement | null = null
  ownerDocument!: FakeDocument
  tagName: string
  textContent = ''
  value = ''
  type = ''
  required = false
  hidden = false

  constructor(tagName: string) { this.tagName = tagName.toUpperCase() }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) { node.parentElement = this; node.ownerDocument = this.ownerDocument; this.children.push(node) }
  }

  remove(): void {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }

  addEventListener(name: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(name) ?? new Set<(event: Event) => void>()
    listeners.add(listener)
    this.listeners.set(name, listeners)
  }

  removeEventListener(name: string, listener: (event: Event) => void): void { this.listeners.get(name)?.delete(listener) }

  dispatchEvent(event: Event): void { for (const listener of this.listeners.get(event.type) ?? []) listener(event) }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    for (const child of this.children) {
      if (matches(child, selector)) return child as T
      const nested = child.querySelector<T>(selector)
      if (nested !== null) return nested
    }
    return null
  }

  find(predicate: (node: FakeElement) => boolean): FakeElement | null {
    for (const child of this.children) { if (predicate(child)) return child; const nested = child.find(predicate); if (nested !== null) return nested }
    return null
  }
}

class FakeDocument {
  readonly body = new FakeElement('body')
  readonly defaultView = new FakeElement('window')

  constructor() {
    this.body.ownerDocument = this
    this.defaultView.ownerDocument = this
    this.defaultView.prompt = () => null
    this.defaultView.confirm = () => false
  }

  createElement(tagName: string): FakeElement { const element = new FakeElement(tagName); element.ownerDocument = this; return element }
}

function matches(element: FakeElement, selector: string): boolean {
  const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(selector)
  if (attribute === null) return false
  return element.attributes.has(attribute[1]!) && (attribute[2] === undefined || element.attributes.get(attribute[1]!) === attribute[2])
}
