import type { PeerHostClientRecord } from '../shared/contracts/peer-host.js'
import { PEER_HOST_OPEN_EVENT } from './peer-host-connection-button.js'
import type { CodingNsRpcClient } from './features/types.js'
import { createPeerHostManagementApi, type PeerHostManagementApi } from './peer-host-management-api.js'

export interface PeerHostManagementPanelController { dispose(): void }

export interface PeerHostManagementPanelOptions {
  readonly document?: Document
  readonly rpc: CodingNsRpcClient
  readonly api?: PeerHostManagementApi
}

/** PeerHost 管理面板；只渲染脱敏记录和稳定状态。 */
export function startPeerHostManagementPanel(options: PeerHostManagementPanelOptions): PeerHostManagementPanelController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  if (dom === undefined) return { dispose() {} }
  const api = options.api ?? createPeerHostManagementApi(options.rpc)
  let disposed = false
  let overlay: HTMLElement | null = null
  const open = (): void => {
    if (disposed) return
    if (overlay === null) overlay = createOverlay(dom, api, () => { overlay = null })
    void refreshList(overlay, api)
  }
  dom.defaultView?.addEventListener(PEER_HOST_OPEN_EVENT, open)
  return {
    dispose() {
      if (disposed) return
      disposed = true
      dom.defaultView?.removeEventListener(PEER_HOST_OPEN_EVENT, open)
      overlay?.remove()
      overlay = null
    },
  }
}

function createOverlay(dom: Document, api: PeerHostManagementApi, onClose: () => void): HTMLElement {
  const overlay = dom.createElement('div')
  overlay.setAttribute('data-codingns-peer-host-panel', '')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', '管理其他 DSH Host')
  Object.assign(overlay.style, { position: 'fixed', right: '16px', bottom: '56px', zIndex: '9999', width: 'min(520px, calc(100vw - 32px))', maxHeight: 'min(720px, calc(100vh - 80px))', overflow: 'auto', padding: '16px', border: '1px solid var(--dsw-alias-border-l2, #555)', borderRadius: '8px', background: 'var(--dsw-alias-bg-primary, #202124)', color: 'var(--dsw-alias-label-primary, #fff)', boxShadow: '0 12px 32px rgba(0,0,0,.28)' })
  const header = dom.createElement('header')
  const title = dom.createElement('strong')
  title.textContent = '管理其他 DSH Host'
  const close = dom.createElement('button')
  close.type = 'button'
  close.textContent = '关闭'
  close.addEventListener('click', () => { overlay.remove(); onClose() })
  Object.assign(close.style, { float: 'right' })
  header.append(title, close)
  const message = dom.createElement('div')
  message.setAttribute('role', 'status')
  message.setAttribute('data-codingns-peer-host-message', '')
  const list = dom.createElement('div')
  list.setAttribute('data-codingns-peer-host-list', '')
  const form = createAddForm(dom, api, list, message)
  overlay.append(header, message, form, list)
  dom.body.append(overlay)
  return overlay
}

function createAddForm(dom: Document, api: PeerHostManagementApi, list: HTMLElement, message: HTMLElement): HTMLElement {
  const form = dom.createElement('form')
  const name = input(dom, '名称', 'text')
  const routeKind = dom.createElement('select')
  routeKind.required = true
  for (const option of [['lan', '局域网'], ['relay', '中转']] as const) {
    const item = dom.createElement('option')
    item.value = option[0]
    item.textContent = option[1]
    routeKind.append(item)
  }
  const routeKindLabel = dom.createElement('label')
  routeKindLabel.textContent = '路由类型'
  routeKindLabel.append(routeKind)
  const url = input(dom, '局域网地址', 'url')
  const deviceId = input(dom, '中转设备标识', 'text')
  const relayEntryId = input(dom, '中转绑定标识', 'text')
  const transportVersion = input(dom, '中转协议版本', 'text')
  const routeFields = dom.createElement('div')
  routeFields.append(url.wrapper, deviceId.wrapper, relayEntryId.wrapper, transportVersion.wrapper)
  const updateRouteFields = (): void => {
    const relay = routeKind.value === 'relay'
    url.wrapper.hidden = relay
    deviceId.wrapper.hidden = !relay
    relayEntryId.wrapper.hidden = !relay
    transportVersion.wrapper.hidden = !relay
    url.input.required = !relay
    deviceId.input.required = relay
    relayEntryId.input.required = relay
    transportVersion.input.required = relay
  }
  routeKind.addEventListener('change', updateRouteFields)
  updateRouteFields()
  const submit = dom.createElement('button')
  submit.type = 'submit'
  submit.textContent = '添加'
  form.append(name.wrapper, routeKindLabel, routeFields, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const route = routeKind.value === 'relay'
      ? { kind: 'relay' as const, deviceId: deviceId.input.value.trim(), relayEntryId: relayEntryId.input.value.trim(), transportVersion: transportVersion.input.value.trim() }
      : { kind: 'lan' as const, baseUrl: url.input.value.trim(), normalizedOrigin: '' }
    void api.create({ displayName: name.input.value.trim(), route }).then(() => refreshList(list.parentElement!, api)).then(() => { message.textContent = '已添加 PeerHost' }).catch((error) => { message.textContent = error instanceof Error ? error.message : String(error) })
  })
  return form
}

