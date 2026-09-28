import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODINGNS_DSH_ERROR_CODES,
  PEER_HOST_ERROR_CODES,
  type AggregateWorkspaceSummary,
  type HostScope,
  type PeerHostRecord,
} from '../data/build/dist/shared/index.js'

test('PeerHost 契约可序列化并保留 HostScope 隔离字段', () => {
  const scope: HostScope = {
    hostId: 'host-local',
    targetHostId: 'peer-a',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    scopeGeneration: 3,
  }
  const record: PeerHostRecord = {
    id: 'peer-a',
    ownerUserId: 'user-1',
    displayName: '开发机',
    route: { kind: 'lan', baseUrl: 'http://192.168.1.20:13080', normalizedOrigin: 'http://192.168.1.20:13080' },
    status: 'ready',
    pluginId: '@jingyi0605/codingns4dsh',
    pluginVersion: '0.1.2',
    dshVersion: '0.1.6-alpha.2',
    apiCompatibility: 'dsh-api-v1',
    fingerprint: 'sha256:abcd',
    lastCheckedAt: 1_000,
    lastErrorCode: null,
    createdAt: 900,
    updatedAt: 1_000,
  }
  const aggregate: AggregateWorkspaceSummary = {
    key: `${scope.hostId}:${scope.workspaceId}`,
    hostId: scope.hostId,
    targetHostId: scope.targetHostId,
    workspaceId: scope.workspaceId,
    displayName: '项目',
    hostLabel: '开发机',
    availability: 'ready',
    sessions: [{ scope, title: '会话', status: 'active', updatedAt: 1_000 }],
  }
  assert.deepEqual(JSON.parse(JSON.stringify({ record, aggregate })), { record, aggregate })
  assert.notEqual(aggregate.key, `${scope.workspaceId}`)
})

test('PeerHost 错误码同时暴露专用常量和共享错误表', () => {
  assert.equal(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PEER_HOST_SCOPE_MISMATCH')
  assert.equal(CODINGNS_DSH_ERROR_CODES.PEER_HOST_SCOPE_MISMATCH, PEER_HOST_ERROR_CODES.SCOPE_MISMATCH)
  assert.equal(CODINGNS_DSH_ERROR_CODES.PEER_HOST_TOOL_UNSUPPORTED, 'PEER_HOST_TOOL_UNSUPPORTED')
})
