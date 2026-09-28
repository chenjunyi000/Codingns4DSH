import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { readSessionChangedFiles } from '../data/build/dist/host/session-changes.js'
import { createFileManagementFeature } from '../data/build/dist/host/features/file-management.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { registerSessionChangedFilesView } from '../data/build/dist/client/session-changed-files-view.js'

test('会话修改文件优先从 DSH 原生 tool/call 事件提取并过滤工作区外路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-changes-'))
  try {
    const result = await readSessionChangedFiles({
      nativeSessions: {
        get: () => ({ snapshotEvents: () => [
          { type: 'tool/call', data: { name: 'write_file', arguments: JSON.stringify({ path: 'src/index.ts' }) } },
          { type: 'tool/call', data: { name: 'apply_patch', arguments: '*** Update File: src/app.ts\n*** Update File: ../outside.ts' } },
        ] }),
      },
    }, 'session-1', root)
    assert.deepEqual(result.paths, ['src/app.ts', 'src/index.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('原生事件没有文件路径时回退读取会话 JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-session-jsonl-'))
  const jsonl = join(root, 'session.jsonl')
  try {
    await writeFile(jsonl, [
      JSON.stringify({ type: 'session', id: 'session-2' }),
      JSON.stringify({ type: 'tool/call', data: { arguments: JSON.stringify({ file_path: 'src/from-jsonl.ts' }) } }),
      '不完整尾行',
    ].join('\n'), 'utf8')
    const result = await readSessionChangedFiles({
      nativeSessions: {
        get: () => ({ snapshotEvents: () => [], rawStoreRef: jsonl }),
      },
    }, 'session-2', root)
    assert.deepEqual(result.paths, ['src/from-jsonl.ts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('文件管理 Host 注册会话修改查询 RPC', () => {
  const table = new CodingNsRpcTable()
  const feature = createFileManagementFeature()
  const resources = { add(disposer: () => void) { this.disposer = disposer }, disposer: () => undefined }
  feature.start({ descriptor: feature.descriptor, resources, services: { rpc: table } })
  assert.ok(table.resolve('fileManagement/session-changes'))
  resources.disposer()
})

test('没有 uiConversation.views 时仍注册 conversation.view 标签', () => {
  const registrations: Array<{ readonly options: Record<string, unknown>; readonly component: unknown }> = []
  const disposers: Array<() => void> = []
  const slots = {
    inject(_key: string, callback: () => (() => void) | undefined) {
      const dispose = callback()
      if (dispose !== undefined) disposers.push(dispose)
      return () => undefined
    },
    register(options: Record<string, unknown>, component: unknown) {
      registrations.push({ options, component })
      return () => undefined
    },
  }
  const dispose = registerSessionChangedFilesView({ slots }, { call: async () => ({ ok: true, value: undefined }) })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0]?.options.id, 'codingns4dsh/session-changed-files')
  const label = registrations[0]?.options.label
  assert.equal(typeof label, 'function')
  assert.equal((label as () => string)(), '修改文件')
  dispose?.()
  for (const disposer of disposers) disposer()
})
