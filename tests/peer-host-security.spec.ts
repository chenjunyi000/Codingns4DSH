import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostHttpProxyService, PEER_HOST_HTTP_PROXY_RULES } from '../data/build/dist/host/modules/peer-host/host-api-proxy-service.js'

test('HTTP 代理白名单不包含认证、管理、插件安装和递归代理路径', () => {
  const prefixes = PEER_HOST_HTTP_PROXY_RULES.map((rule) => rule.prefix)
  assert.equal(prefixes.some((prefix) => prefix.includes('/auth')), false)
  assert.equal(prefixes.some((prefix) => prefix.includes('/host-proxy')), false)
  assert.equal(prefixes.some((prefix) => prefix.includes('/plugins')), false)
  assert.equal(prefixes.some((prefix) => prefix.includes('/admin')), false)
})

test('代理错误不回显 token、密码或完整目标 URL', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await store.updateHandshake('peer-1', { status: 'ready', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:first', lastCheckedAt: 100, lastErrorCode: null })
  const service = new PeerHostHttpProxyService(store, { getAccessToken: async () => 'access-secret' } as never, { fetchImpl: async () => { throw new Error('upstream access-secret password-secret') } })
  const result = await service.handle('peer-1', new Request('http://current.test/api/workspaces?workspaceId=workspace-1', {
    headers: {
      'x-codingns-host-id': 'host-local',
      'x-codingns-target-host-id': 'peer-1',
      'x-codingns-workspace-id': 'workspace-1',
      'x-codingns-scope-generation': '1',
      authorization: 'Bearer client-secret',
    },
  }))
  const body = JSON.stringify(await result.json())
  assert.doesNotMatch(body, /access-secret|client-secret|password-secret|127\.0\.0\.1/u)
})
