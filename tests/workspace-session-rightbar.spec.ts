import assert from 'node:assert/strict'
import test from 'node:test'
import {
  startWorkspaceSessionRightbarDom,
  WORKSPACE_RIGHTBAR_RATIO_STORAGE_KEY,
} from '../data/build/dist/client/workspace-session-rightbar-dom.js'

class FakeStyle {
  left = ''
  private readonly values = new Map<string, string>()
  setProperty(name: string, value: string): void { this.values.set(name, value) }
  getPropertyValue(name: string): string { return this.values.get(name) ?? '' }
}

class FakeHandle {
  readonly style = new FakeStyle()
  offsetParent: { getBoundingClientRect: () => { left: number; right: number; width: number } } | null = null
  left = 700
  matches(selector: string): boolean { return selector.includes('rightbar') }
  closest(): null { return null }
  getBoundingClientRect(): { left: number; width: number } { return { left: this.left, width: 0 } }
}

class PointerHandle extends FakeHandle {
  readonly events: string[] = []
  setPointerCapture(_pointerId: number): void { throw new Error('synthetic pointer capture is unavailable') }
  dispatchEvent(event: { type: string }): boolean {
    this.events.push(event.type)
    if (event.type === 'pointerdown') this.setPointerCapture(1)
    return true
  }
}

class FakeDocument {
  readonly documentElement = {}
  private readonly listeners = new Map<string, () => void>()
  readonly handle: FakeHandle
  constructor(handle: FakeHandle) { this.handle = handle }
  querySelector(): FakeHandle { return this.handle }
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener) }
  removeEventListener(name: string): void { this.listeners.delete(name) }
  emit(name: string): void { this.listeners.get(name)?.() }
}

class FakeWindow {
  innerWidth = 1000
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeStorage {
  private value: string | null
  constructor(value: string | null = null) { this.value = value }
  getItem(key: string): string | null { return key === WORKSPACE_RIGHTBAR_RATIO_STORAGE_KEY ? this.value : null }
  setItem(key: string, value: string): void { if (key === WORKSPACE_RIGHTBAR_RATIO_STORAGE_KEY) this.value = value }
  read(): string | null { return this.value }
}

test('右侧栏比例会在拖拽后写入并在下一次加载恢复', async () => {
  const firstHandle = new FakeHandle()
  const firstDocument = new FakeDocument(firstHandle)
  const firstStorage = new FakeStorage()
  const firstController = startWorkspaceSessionRightbarDom({
    document: firstDocument as unknown as Document,
    window: new FakeWindow() as unknown as Window,
    storage: firstStorage,
    MutationObserver: undefined,
  })
  await Promise.resolve()
  assert.equal(firstStorage.read(), '0.3')

  firstDocument.emit('mousedown')
  firstHandle.left = 600
  firstDocument.emit('mouseup')
  await Promise.resolve()
  assert.equal(firstStorage.read(), '0.4')
  firstController.dispose()

  const restoredHandle = new FakeHandle()
  restoredHandle.left = 800
  const restoredStorage = new FakeStorage('0.4')
  const restoredController = startWorkspaceSessionRightbarDom({
    document: new FakeDocument(restoredHandle) as unknown as Document,
    window: new FakeWindow() as unknown as Window,
    storage: restoredStorage,
    MutationObserver: undefined,
  })
  await Promise.resolve()
  assert.equal(restoredHandle.style.left, '600px')

  // 宿主在插件之后重新渲染默认值时，下一轮扫描必须再次恢复已保存比例。
  restoredHandle.style.left = ''
  restoredHandle.left = 800
  restoredController.refresh()
  await Promise.resolve()
  assert.equal(restoredHandle.style.left, '600px')

  // 用户重新拖拽后，保存值应切换到新的比例，而不是被旧值强行覆盖。
  const restoredDocument = new FakeDocument(restoredHandle)
  const userController = startWorkspaceSessionRightbarDom({
    document: restoredDocument as unknown as Document,
    window: new FakeWindow() as unknown as Window,
    storage: restoredStorage,
    MutationObserver: undefined,
  })
  await Promise.resolve()
  restoredDocument.emit('mousedown')
  restoredHandle.style.left = ''
  restoredHandle.left = 550
  restoredDocument.emit('mouseup')
  await Promise.resolve()
  assert.equal(restoredStorage.read(), '0.45')
  userController.dispose()
  restoredController.dispose()
})

test('恢复比例使用句柄定位父容器坐标，而不是视口坐标', async () => {
  const handle = new FakeHandle()
  handle.offsetParent = { getBoundingClientRect: () => ({ left: 320, right: 1120, width: 800 }) }
  const storage = new FakeStorage('0.4')
  const controller = startWorkspaceSessionRightbarDom({
    document: new FakeDocument(handle) as unknown as Document,
    window: new FakeWindow() as unknown as Window,
    storage,
    MutationObserver: undefined,
  })
  await Promise.resolve()
  assert.equal(handle.style.left, '480px')
  controller.dispose()
})

test('宿主支持 Pointer Events 时通过原生拖拽更新布局状态', async () => {
  const handle = new PointerHandle()
  handle.left = 800
  const document = new FakeDocument(handle)
  const PointerEventCtor = class {
    readonly type: string
    constructor(type: string) { this.type = type }
  }
  const window = Object.assign(new FakeWindow(), {
    document: {},
    PointerEvent: PointerEventCtor,
  })
  const storage = new FakeStorage('0.4')
  const controller = startWorkspaceSessionRightbarDom({
    document: document as unknown as Document,
    window: window as unknown as Window,
    storage,
    MutationObserver: undefined,
  })
  await Promise.resolve()
  assert.deepEqual(handle.events, ['pointerdown', 'pointermove', 'pointerup'])
  assert.equal(handle.style.left, '')
  controller.dispose()
})
