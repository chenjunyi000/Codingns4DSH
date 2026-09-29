import type { CodingNsCliAdapterRegistry } from './registry.js'
import type { CodingNsSubagentConversations } from './subagent-conversations.js'

/**
 * cliAdapters 功能模块装配完成后登记注册表，供跨模块消费（如 agent_subagent
 * 工具）。注册表生命周期归功能模块所有：停用时必须置空，避免工具拿到已释放
 * 的实例。
 */
let current: CodingNsCliAdapterRegistry | undefined
let subagentConversations: CodingNsSubagentConversations | undefined

export function setAdapterRegistry(registry: CodingNsCliAdapterRegistry | undefined): void {
  current = registry
}

export function getAdapterRegistry(): CodingNsCliAdapterRegistry | undefined {
  return current
}

export function setSubagentConversations(value: CodingNsSubagentConversations | undefined): void {
  subagentConversations = value
}

export function getSubagentConversations(): CodingNsSubagentConversations | undefined {
  return subagentConversations
}
