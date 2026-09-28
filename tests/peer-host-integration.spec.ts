import assert from 'node:assert/strict'
import test from 'node:test'
import { PeerHostAggregateService } from '../data/build/dist/host/modules/peer-host/peer-host-aggregate-service.js'
import { HostRouter } from '../data/build/dist/client/host-router.js'
import { PeerHostSessionController } from '../data/build/dist/client/peer-host-session-controller.js'
import { createPeerHostScopedClient } from '../data/build/dist/client/peer-host-scoped-client.js'
import { createDshCapabilityRegistry } from '../data/build/dist/index.js'

test('多 Host 集成 fixture 保持摘要隔离、单 Host 故障隔离和目标路由隔离', async () => {
  const aggregate = new PeerHostAggregateService(100)
  const results = await aggregate.load([
    {
      hostId: 'host-local', targetHostId: null, hostLabel: '当前 Host',
      load: async () => [{ workspaceId: 'workspace-1', displayName: '项目', sessions: [{ sessionId: 'session-1', title: '当前会话', status: 'ready', updatedAt: 1 }] }],
    },
    {
      hostId: 'peer-lan', targetHostId: 'peer-lan', hostLabel: '局域网 Host',
      load: async () => [{ workspaceId: 'workspace-1', displayName: '项目', sessions: [{ sessionId: 'session-1', title: '远端会话', status: 'ready', updatedAt: 2 }] }],
    },
    {
      hostId: 'peer-down', targetHostId: 'peer-down', hostLabel: '离线 Host',
      load: async () => { throw new Error('network down') },
    },
  ])

  assert.equal(results.length, 3)
  assert.equal(results[2]?.availability, 'unreachable')
  assert.notEqual(results[0]?.workspaces[0]?.key, results[1]?.workspaces[0]?.key)
  assert.notDeepEqual(results[0]?.workspaces[0]?.sessions[0]?.scope, results[1]?.workspaces[0]?.sessions[0]?.scope)

  const calls: unknown[] = []
  const client = createPeerHostScopedClient({
    async call(_channel, endpoint, payload) {
      calls.push({ endpoint, payload })
      return { ok: true as const, value: { status: 200, headers: [], body: '{}' } }
    },
  })
  const router = new HostRouter()
  const controller = new PeerHostSessionController(router, client)
  const scope = await controller.select({ hostId: 'peer-lan', targetHostId: 'peer-lan', workspaceId: 'workspace-1', sessionId: 'session-1' })
  await controller.sendMessage(scope, '{"text":"远端"}')
  assert.equal((calls[0] as { payload: { peerHostId: string } }).payload.peerHostId, 'peer-lan')
  assert.equal(JSON.stringify(calls[0]).includes('baseUrl'), false)
  await router.clear()
})

test('三版本 PeerHost fixture 通过集中式能力边界保持导航和中转降级语义', () => {
  const fixtures = [
    {
      version: '0.1.5-rc.3',
      clientContext: { peerHostRemoteWebContextFallback: {} },
      nativeStatus: 'unavailable',
      fallbackStatus: 'ready',
    },
    {
      version: '0.1.6-alpha.2',
      clientContext: { peerHostRemoteWebContextFallback: {} },
      nativeStatus: 'unavailable',
      fallbackStatus: 'ready',
    },
    {
      version: '0.1.7-rc.2',
      clientContext: { peerHostNativeNavigation: {} },
      nativeStatus: 'ready',
      fallbackStatus: 'unavailable',
    },
  ] as const

  for (const fixture of fixtures) {
    const hostContext = {
      peerHostStore: {},
      peerHostHandshake: {},
      peerHostHttpProxy: {},
      peerHostWsProxy: {},
      peerHostAggregate: {},
    }
    const hostProfile = createDshCapabilityRegistry(fixture.version, 'host', hostContext).getProfile(hostContext)
    assert.equal(hostProfile.capabilities.get('peer-host.store')?.status, 'ready')
    assert.equal(hostProfile.capabilities.get('peer-host.aggregate')?.status, 'ready')
    assert.equal(hostProfile.capabilities.get('peer-host.relay-route')?.status, 'unavailable')

    const clientProfile = createDshCapabilityRegistry(fixture.version, 'client', fixture.clientContext).getProfile(fixture.clientContext)
    assert.equal(clientProfile.capabilities.get('peer-host.native-navigation')?.status, fixture.nativeStatus)
    assert.equal(clientProfile.capabilities.get('peer-host.remote-web-context-fallback')?.status, fixture.fallbackStatus)
  }
})
