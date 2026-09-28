import assert from 'node:assert/strict'
import test from 'node:test'
import {
  probePeerHostNativeNavigation,
  probePeerHostNativeSession,
  startPeerHostNativeNavigation,
  startPeerHostNativeSession,
} from '../data/build/dist/client/peer-host-native-session-ui.js'

test('没有明确的 DSH 原生树时保持降级，不创建伪造导航', () => {
  const state = probePeerHostNativeNavigation(undefined)
  assert.equal(state.status, 'degraded')
  assert.match(state.reason, /未探测到/u)

  const controller = startPeerHostNativeNavigation({ document: undefined, controller: {} as never })
  controller.refresh([])
  assert.equal(controller.state.status, 'degraded')
  controller.dispose()
})

test('没有明确的 conversation 容器时保持降级', async () => {
  const state = probePeerHostNativeSession(undefined)
  assert.equal(state.status, 'degraded')

  const calls: string[] = []
  const controller = startPeerHostNativeSession({
    document: undefined,
    client: {} as never,
    controller: {
      loadHistory: async () => { calls.push('history'); return { status: 200, headers: [], body: '{}' } },
    } as never,
  })
  await assert.rejects(() => controller.send('hello'), /尚未选择/u)
  assert.deepEqual(calls, [])
  controller.close()
})
