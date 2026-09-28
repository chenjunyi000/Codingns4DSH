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
 * 页面可能由 Desktop Shell 在更晚的阶段注入自己的 Transport；因此找不到
 * 已有 Transport 时必须保持不变，不能追加同名全局，否则会覆盖 Desktop 的
 * `streamBaseUrl`，让 `/api/remote.mux` 退回 `ws://app`。
 */
export function injectDshWebTransportOwnership(table: unknown[]): void {
  const index = table.findIndex((entry) => isTransportInjection(entry))
  if (index < 0) return

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
