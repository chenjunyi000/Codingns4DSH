import assert from 'node:assert/strict'
import test from 'node:test'
import { PeerHostAggregateService } from '../data/build/dist/host/modules/peer-host/peer-host-aggregate-service.js'

const workspace = (workspaceId: string, sessionId: string) => ({ workspaceId, displayName: '同名项目', sessions: [{ sessionId, title: '同名会话', status: 'active', updatedAt: 1 }] })

test('聚合并发加载当前 Host 和 PeerHost，同名资源使用 Host 作用域 key', async () => {
  const service = new PeerHostAggregateService(100)
  const results = await service.load([
    { hostId: 'host-local', targetHostId: null, hostLabel: '当前 Host', load: async () => [workspace('w-1', 's-1')] },
    { hostId: 'peer-1', targetHostId: 'peer-1', hostLabel: '开发机', load: async () => [workspace('w-1', 's-1')] },
  ])
  assert.equal(results.length, 2)
  assert.notEqual(results[0]!.workspaces[0]!.key, results[1]!.workspaces[0]!.key)
  assert.deepEqual(results[1]!.workspaces[0]!.sessions[0]!.scope, { hostId: 'peer-1', targetHostId: 'peer-1', workspaceId: 'w-1', sessionId: 's-1', scopeGeneration: 0 })
})

test('单个 PeerHost 失败保留错误节点，不阻塞其他 Host', async () => {
  const service = new PeerHostAggregateService(100)
  const results = await service.load([
    { hostId: 'host-local', targetHostId: null, hostLabel: '当前 Host', load: async () => [workspace('w-1', 's-1')] },
    { hostId: 'peer-down', targetHostId: 'peer-down', hostLabel: '离线机', load: async () => { throw new Error('down') } },
  ])
  assert.equal(results[0]!.availability, 'ready')
  assert.equal(results[1]!.availability, 'unreachable')
  assert.equal(results[1]!.errorCode, 'PEER_HOST_UNREACHABLE')
  assert.deepEqual(results[1]!.workspaces, [])
})

test('慢 Host 超时只标记自身不可达', async () => {
  const service = new PeerHostAggregateService(5)
  const results = await service.load([{ hostId: 'peer-slow', targetHostId: 'peer-slow', hostLabel: '慢机', load: async () => new Promise(() => undefined) }])
  assert.equal(results[0]!.availability, 'unreachable')
})
