import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { accepted, type CodingNsSettingsStore } from '../settings-store.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'

/** 0.1.7 Client ConfigForm 的最小结构化边界。 */
export interface DshConfigForm<T> {
  getSnapshot(): { readonly value: T | undefined; readonly revision?: number; readonly writable: boolean; readonly status?: 'loading' | 'ready' | 'unavailable' }
  subscribe(listener: () => void): () => void
  mutate(operations: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[], expectedRevision?: number): Promise<void | boolean>
  set(field: string, value: unknown): Promise<void | boolean>
  unset(field: string): Promise<void | boolean>
}

export interface DshClientConfigForms {
  get<T>(namespace: string): DshConfigForm<T> | undefined
  /** 0.1.7 ConfigForms 的共享 settings mirror；用于确认真正被 Host 提供的 entry。 */
  describe?: () => {
    getSnapshot: () => {
      readonly view?: { readonly namespaces: readonly { readonly ns: string }[] }
    }
  }
}

/** 通过 Codingns4DSH Host RPC 写入设置；省略 ConfigForm 的全局 revision 栅栏。 */
export interface DshConfigFormUnfencedWriter {
  (operations: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[]): Promise<{
    readonly value: CodingNsSettings
    readonly revision: number
  }>
}

export interface DshConfigFormSettingsOptions {
  /** DSH 0.1.7 后台可能持续更新同一 entry 的 Host-only 索引时使用。 */
  readonly writeUnfenced?: DshConfigFormUnfencedWriter
}

/** 0.1.7 Client ConfigForm 路由适配器。 */
export function createConfigFormSettingsStore(
  forms: DshClientConfigForms,
  namespace: string,
  options: DshConfigFormSettingsOptions = {},
): CodingNsSettingsStore<CodingNsSettings> {
  const form = forms.get<CodingNsSettings>(namespace)
  if (form === undefined) {
    return {
      getSnapshot: () => ({ value: undefined, revision: undefined, writable: false, status: 'unavailable' }),
      subscribe: () => () => undefined,
      mutate: async () => false,
      set: async () => false,
      unset: async () => false,
    }
  }
  const hostWriterAvailable = options.writeUnfenced !== undefined
  let snapshot = toStoreSnapshot(form.getSnapshot(), hostWriterAvailable)
  debugInfo('codingns4dsh: client config form selected', {
    namespace,
    status: snapshot.status,
    revision: snapshot.revision,
    writable: snapshot.writable,
  })
  const listeners = new Set<() => void>()
  const refresh = (): void => {
    const next = toStoreSnapshot(form.getSnapshot(), hostWriterAvailable)
    // 自有 Host RPC 的写入答复可能先于原生 mirror 事件到达；旧 revision
    // 只能被丢弃，不能把刚接受的模块开关覆盖回去。
    if (snapshot.revision !== undefined && next.revision !== undefined && next.revision < snapshot.revision) return
    if (sameSnapshot(snapshot, next)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const unsubscribeForm = form.subscribe(refresh)
  const publishWrite = (response: { readonly value: CodingNsSettings; readonly revision: number }): boolean => {
    const next = {
      value: toClientValue(response.value),
      revision: response.revision,
      writable: true,
      status: 'ready' as const,
    }
    if (sameSnapshot(snapshot, next)) return true
    snapshot = next
    for (const listener of [...listeners]) listener()
    return true
  }
  const write = async (
    operations: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[],
    formWrite: () => Promise<void | boolean>,
    formRetry: () => Promise<void | boolean> = () => form.mutate(operations),
  ): Promise<boolean> => {
    if (options.writeUnfenced !== undefined) {
      debugInfo('codingns4dsh: client settings host rpc write', {
        namespace,
        paths: operations.map((operation) => operation.path.join('.')),
      })
      const response = await options.writeUnfenced(operations)
      debugInfo('codingns4dsh: client settings host rpc write accepted', {
        namespace,
        revision: response.revision,
      })
      return publishWrite(response)
    }
    const result = await writeWithRetry(formWrite, formRetry)
    refresh()
    return result
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: async (operations, revision) => {
      return write(operations, () => form.mutate(operations, revision))
    },
    set: async (field, value) => {
      return write([{ op: 'set', path: [field], value }], () => form.set(field, value), () => form.set(field, value))
    },
    unset: async (field) => {
      return write([{ op: 'unset', path: [field] }], () => form.unset(field), () => form.unset(field))
    },
    dispose: () => {
      unsubscribeForm()
      listeners.clear()
    },
  }
}

/**
 * ConfigForm 在 revision 过期时会返回 false，并先异步恢复 Host 快照。
 * 设置页的编辑器不会感知这次恢复，因此立刻重试一次最新 revision，避免
 * 用户看到控件可以操作却始终回弹到旧值。只重试一次，真正的拒绝仍然返回
 * false，调用方可以显示明确错误。
 */
async function writeWithRetry(
  first: () => Promise<void | boolean>,
  retry: () => Promise<void | boolean>,
): Promise<boolean> {
  const result = await accepted(first())
  if (result) return true
  debugWarn('codingns4dsh: client config form write rejected; retrying with latest revision')
  const retried = await accepted(retry())
  debugInfo('codingns4dsh: client config form write retry completed', { accepted: retried })
  return retried
}

function toStoreSnapshot(
  snapshot: ReturnType<DshConfigForm<CodingNsSettings>['getSnapshot']>,
  hostWriterAvailable = false,
) {
  const value = toClientValue(snapshot.value)
  return {
    value: value as CodingNsSettings | undefined,
    revision: snapshot.revision,
    // 0.1.7 ConfigForm 的 writable 只描述原生表单镜像；插件自己的 Host
    // RPC 是实际写入边界，因此存在该 writer 时不能把开关误判为只读。
    writable: snapshot.writable || hostWriterAvailable,
    status: snapshot.status ?? 'ready' as const,
  }
}

function toClientValue(value: CodingNsSettings | undefined): CodingNsSettings | undefined {
  return value === undefined
    ? undefined
    : (({ cliSessions: _cliSessions, ...clientValue }) => clientValue)(value)
}

function sameSnapshot(left: ReturnType<typeof toStoreSnapshot>, right: ReturnType<typeof toStoreSnapshot>): boolean {
  return sameConfigValue(left.value, right.value)
    && left.revision === right.revision
    && left.writable === right.writable
    && left.status === right.status
}

/** ConfigForm 可能在每次读取时返回新对象；按配置内容比较，避免无意义地唤醒所有消费者。 */
function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameConfigValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameConfigValue(leftRecord[key], rightRecord[key]))
}
