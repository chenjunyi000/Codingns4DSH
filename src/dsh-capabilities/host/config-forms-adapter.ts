import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsSettingsOperation, CodingNsSettingsStore } from '../settings-store.js'

/**
 * Host 设置服务的跨版本最小契约。
 *
 * DSH 0.1.x 曾导出 `SettingsProvider`/`SettingsScope`，0.2 改为
 * `SettingsForms`。业务模块不应直接依赖任一版本类型，这里只描述插件实际
 * 使用的结构；旧版和新版都通过运行时探测接入。
 */
export interface DshHostSettingsProvider extends DshHostConfigSettings {
  readonly writable?: boolean
  readonly documentPath?: string | undefined
  readonly get?: (namespace: string) => unknown
}

/** 供 Host 业务模块使用的稳定设置作用域。 */
export interface DshHostSettingsScope<T> {
  get(): T
  watch(listener: (next: T, previous: T) => void | Promise<void>): () => void
  update(patch: Partial<T> | Record<string, unknown>): Promise<void>
  replace(section: T): Promise<void>
}

/** 0.1.7 Config/SettingsForms 的最小结构化边界，避免业务代码绑定 DSH 类型包。 */
export interface DshHostConfigSettings {
  describe(options?: { readonly redactSecrets?: boolean }): readonly DshSettingsDescriptor[]
  mutate?(namespace: string, operations: readonly CodingNsSettingsOperation[], expectedRevision?: number): Promise<void>
  update?(namespace: string, patch: object, expectedRevision?: number): Promise<void>
  replace?(namespace: string, section: object, expectedRevision?: number): Promise<void>
  on?(event: 'settings/document-updated', listener: (namespace: string, revision: number) => void): () => void
}

export interface DshSettingsDescriptor {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
  readonly writable?: boolean
}

/** 0.1.7 Host Config 路由适配器。 */
export function createConfigSettingsStore(
  settings: DshHostConfigSettings,
  namespace: string,
): CodingNsSettingsStore<CodingNsSettings> {
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const unsubscribeHost = settings.on?.('settings/document-updated', (updatedNamespace) => {
    if (updatedNamespace === namespace) notify()
  })
  const readSnapshot = (): { value: CodingNsSettings | undefined; revision: number | undefined; writable: boolean; status: 'loading' | 'ready' | 'unavailable' } => {
    const descriptor = settings.describe({ redactSecrets: true }).find((item) => item.ns === namespace)
    if (descriptor === undefined) return { value: undefined, revision: undefined, writable: false, status: 'unavailable' }
    return { value: descriptor.value as CodingNsSettings, revision: descriptor.revision, writable: descriptor.writable !== false, status: 'ready' }
  }
  let current = readSnapshot()
  const refresh = (): void => {
    const next = readSnapshot()
    if (current.value === next.value && current.revision === next.revision && current.writable === next.writable && current.status === next.status) return
    current = next
    notify()
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: async (operations, expectedRevision) => {
      if (typeof settings.mutate === 'function') {
        await settings.mutate(namespace, operations, expectedRevision)
      } else if (typeof settings.update === 'function' && operations.every((operation) => operation.op === 'set')) {
        await settings.update(namespace, operationsToPatch(operations), expectedRevision)
      } else {
        throw new Error('DSH SettingsForms 不支持 mutate；含 unset 的写入不能降级为 update')
      }
      refresh()
      return true
    },
    set: async (field, value) => {
      if (typeof settings.mutate === 'function') await settings.mutate(namespace, [{ op: 'set', path: [field], value }])
      else if (typeof settings.update === 'function') await settings.update(namespace, { [field]: value })
      else throw new Error('DSH SettingsForms 不支持 mutate/update')
      refresh()
      return true
    },
    unset: async (field) => {
      if (typeof settings.mutate === 'function') await settings.mutate(namespace, [{ op: 'unset', path: [field] }])
      else throw new Error('DSH SettingsForms 不支持 mutate，无法 unset')
      refresh()
      return true
    },
    dispose: () => { unsubscribeHost?.(); listeners.clear() },
  }
}

function operationsToPatch(operations: readonly CodingNsSettingsOperation[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const operation of operations) {
    if (operation.path.length !== 1) throw new Error('DSH update 回退只支持一级设置字段')
    if (operation.op === 'set') patch[operation.path[0]!] = operation.value
  }
  return patch
}
