import assert from 'node:assert/strict'
import test from 'node:test'
import { createConfigSettingsStore } from '../data/build/dist/dsh-capabilities/host/config-forms-adapter.js'
import { createConfigFormSettingsStore } from '../data/build/dist/dsh-capabilities/client/config-forms-adapter.js'
import { createLegacyClientSettingsStore } from '../data/build/dist/dsh-capabilities/client/settings-scope-adapter.js'
import { dispatchCodingNsRpc } from '../data/build/dist/dsh-capabilities/host/connection-rpc-adapter.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

test('0.1.7 Host Config 适配器保留 revision 并路由 mutation', async () => {
  const calls: unknown[] = []
  const store = createConfigSettingsStore({
    describe: () => [{ ns: 'codingns', value: { modules: {} }, revision: 7 }],
    mutate: async (_namespace, operations, revision) => { calls.push([operations, revision]) },
  }, 'codingns')
  assert.equal(store.getSnapshot().revision, 7)
  assert.equal(await store.set('controlBaseUrl', 'https://example.test'), true)
  assert.deepEqual(calls[0], [[{ op: 'set', path: ['controlBaseUrl'], value: 'https://example.test' }], undefined])
})

test('0.1.7 Client ConfigForm 缺失时只禁用设置能力', async () => {
  const store = createConfigFormSettingsStore({ get: () => undefined }, 'codingns')
  assert.equal(store.getSnapshot().status, 'unavailable')
  assert.equal(await store.set('controlBaseUrl', 'https://example.test'), false)
})

test('0.1.7 Client ConfigForm 缺失时快照保持稳定引用', () => {
  const store = createConfigFormSettingsStore({ get: () => undefined }, 'codingns')
  // 设置页用 useSyncExternalStore 读取快照：每次返回新对象会让 React 在每次
  // 渲染后判定快照失效并强制再次渲染，最终以 React #185 崩溃设置分区。
  assert.equal(store.getSnapshot(), store.getSnapshot())
})

test('旧版 SettingsScope 适配器内容不变时保持快照引用且不通知', () => {
  const value = { controlBaseUrl: 'https://example.test', modules: {}, cliSessions: [] }
  let notify: (() => void) | undefined
  const scope = {
    // SettingsScope 会在每次读取时构造新对象；内容相同的快照必须被规范化。
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { ...value, modules: { ...value.modules } },
      base: undefined,
      user: undefined,
      revision: 3,
      writable: true,
      mode: 'host' as const,
    }),
    subscribe: (listener: () => void) => { notify = listener; return () => undefined },
    mutate: async () => undefined,
    set: async () => undefined,
    unset: async () => undefined,
  }
  const store = createLegacyClientSettingsStore(scope)
  const first = store.getSnapshot()
  let calls = 0
  store.subscribe(() => { calls += 1 })

  notify?.()

  assert.equal(store.getSnapshot(), first)
  assert.equal(calls, 0)
})

test('0.1.7 Client ConfigForm 内容未变化时不重复通知', async () => {
  const value = { controlBaseUrl: 'https://example.test', modules: {}, cliSessions: [] }
  let notify: (() => void) | undefined
  const form = {
    getSnapshot: () => ({ value: { ...value, modules: { ...value.modules }, cliSessions: [...value.cliSessions] }, revision: 1, writable: true as const, status: 'ready' as const }),
    subscribe: (listener: () => void) => { notify = listener; return () => undefined },
    mutate: async () => undefined,
    set: async () => undefined,
    unset: async () => undefined,
  }
  const store = createConfigFormSettingsStore({ get: () => form }, 'codingns')
  let calls = 0
  store.subscribe(() => { calls += 1 })

  notify?.()
  assert.equal(calls, 0)
  assert.deepEqual(store.getSnapshot().value, { controlBaseUrl: 'https://example.test', modules: {} })
})

test('0.1.7 Client ConfigForm revision 冲突后使用最新快照重试写入', async () => {
  let attempts = 0
  const value = { controlBaseUrl: 'https://example.test', modules: {}, cliSessions: [] }
  const form = {
    getSnapshot: () => ({ value, revision: 3, writable: true as const, status: 'ready' as const }),
    subscribe: () => () => undefined,
    mutate: async () => false,
    set: async () => {
      attempts += 1
      return attempts === 2
    },
    unset: async () => undefined,
  }
  const store = createConfigFormSettingsStore({ get: () => form }, 'codingns')

  assert.equal(await store.set('controlBaseUrl', 'https://updated.example'), true)
  assert.equal(attempts, 2)
})

test('0.1.7 Client 设置写入通过 Host RPC 跳过后台索引 revision 冲突', async () => {
  const value = { controlBaseUrl: 'https://example.test', modules: {}, cliSessions: [] }
  let formMutations = 0
  let received: unknown
  const form = {
    getSnapshot: () => ({ value, revision: 3, writable: true as const, status: 'ready' as const }),
    subscribe: () => () => undefined,
    mutate: async () => {
      formMutations += 1
      throw new Error('不应调用带 revision 的 ConfigForm')
    },
    set: async () => {
      formMutations += 1
      throw new Error('不应调用带 revision 的 ConfigForm')
    },
    unset: async () => {
      formMutations += 1
      throw new Error('不应调用带 revision 的 ConfigForm')
    },
  }
  const store = createConfigFormSettingsStore({ get: () => form }, 'codingns', {
    writeUnfenced: async (operations) => {
      received = operations
      return {
        value: { ...value, modules: { reverseProxy: true } },
        revision: 9,
      }
    },
  })

  assert.equal(await store.mutate([{ op: 'set', path: ['modules', 'reverseProxy'], value: true }]), true)
  assert.equal(formMutations, 0)
  assert.deepEqual(received, [{ op: 'set', path: ['modules', 'reverseProxy'], value: true }])
  assert.equal(store.getSnapshot().value?.modules.reverseProxy, true)
  assert.equal(store.getSnapshot().revision, 9)
})

test('0.1.7 Client 只读 ConfigForm 镜像仍允许通过 Host RPC 停用模块', async () => {
  const value = { controlBaseUrl: 'https://example.test', modules: { peerHost: true }, cliSessions: [] }
  const form = {
    getSnapshot: () => ({ value, revision: 3, writable: false as const, status: 'ready' as const }),
    subscribe: () => () => undefined,
    mutate: async () => { throw new Error('不应调用只读 ConfigForm') },
    set: async () => { throw new Error('不应调用只读 ConfigForm') },
    unset: async () => { throw new Error('不应调用只读 ConfigForm') },
  }
  const store = createConfigFormSettingsStore({ get: () => form }, 'codingns', {
    writeUnfenced: async (operations) => {
      assert.deepEqual(operations, [{ op: 'set', path: ['modules', 'peerHost'], value: false }])
      return { value: { ...value, modules: { peerHost: false } }, revision: 4 }
    },
  })

  assert.equal(store.getSnapshot().writable, true)
  assert.equal(await store.mutate([{ op: 'set', path: ['modules', 'peerHost'], value: false }]), true)
  assert.equal(store.getSnapshot().value?.modules.peerHost, false)
})

test('统一 RPC dispatch 只使用宿主传入的 peer context', async () => {
  const table = new CodingNsRpcTable()
  let received: unknown
  table.register('test', async (_action, payload, context) => { received = { payload, context }; return 'ok' })
  const result = await dispatchCodingNsRpc(table, 'test/ping', { value: 1 }, { peer: { id: 'host-authority' } })
  assert.deepEqual(result, { ok: true, value: 'ok' })
  assert.deepEqual(received, { payload: { value: 1 }, context: { peer: { id: 'host-authority' } } })
})
