import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { DshClientSettingsScope, LocalScopeSnapshot } from '../../client/settings-bridge.js'
import {
  accepted,
  sameSettingsSnapshot,
  type CodingNsSettingsOperation,
  type CodingNsSettingsSnapshot,
  type CodingNsSettingsStore,
} from '../settings-store.js'

/**
 * 旧版 Client SettingsScope 到 Codingns4DSH 内部设置接口的适配器。
 *
 * SettingsScope 每次读取都可能返回新对象，而设置页通过 `useSyncExternalStore`
 * 读取快照。这里缓存上一次的快照，内容不变时不替换引用、不唤醒订阅者，避免
 * React 反复强制渲染（React #185）。
 */
export function createLegacyClientSettingsStore(scope: DshClientSettingsScope<CodingNsSettings>): CodingNsSettingsStore<CodingNsSettings> {
  const listeners = new Set<() => void>()
  let snapshot = fromScopeSnapshot(scope.getSnapshot())
  const refresh = (): void => {
    const next = fromScopeSnapshot(scope.getSnapshot())
    if (sameSettingsSnapshot(snapshot, next)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const unsubscribeScope = scope.subscribe(refresh)
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (operations, revision) => accepted(scope.mutate(operations as Parameters<typeof scope.mutate>[0], revision)),
    set: async (field, value) => accepted(scope.set(field, value)),
    unset: async (field) => accepted(scope.unset(field)),
    dispose: () => {
      unsubscribeScope()
      listeners.clear()
    },
  }
}

function fromScopeSnapshot(snapshot: LocalScopeSnapshot<CodingNsSettings>): CodingNsSettingsSnapshot<CodingNsSettings> {
  return { value: snapshot.value, revision: snapshot.revision, writable: snapshot.writable, status: snapshot.status }
}

export type CodingNsClientSettingsStore = CodingNsSettingsStore<CodingNsSettings>
export type { CodingNsSettingsOperation, CodingNsSettingsSnapshot }
