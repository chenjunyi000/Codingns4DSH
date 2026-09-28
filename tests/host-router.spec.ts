import assert from 'node:assert/strict'
import test from 'node:test'
import { HostRouter } from '../data/build/dist/features/host-router.js'

const base = { hostId: 'host-local', targetHostId: null, workspaceId: 'workspace-1', sessionId: 'session-1' }

test('HostRouter 切换作用域会递增 generation 并清理旧连接', async () => {
  const router = new HostRouter()
  let disposed = 0
  const first = await router.switchTo(base, () => { disposed += 1 })
  const controller = new AbortController()
  router.registerAbortController(first, controller)
  const second = await router.switchTo({ ...base, targetHostId: 'peer-1' })
  assert.equal(second.scopeGeneration, first.scopeGeneration + 1)
  assert.equal(disposed, 1)
  assert.equal(controller.signal.aborted, true)
  assert.equal(router.isCurrent(first), false)
  assert.equal(router.isCurrent(second), true)
})

test('HostRouter 稳定 key 隔离相同 workspace/session，旧结果不能回写', async () => {
  const router = new HostRouter()
  const current = await router.switchTo(base)
  const localKey = router.key(current, 'session', 'same-id')
  const remote = await router.switchTo({ ...base, targetHostId: 'peer-1' })
  const remoteKey = router.key(remote, 'session', 'same-id')
  assert.notEqual(localKey, remoteKey)
  assert.throws(() => router.commitIfCurrent(current, () => 'stale'), /已失效/u)
  assert.equal(router.commitIfCurrent(remote, () => 'fresh'), 'fresh')
})

test('清理失败不阻塞新作用域建立，但会向调用方报告清理错误', async () => {
  const router = new HostRouter()
  await router.switchTo(base, () => { throw new Error('close failed') })
  await assert.rejects(router.switchTo({ ...base, workspaceId: 'workspace-2' }), /清理失败/u)
  assert.equal(router.getCurrent()?.workspaceId, 'workspace-2')
})
