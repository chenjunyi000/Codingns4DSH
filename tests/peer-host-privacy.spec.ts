import assert from 'node:assert/strict'
import test from 'node:test'
import { createDshTransportDebugLogger } from '../data/build/dist/transport/debug.js'
import {
  createPeerHostDiagnosticSink,
  peerHostSafeError,
  toPeerHostDiagnosticSnapshot,
} from '../data/build/dist/host/modules/peer-host/peer-host-diagnostics.js'
import { PEER_HOST_ERROR_CODES } from '../data/build/dist/shared/contracts/peer-host.js'
import { InMemoryPeerHostCredentialStore, InMemoryPeerHostRecordStore, PeerHostStore } from '../data/build/dist/host/modules/peer-host/peer-host-store.js'
import { PeerHostHandshakeService } from '../data/build/dist/host/modules/peer-host/peer-host-handshake.js'

const sensitive = [
  'access-secret', 'refresh-secret', 'password-secret', 'https://peer.example.test:13080',
  'relay-ticket-secret', '/workspace/private.txt', 'cat private.txt', '完整文件内容',
]

test('Transport 调试日志正向白名单过滤凭据、URL、ticket、文件和命令', () => {
  const records: unknown[] = []
  const logger = createDshTransportDebugLogger({ enabled: true, sink: (record) => records.push(record) })
  logger.log('peer-host.failure', {
    hostId: 'host-1',
    code: 'PEER_HOST_PROXY_UNREACHABLE',
    accessToken: sensitive[0],
    refreshToken: sensitive[1],
    password: sensitive[2],
    baseUrl: sensitive[3],
    relayTicket: sensitive[4],
    filePath: sensitive[5],
    command: sensitive[6],
    body: sensitive[7],
    error: `${sensitive[0]} ${sensitive[3]}`,
  })
  const output = JSON.stringify(records)
  for (const value of sensitive) assert.equal(output.includes(value), false, `日志包含敏感值: ${value}`)
  assert.deepEqual(records[0], {
    at: (records[0] as any).at,
    side: 'unknown',
    component: 'transport',
    event: 'peer-host.failure',
    hostId: 'host-1',
    code: 'PEER_HOST_PROXY_UNREACHABLE',
  })
})

test('PeerHost 诊断快照不包含完整路由和稳定凭据标识', () => {
  const record = {
    id: 'peer-1', ownerUserId: 'owner', displayName: '开发机',
    route: { kind: 'relay', deviceId: 'device-secret', relayEntryId: 'entry-secret', transportVersion: 'v1' },
    status: 'unreachable', pluginId: null, pluginVersion: null, dshVersion: null,
    apiCompatibility: null, fingerprint: 'sha256:1234567890abcdef', lastCheckedAt: 10,
    lastErrorCode: PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE, createdAt: 1, updatedAt: 10,
  } as any
  const snapshot = toPeerHostDiagnosticSnapshot(record)
  const output = JSON.stringify(snapshot)
  assert.deepEqual(snapshot, {
    peerHostId: 'peer-1', routeKind: 'relay', status: 'unreachable',
    lastErrorCode: PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE, lastCheckedAt: 10,
    fingerprint: 'sha256:1...cdef',
  })
  assert.equal(output.includes('device-secret'), false)
  assert.equal(output.includes('entry-secret'), false)
  assert.equal(output.includes('baseUrl'), false)
})

test('诊断 sink 默认关闭且启用后只接收脱敏快照', () => {
  const records: unknown[] = []
  const sink = createPeerHostDiagnosticSink({ enabled: true, sink: (event, snapshot) => records.push({ event, snapshot }) })
  sink.emit('peer-host.snapshot', {
    peerHostId: 'peer-1', routeKind: 'lan', status: 'ready', lastErrorCode: null,
    lastCheckedAt: 1, fingerprint: 'sha256:...1234',
  })
  assert.equal(records.length, 1)
  assert.equal(JSON.stringify(records).includes('access-secret'), false)
})

test('PeerHost 稳定错误码使用固定错误说明，不回显底层异常', () => {
  const error = peerHostSafeError(PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE)
  assert.equal(error.code, PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE)
  assert.equal(error.message, '目标 Host 代理不可达')
  assert.doesNotMatch(error.message, /token|password|ticket|https?:\/\//iu)
})

test('所有 PeerHost 错误码都有稳定且不含敏感数据的错误说明', () => {
  for (const code of Object.values(PEER_HOST_ERROR_CODES)) {
    const error = peerHostSafeError(code)
    assert.equal(error.code, code)
    assert.ok(error.message.length > 0)
    assert.doesNotMatch(error.message, /access-secret|password-secret|relay-ticket-secret|https?:\/\/|\/workspace|cat private/iu)
  }
})

test('握手失败只保存稳定错误码，不保存底层异常正文', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('owner', new InMemoryPeerHostRecordStore(), credentials, () => 1, () => 'peer-1')
  await store.create({ displayName: '目标', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: 'http://127.0.0.1:13080' } })
  const handshake = new PeerHostHandshakeService(store, credentials, {
    productId: 'CodingNS', pluginId: '@jingyi0605/codingns4dsh', pluginVersion: '0.1.2', apiCompatibility: 'peer-host-v1',
    isDshVersionSupported: () => true,
    fetchImpl: async () => { throw new Error(`token=${sensitive[0]} url=${sensitive[3]} file=${sensitive[5]} command=${sensitive[6]}`) },
  })
  const result = await handshake.check('peer-1')
  assert.equal(result.lastErrorCode, PEER_HOST_ERROR_CODES.UNREACHABLE)
  const serialized = JSON.stringify(result)
  for (const value of sensitive) assert.equal(serialized.includes(value), false)
})
