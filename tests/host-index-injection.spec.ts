import assert from 'node:assert/strict'
import test from 'node:test'
import { injectDshWebTransportOwnership } from '../data/build/dist/host/index-injection.js'

test('没有既有 Transport 时不追加同名全局', () => {
  const table: unknown[] = []

  injectDshWebTransportOwnership(table)

  assert.deepEqual(table, [])
})

test('Desktop Transport 保留 streamBaseUrl 并补充 Host 所有权', () => {
  const desktopTransport = {
    fetch: () => Promise.resolve(new Response()),
    streamBaseUrl: 'dsh-app://app',
  }
  const table: unknown[] = [{ kind: 'global', name: '__DSH_TRANSPORT__', value: desktopTransport }]

  injectDshWebTransportOwnership(table)

  assert.equal(table.length, 1)
  assert.deepEqual((table[0] as { value: unknown }).value, {
    fetch: desktopTransport.fetch,
    streamBaseUrl: 'dsh-app://app',
    ownsHost: true,
  })
})

test('未知 Transport 形状不被覆盖', () => {
  const table: unknown[] = [{ name: '__DSH_TRANSPORT__', value: 'desktop-managed' }]

  injectDshWebTransportOwnership(table)

  assert.deepEqual(table, [{ name: '__DSH_TRANSPORT__', value: 'desktop-managed' }])
})