async function refreshList(overlay: HTMLElement, api: PeerHostManagementApi): Promise<void> {
  const list = overlay.querySelector<HTMLElement>('[data-codingns-peer-host-list]')
  if (list === null) return
  list.textContent = '正在读取 PeerHost...'
  try {
    const records = await api.list()
    list.textContent = ''
    for (const record of records) list.append(renderRecord(overlay.ownerDocument, api, record, list))
  } catch (error) {
    list.textContent = error instanceof Error ? error.message : String(error)
  }
}

function renderRecord(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, list: HTMLElement): HTMLElement {
  const row = dom.createElement('article')
  row.setAttribute('data-peer-host-id', record.id)
  const title = dom.createElement('strong')
  title.textContent = `${record.displayName} · ${record.route.kind} · ${record.status}`
  const detail = dom.createElement('div')
  detail.textContent = `DSH ${record.dshVersion ?? '未知'} · 插件 ${record.pluginVersion ?? '未知'} · fingerprint ${redactFingerprint(record.fingerprint)}${record.lastErrorCode === null ? '' : ` · ${record.lastErrorCode}`}`
  const actions = dom.createElement('div')
  actions.append(actionButton(dom, '编辑', () => edit(dom, api, record, run)), actionButton(dom, '检查', () => run(() => api.check(record.id))), actionButton(dom, '重连', () => run(() => api.reconnect(record.id))), actionButton(dom, '登录', () => login(dom, api, record.id, run)), actionButton(dom, '退出', () => run(() => api.logout(record.id))), actionButton(dom, '删除', () => {
    if (dom.defaultView?.confirm(`确认删除 PeerHost“${record.displayName}”？`) !== true) return
    run(() => api.remove(record.id))
  }))
  row.append(title, detail, actions)
  return row

  function run(operation: () => Promise<unknown>): void {
    void operation().then(() => refreshList(list.parentElement!, api)).catch((error) => { detail.textContent = error instanceof Error ? error.message : String(error) })
  }
}

function login(dom: Document, api: PeerHostManagementApi, peerHostId: string, run: (operation: () => Promise<unknown>) => void): void {
  const username = dom.defaultView?.prompt('目标 Host 用户名')
  const password = dom.defaultView?.prompt('目标 Host 密码')
  if (!username || !password) return
  run(() => api.login({ peerHostId, username, password }))
}

function edit(dom: Document, api: PeerHostManagementApi, record: PeerHostClientRecord, run: (operation: () => Promise<unknown>) => void): void {
  const displayName = dom.defaultView?.prompt('PeerHost 名称', record.displayName)?.trim()
  if (!displayName) return
  if (record.route.kind === 'lan') {
    const baseUrl = dom.defaultView?.prompt('局域网地址（重新输入）')?.trim()
    if (!baseUrl) return
    run(() => api.update({ peerHostId: record.id, displayName, route: { kind: 'lan', baseUrl, normalizedOrigin: '' } }))
    return
  }
  const deviceId = dom.defaultView?.prompt('中转设备标识')?.trim()
  const relayEntryId = dom.defaultView?.prompt('中转绑定标识')?.trim()
  const transportVersion = dom.defaultView?.prompt('中转协议版本')?.trim()
  if (!deviceId || !relayEntryId || !transportVersion) return
  run(() => api.update({ peerHostId: record.id, displayName, route: { kind: 'relay', deviceId, relayEntryId, transportVersion } }))
}

function actionButton(dom: Document, label: string, action: () => void): HTMLButtonElement {
  const button = dom.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', action)
  return button
}

function input(dom: Document, label: string, type: string): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = dom.createElement('label')
  wrapper.textContent = label
  const control = dom.createElement('input')
  control.type = type
  control.required = true
  wrapper.append(control)
  return { wrapper, input: control }
}

function redactFingerprint(value: string | null): string {
  if (value === null || value.length <= 12) return value ?? '未知'
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}
