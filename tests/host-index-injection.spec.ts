import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { injectDshWebTransportOwnership } from '../data/build/dist/host/index-injection.js'

/** 启动页在文档里执行脚本行；这里用 vm 复现页面侧的赋值结果。 */
function runScripts(table: readonly unknown[], sandbox: Record<string, unknown>): void {
  for (const entry of table) {
    if (typeof entry !== 'object' || entry === null) continue
    if ((entry as { kind?: unknown }).kind !== 'script') continue
    runInNewContext(String((entry as { text?: unknown }).text), sandbox)
  }
}

function transportRows(table: readonly unknown[]): unknown[] {
  return table.filter((entry) => typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === '__DSH_TRANSPORT__')
}

test('没有既有 Transport 时用脚本行声明 Host 所有权，不追加同名全局', () => {
  const table: unknown[] = []

  injectDshWebTransportOwnership(table)

  assert.deepEqual(transportRows(table), [], '不得追加 __DSH_TRANSPORT__ 全局行')
  const sandbox: Record<string, unknown> = {}
  runScripts(table, sandbox)
  assert.equal((sandbox.__DSH_TRANSPORT__ as { ownsHost?: unknown } | undefined)?.ownsHost, true)
  assert.deepEqual(Object.keys(sandbox.__DSH_TRANSPORT__ as object), ['ownsHost'])
})

test('Desktop Transport 保留 streamBaseUrl 并补充 Host 所有权', () => {
  const desktopTransport = {
    fetch: () => Promise.resolve(new Response()),
    streamBaseUrl: 'dsh-app://app',
  }
  const table: unknown[] = [{ kind: 'global', name: '__DSH_TRANSPORT__', value: desktopTransport }]

  injectDshWebTransportOwnership(table)

  assert.equal((table[0] as { value: { streamBaseUrl?: unknown; ownsHost?: unknown } }).value.streamBaseUrl, 'dsh-app://app')
  assert.equal((table[0] as { value: { ownsHost?: unknown } }).value.ownsHost, true)

  const sandbox: Record<string, unknown> = { __DSH_TRANSPORT__: { fetch: desktopTransport.fetch, streamBaseUrl: 'dsh-app://app' } }
  runScripts(table, sandbox)
  const merged = sandbox.__DSH_TRANSPORT__ as { fetch?: unknown; streamBaseUrl?: unknown; ownsHost?: unknown }
  assert.equal(merged.fetch, desktopTransport.fetch)
  assert.equal(merged.streamBaseUrl, 'dsh-app://app')
  assert.equal(merged.ownsHost, true)
})

test('Desktop 壳存在且尚未登记 Transport 时不由插件创建', () => {
  const table: unknown[] = []

  injectDshWebTransportOwnership(table)

  const sandbox: Record<string, unknown> = { dshDesktopBoot: {} }
  runScripts(table, sandbox)
  assert.equal(sandbox.__DSH_TRANSPORT__, undefined)
})

test('未知 Transport 形状不被覆盖', () => {
  const table: unknown[] = [{ name: '__DSH_TRANSPORT__', value: 'desktop-managed' }]

  injectDshWebTransportOwnership(table)

  assert.deepEqual(table[0], { name: '__DSH_TRANSPORT__', value: 'desktop-managed' })

  const sandbox: Record<string, unknown> = { __DSH_TRANSPORT__: 'desktop-managed' }
  runScripts(table, sandbox)
  assert.equal(sandbox.__DSH_TRANSPORT__, 'desktop-managed')
})
