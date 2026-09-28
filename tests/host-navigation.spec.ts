import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHostNavigation } from '../data/build/dist/client/host-navigation.js'

test('工作区标签显示 Host，导航 key 隔离同名 workspace/session', () => {
  const results = [
    {
      hostId: 'host-local', targetHostId: null, hostLabel: '当前 Host', availability: 'ready' as const, errorCode: null,
      workspaces: [{ key: 'host-local:w-1', hostId: 'host-local', targetHostId: null, workspaceId: 'w-1', displayName: '项目', hostLabel: '当前 Host', availability: 'ready' as const, sessions: [{ scope: { hostId: 'host-local', targetHostId: null, workspaceId: 'w-1', sessionId: 's-1', scopeGeneration: 1 }, title: '会话', status: 'active', updatedAt: 1 }] }],
    },
    {
      hostId: 'peer-1', targetHostId: 'peer-1', hostLabel: '开发机', availability: 'ready' as const, errorCode: null,
      workspaces: [{ key: 'peer-1:w-1', hostId: 'peer-1', targetHostId: 'peer-1', workspaceId: 'w-1', displayName: '项目', hostLabel: '开发机', availability: 'ready' as const, sessions: [{ scope: { hostId: 'peer-1', targetHostId: 'peer-1', workspaceId: 'w-1', sessionId: 's-1', scopeGeneration: 1 }, title: '会话', status: 'active', updatedAt: 1 }] }],
    },
  ]
  const navigation = buildHostNavigation(results)
  assert.equal(navigation[0]!.workspaces[0]!.label, '项目 (当前 Host)')
  assert.equal(navigation[1]!.workspaces[0]!.label, '项目 (开发机)')
  assert.notEqual(navigation[0]!.workspaces[0]!.key, navigation[1]!.workspaces[0]!.key)
  assert.notEqual(navigation[0]!.workspaces[0]!.sessions[0]!.key, navigation[1]!.workspaces[0]!.sessions[0]!.key)
})

test('不可用 Host 节点保留状态而不是伪装成可用空导航', () => {
  const [item] = buildHostNavigation([{ hostId: 'peer-down', targetHostId: 'peer-down', hostLabel: '离线机', availability: 'unreachable', errorCode: 'PEER_HOST_UNREACHABLE', workspaces: [] }])
  assert.equal(item?.availability, 'unreachable')
  assert.equal(item?.errorCode, 'PEER_HOST_UNREACHABLE')
})
