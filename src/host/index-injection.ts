/** 启动页注入表中的全局变量记录。 */
export interface DshIndexInjectionEntry {
  readonly kind?: unknown
  readonly name?: unknown
  readonly value?: unknown
  readonly [key: string]: unknown
}

/**
 * 在启动页声明 Host 所有权，同时保留 Desktop 已经提供的完整 Transport。
 *
 * 这里只使用 DSH WebServer 支持的 JSON global 行，不在首页安装全局 setter。
 * setter 会改变原生 Client 对 Transport 的启动顺序；在 Windows 重启时序下，
 * 这会把本应由 DSH Client 接管的全局状态变成插件的副作用。
 */
export function injectDshWebTransportOwnership(table: unknown[]): void {
  const index = table.findIndex((entry) => isTransportInjection(entry))
  if (index < 0) {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
    return
  }

  const entry = table[index]
  if (!isRecord(entry) || !isRecord(entry.value)) return
  table[index] = { ...entry, value: { ...entry.value, ownsHost: true } }
}

function isTransportInjection(value: unknown): value is DshIndexInjectionEntry {
  return isRecord(value) && value.name === '__DSH_TRANSPORT__'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
