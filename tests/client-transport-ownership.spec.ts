import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { reverseProxyFeature } from '../data/build/dist/client/features/index.js'

/**
 * 页面级 Transport 的所有权不变式。
 *
 * `globalThis.__DSH_TRANSPORT__` 同时被三方写入：Desktop 壳、Host 启动页注入行、
 * 中继 iframe 桥接脚本。它既是 DSH 的传输实现（fetch/openStream/streamBaseUrl），
 * 也是 DSH 判定页面是否拥有 Host 的开关（`ownsHost` → `remote.$host.isLoopback`
 * → ui-settings 的 host/memory persistence）。因此：
 *
 * 1. Host 启动页只允许在 DSH 已提供 Transport 时合并 `ownsHost`，不得创建同名
 *    全局（创建会让 Desktop 壳以为页面已经登记过 Transport，`/api/remote.mux`
 *    退回 `dsh://` 并卡住插件页）。见 tests/host-index-injection.spec.ts。
 * 2. 中继 iframe 的桥接脚本只允许合并写入，后到的启动页注入行不得把它顶掉，
 *    否则会话列表与原生设置页面会一起加载失败。
 * 3. 功能模块不得用该全局推断运行环境，也不得在 Cordis 启动后接管 Connection。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('页面已有 DSH Connection 时不启动第二条中继连接', async () => {
  const calls: string[] = []
  const disposer = reverseProxyFeature.start({
    services: {
      rpc: {
        call: async (_channel: string, endpoint: string) => {
          calls.push(endpoint)
          throw new Error('页面已持有 Connection 时不应请求 Host RPC')
        },
      },
      // 功能模块运行在 DSH Client 内，页面级 Transport 已由 DSH/Desktop 登记。
      uiContext: { get: () => ({ registerGenerationSource: () => () => undefined }) },
    },
  } as never)
  await new Promise((resolve) => setImmediate(resolve))
  await disposer?.()

  assert.deepEqual(calls, [])
  assert.equal(
    (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__,
    undefined,
    '功能模块不得接管页面级 Transport',
  )
})

test('功能模块不读写页面级 Transport 全局', async () => {
  for (const path of [
    'src/client/index.ts',
    'src/client/settings-section.ts',
    'src/client/features/reverse-proxy.ts',
    'src/dsh-capabilities/client/config-forms-adapter.ts',
    'src/dsh-capabilities/client/settings-scope-adapter.ts',
  ]) {
    const source = await readFile(join(root, path), 'utf8')
    assert.doesNotMatch(source, /__DSH_TRANSPORT__/u, `${path} 不得读写页面级 Transport`)
  }
})

test('中继 iframe 桥接 Transport 只合并，不被启动页注入覆盖', async () => {
  const source = await readFile(join(root, 'src/client/remote-web-context.ts'), 'utf8')
  // 合并写入：任何后到的赋值只能补充字段，openStream/streamBaseUrl 始终保留。
  assert.match(source, /const mergeTransport = \(next\) => Object\.assign\(/u)
  assert.match(source, /Object\.defineProperty\(globalThis, '__DSH_TRANSPORT__', \{/u)
  assert.match(source, /set: \(next\) => \{ transportValue = mergeTransport\(next\); \}/u)
  assert.match(source, /globalThis\.__DSH_TRANSPORT__ = mergeTransport\(globalThis\.__DSH_TRANSPORT__\)/u)
})

test('Client 只绑定 Host 真正下发的 ConfigForm，否则退回 Host RPC', async () => {
  const source = await readFile(join(root, 'src/client/index.ts'), 'utf8')
  assert.match(source, /resolveServedConfigFormNamespace\(forms, CODINGNS_SETTINGS_ENTRY_IDS\)/u)
  assert.match(source, /client config form not served; falling back to Host settings RPC/u)
  assert.match(source, /createCodingNsSettingsBridge\(undefined, rpc\)/u)
  // Host 持久模式会为任意 entry 造出一份停在 loading 的空表单：按 status 猜测
  // 会绑定一份 Host 没下发的表单，让设置页永久把所有开关显示为不可操作。
  assert.doesNotMatch(source, /namespace fallback selected/u)
})
