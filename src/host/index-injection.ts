/** 启动页注入表中的全局变量记录。 */
export interface DshIndexInjectionEntry {
  readonly kind?: unknown
  readonly name?: unknown
  readonly value?: unknown
  readonly [key: string]: unknown
}

/**
 * 为普通 Web 入口声明 Host 所有权，同时保留 Desktop 已注入的完整 Transport。
 * Desktop 的 Transport 可能包含 streamBaseUrl；直接追加同名全局会让后者覆盖
 * 前者，导致远程请求退回 dsh-app://app 并返回 404。
 */
export function injectDshWebTransportOwnership(table: unknown[]): void {
  const index = table.findIndex((entry) => isTransportInjection(entry))
  if (index < 0) {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
    return
  }

  const entry = table[index]
  if (!isRecord(entry) || !isRecord(entry.value)) return
  table[index] = {
    ...entry,
    value: { ...entry.value, ownsHost: true },
  }
}

function isTransportInjection(value: unknown): value is DshIndexInjectionEntry {
  return isRecord(value) && value.name === '__DSH_TRANSPORT__'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
