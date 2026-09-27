import type { CodingNsRpcClient } from './features/types.js'
import { callCodingNsRpc } from './settings-bridge.js'

type FileEntryElement = HTMLElement & { dataset: DOMStringMap }
type ClipboardState = { mode: 'copy' | 'cut'; paths: string[] }
type EditorState = { root: HTMLElement; body: HTMLElement; textarea: HTMLTextAreaElement; path: FileTarget; buttons: HTMLElement }
type FileTarget = { path: string; sessionId?: string }

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.ini', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv', '.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.htm', '.env', '.gitignore', '.conf', '.properties', '.sh', '.py', '.sql'])

/** 给 DSH 原生文件树和文本查看器补充文件操作，不接管 DSH 自己的渲染状态。 */
export function startFileManagementDom(rpc: CodingNsRpcClient): () => void {
  // Client 功能也会在 H5/非浏览器测试环境被装配；没有 DOM 时保持惰性空实现。
  if (typeof document === 'undefined') return () => {}

  let menu: HTMLElement | undefined
  let clipboard: ClipboardState | undefined
  let editor: EditorState | undefined
  let disposed = false
  const observer = typeof MutationObserver === 'undefined'
    ? undefined
    : new MutationObserver(() => { if (!disposed) enhanceEditors() })

  const closeMenu = (): void => { menu?.remove(); menu = undefined }
  const onContextMenu = (event: MouseEvent): void => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-files-entry][data-files-path]')
    if (target == null) return
    event.preventDefault()
    event.stopPropagation()
    openMenu(target, event.clientX, event.clientY)
  }
  const onDocumentClick = (event: MouseEvent): void => {
    if (menu !== undefined && !menu.contains(event.target as Node)) closeMenu()
  }
  const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeMenu() }
  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('click', onDocumentClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  observer?.observe(document.body, { childList: true, subtree: true })
  enhanceEditors()

  return () => {
    disposed = true
    closeMenu()
    if (editor !== undefined) editor.body.style.display = ''
    editor?.buttons.remove()
    editor?.textarea.remove()
    editor = undefined
    observer?.disconnect()
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('click', onDocumentClick, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  function openMenu(item: FileEntryElement, x: number, y: number): void {
    closeMenu()
    const path = item.dataset.filesPath ?? ''
    const kind = item.dataset.filesEntry === 'directory' ? 'directory' : 'file'
    if (path === '') return
    const base = kind === 'directory' ? path : parentPath(path)
    const panel = item.closest<HTMLElement>('[data-files-state="tree"]')
    const items: Array<{ label: string; disabled?: boolean; action: () => void | Promise<void> }> = [
      { label: kind === 'directory' ? '展开文件夹' : '打开文件', action: () => clickEntry(item) },
      { label: '下载文件', disabled: kind !== 'file', action: () => void downloadFile({ path }) },
      { label: '新建文件', action: () => void createEntry(base, false) },
      { label: '新建目录', action: () => void createEntry(base, true) },
      { label: '重命名/移动', action: () => void renameEntry(path) },
      { label: '复制', action: () => { clipboard = { mode: 'copy', paths: [path] } } },
      { label: '剪切', action: () => { clipboard = { mode: 'cut', paths: [path] } } },
      { label: '粘贴', disabled: clipboard === undefined, action: () => void pasteEntry(base, panel) },
      { label: '复制相对路径', action: () => void copyPath(path, false) },
      { label: '复制绝对路径', action: () => void copyPath(path, true) },
      { label: '添加到 Git 排除', action: () => void runMutation('git-ignore', { paths: [path] }, panel) },
      { label: '删除', action: () => void deleteEntry(path, panel) },
    ]
    menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.style.cssText = 'position:fixed;z-index:2147483647;min-width:190px;padding:5px;background:var(--dsw-alias-bg-layer-3,#242526);border:1px solid var(--dsw-alias-border-l2,#666);border-radius:8px;box-shadow:0 8px 30px #0008;color:var(--dsw-alias-label-primary,#eee);font:13px var(--dsw-font,system-ui,sans-serif)'
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.disabled = item.disabled === true
      button.style.cssText = 'display:block;width:100%;padding:7px 10px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit'
      button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = 'var(--dsw-alias-interactive-bg-hover,#3a3b3d)' })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      button.addEventListener('click', () => { closeMenu(); void item.action() })
      menu.append(button)
    }
    document.body.append(menu)
    const width = menu.offsetWidth || 190
    const height = menu.offsetHeight || 360
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`
  }

  function clickEntry(item: HTMLElement): void {
    ;(item.querySelector('button') ?? item).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }

  async function createEntry(base: string, directory: boolean): Promise<void> {
    const name = window.prompt(directory ? '输入新目录名称或相对路径' : '输入新文件名称或相对路径', '')?.trim()
    if (!name) return
    await runMutation(directory ? 'create-directory' : 'create-file', { path: joinPath(base, name) }, null)
  }

  async function renameEntry(path: string): Promise<void> {
    const next = window.prompt('输入新的文件名或相对路径', leaf(path))?.trim()
    if (!next || next === leaf(path)) return
    const destination = isAbsoluteLike(next) ? next : joinPath(parentPath(path), next)
    await runMutation('rename', { path, destination }, null)
  }

  async function pasteEntry(base: string, panel: HTMLElement | null): Promise<void> {
    if (clipboard === undefined) return
    await runMutation(clipboard.mode === 'copy' ? 'copy' : 'move', { paths: clipboard.paths, destination: base }, panel)
    if (clipboard.mode === 'cut') clipboard = undefined
  }

  async function deleteEntry(path: string, panel: HTMLElement | null): Promise<void> {
    if (!window.confirm(`确定删除“${leaf(path)}”吗？`)) return
    await runMutation('delete', { paths: [path] }, panel)
  }

  async function downloadFile(target: FileTarget): Promise<void> {
    try {
      const result = await call('read', target) as { content: string }
      const blob = new Blob([result.content], { type: 'text/plain;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = leaf(target.path)
      link.click()
      URL.revokeObjectURL(link.href)
    } catch (error) { showNotice(errorMessage(error)) }
  }

  async function copyPath(path: string, absolute: boolean): Promise<void> {
    const value = absolute ? path : relativePath(path)
    try { await navigator.clipboard.writeText(value); showNotice(absolute ? '已复制绝对路径' : '已复制相对路径') } catch { showNotice('复制路径失败') }
  }

  async function runMutation(action: string, payload: Record<string, unknown>, panel: HTMLElement | null): Promise<void> {
    try {
      await call(action, payload)
      refreshPanel(panel)
      showNotice('文件操作已完成')
    } catch (error) { showNotice(errorMessage(error)) }
  }

  function refreshPanel(panel: HTMLElement | null): void {
    const reload = panel?.querySelector<HTMLButtonElement>('[data-files-reload]')
      ?? findButton(panel, ['重新读取', '重新读取文件'])
      ?? findButton(document, ['重新读取', '重新读取文件'])
    if (reload !== null && reload !== undefined) reload.click()
  }

  function enhanceEditors(): void {
    for (const root of document.querySelectorAll<HTMLElement>('[data-document-preview]')) {
      if (root.dataset.fileManagementEditor === 'true') continue
      const url = root.getAttribute('data-textpreview-url') ?? ''
      if (root.getAttribute('data-textpreview-state') !== 'text' || !isEditableFile(url)) continue
      const header = root.querySelector<HTMLElement>('[data-textpreview-path]')?.parentElement
      if (header === null || header === undefined) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '编辑'
      button.title = '编辑文件'
      button.setAttribute('data-file-management-edit', 'true')
      button.style.cssText = 'margin-left:auto;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2,#666);border-radius:4px;background:transparent;color:inherit;cursor:pointer;font:inherit'
      button.addEventListener('click', () => void beginEdit(root, url, header, button))
      header.append(button)
      root.dataset.fileManagementEditor = 'true'
    }
  }

  async function beginEdit(root: HTMLElement, url: string, header: HTMLElement, editButton: HTMLButtonElement): Promise<void> {
    if (editor !== undefined) editor.buttons.remove()
    const target = parseFileTarget(url, root)
    if (target === undefined) { showNotice('无法解析当前文件路径'); return }
    try {
      const result = await call('read', target) as { content: string }
      const body = root.querySelector<HTMLElement>('[data-textpreview-body]')
      if (body === null) return
      const textarea = document.createElement('textarea')
      textarea.value = result.content
      textarea.setAttribute('aria-label', '文件内容编辑器')
      textarea.style.cssText = 'box-sizing:border-box;width:100%;height:100%;min-height:360px;resize:none;padding:16px;background:transparent;color:inherit;border:0;outline:0;font:inherit;line-height:1.55'
      body.style.display = 'none'
      body.parentElement?.append(textarea)
      const buttons = document.createElement('span')
      buttons.style.cssText = 'display:inline-flex;gap:6px;margin-left:auto'
      const save = document.createElement('button')
      save.type = 'button'; save.textContent = '保存'; save.style.cssText = editButton.style.cssText
      const cancel = document.createElement('button')
      cancel.type = 'button'; cancel.textContent = '取消'; cancel.style.cssText = editButton.style.cssText
      buttons.append(save, cancel)
      editButton.remove()
      header.append(buttons)
      editor = { root, body, textarea, path: target, buttons }
      save.addEventListener('click', () => void saveEdit())
      cancel.addEventListener('click', cancelEdit)
    } catch (error) { showNotice(errorMessage(error)) }
  }

  async function saveEdit(): Promise<void> {
    if (editor === undefined) return
    try {
      await call('write', { ...editor.path, content: editor.textarea.value })
      const reload = editor.root.querySelector<HTMLButtonElement>('[data-textpreview-tool="reload"]')
        ?? findButton(editor.root.parentElement, ['重新读取文件', '重新读取'])
        ?? findButton(document, ['重新读取文件', '重新读取'])
      cancelEdit()
      reload?.click()
      showNotice('文件已保存')
    } catch (error) { showNotice(errorMessage(error)) }
  }

  function cancelEdit(): void {
    if (editor === undefined) return
    editor.textarea.remove()
    editor.body.style.display = ''
    editor.buttons.remove()
    editor.root.dataset.fileManagementEditor = ''
    editor = undefined
    enhanceEditors()
  }

  async function call(action: string, payload: unknown): Promise<unknown> {
    return callCodingNsRpc(rpc, `fileManagement/${action}`, payload)
  }
}

function findButton(root: ParentNode | null | undefined, labels: readonly string[]): HTMLButtonElement | undefined {
  if (root === null || root === undefined) return undefined
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    const label = button.getAttribute('aria-label')?.trim() || button.textContent?.trim() || ''
    if (labels.includes(label)) return button
  }
  return undefined
}

function parseFileTarget(url: string, root: HTMLElement): FileTarget | undefined {
  const match = /^dsh-resource:\/\/file\/session\/([^/]+)\/(.*)$/u.exec(url)
  if (match === null) return undefined
  const sessionId = decodeURIComponent(match[1] ?? '')
  const path = decodeURIComponent(match[2] ?? '')
  const workspaceRoot = root.closest('[data-sidebar-right-panel]')?.querySelector<HTMLElement>('[data-files-root]')?.getAttribute('data-files-root')
  return workspaceRoot === null || workspaceRoot === undefined || workspaceRoot === ''
    ? { sessionId, path }
    : { path: joinPath(workspaceRoot, path) }
}

function isEditableFile(url: string): boolean {
  const path = url.split('/').pop() ?? ''
  const dot = path.lastIndexOf('.')
  return path.startsWith('.gitignore') || (dot >= 0 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase()))
}

function parentPath(path: string): string { const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return index <= 0 ? path.slice(0, Math.max(index, 1)) : path.slice(0, index) }
function leaf(path: string): string { return path.split(/[\\/]/u).filter(Boolean).pop() ?? path }
function isAbsoluteLike(path: string): boolean { return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) }
function joinPath(base: string, child: string): string { const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'; return `${base.replace(/[\\/]$/u, '')}${separator}${child.replace(/^[\\/]+/u, '')}` }
function relativePath(path: string): string { const root = document.querySelector<HTMLElement>('[data-files-root]')?.getAttribute('data-files-root'); return root === null || root === undefined ? path : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function showNotice(message: string): void { const notice = document.createElement('div'); notice.textContent = message; notice.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);padding:8px 14px;border-radius:6px;background:#2d2f33;color:#fff;box-shadow:0 4px 18px #0008;font:13px system-ui'; document.body.append(notice); globalThis.setTimeout(() => notice.remove(), 2200) }
