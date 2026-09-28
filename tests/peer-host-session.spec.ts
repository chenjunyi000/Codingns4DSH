import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostHandshakeService } from '../data/build/dist/host/modules/peer-host/peer-host-handshake.js'
import { PeerHostSessionService } from '../data/build/dist/host/modules/peer-host/peer-host-session.js'

function response(value: unknown, status = 200): Response {
  return new Response(value === null ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function setup(fetchImpl: typeof fetch) {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 1_000, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  const handshake = new PeerHostHandshakeService(store, credentials, {
    productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', apiCompatibility: 'peer-host-v1', isDshVersionSupported: () => true,
    fetchImpl: async () => response({ productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', dshVersion: '0.1.6-alpha.2', apiCompatibility: 'peer-host-v1', fingerprint: 'sha256:first', capabilities: [] }),
    now: () => 1_000,
  })
  await handshake.check('peer-1')
  return { store, credentials, service: new PeerHostSessionService(store, credentials, { fetchImpl, now: () => 1_000, refreshSkewMs: 30_000 }) }
}

test('目标登录 token 只写入 Host 凭据存储，Client 仅得到脱敏视图', async () => {
  const calls: Array<{ path: string; body: string | null; authorization: string | null }> = []
  const target = await setup(async (input, init) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, body: typeof init?.body === 'string' ? init.body : null, authorization: new Headers(init?.headers).get('authorization') })
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 120 })
  })
  const view = await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.deepEqual(view, { peerHostId: 'peer-1', status: 'logged_in', expiresAt: 121_000 })
  assert.equal(JSON.stringify(view).includes('access-secret'), false)
  assert.deepEqual(await target.credentials.read('peer-1'), { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 121_000 })
  assert.deepEqual(calls[0], { path: '/api/auth/login', body: JSON.stringify({ username: 'alice', password: 'password-secret' }), authorization: null })
})

test('access token 临近过期时由 Host 自动 refresh，失败只影响目标 PeerHost', async () => {
  let refreshCalls = 0
  const target = await setup(async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/auth/refresh') {
      refreshCalls += 1
      return response({ accessToken: 'access-refreshed', refreshToken: 'refresh-refreshed', expiresIn: 120 })
    }
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 1 })
  })
  await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.equal(await target.service.getAccessToken('peer-1'), 'access-refreshed')
  assert.equal(refreshCalls, 1)

  const failed = await setup(async (input) => {
    if (new URL(String(input)).pathname === '/api/auth/refresh') return response({ message: 'expired' }, 401)
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 1 })
  })
  await failed.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  await assert.rejects(failed.service.getAccessToken('peer-1'), /需要登录/u)
  assert.equal((await failed.store.get('peer-1'))?.status, 'session_required')
})

test('退出会话会清理目标凭据，即使远端退出请求失败', async () => {
  const target = await setup(async (input) => {
    if (new URL(String(input)).pathname === '/api/auth/logout') throw new Error('network down')
    return response({ accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 120 })
  })
  await target.service.login('peer-1', { username: 'alice', password: 'password-secret' })
  assert.deepEqual(await target.service.logout('peer-1'), { peerHostId: 'peer-1', status: 'logged_out', expiresAt: null })
  assert.equal(await target.credentials.read('peer-1'), null)
})
