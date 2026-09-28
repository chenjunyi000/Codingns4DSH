/** PeerHost 目标路由；短期 relay ticket 永远不属于持久配置。 */
export type PeerHostRoute =
  | {
      readonly kind: 'lan'
      readonly baseUrl: string
      readonly normalizedOrigin: string
    }
  | {
      readonly kind: 'relay'
      readonly deviceId: string
      readonly relayEntryId: string
      readonly transportVersion: string
    }

export type PeerHostStatus =
  | 'configured'
  | 'checking'
  | 'ready'
  | 'plugin_missing'
  | 'version_mismatch'
  | 'identity_changed'
  | 'session_required'
  | 'unreachable'
  | 'reconnecting'
  | 'disabled'

/** Host 侧保存的 PeerHost 配置与脱敏握手状态。凭据不在此 DTO 中。 */
export interface PeerHostRecord {
  readonly id: string
  readonly ownerUserId: string
  readonly displayName: string
  readonly route: PeerHostRoute
  readonly status: PeerHostStatus
  readonly pluginId: string | null
  readonly pluginVersion: string | null
  readonly dshVersion: string | null
  readonly apiCompatibility: string | null
  readonly fingerprint: string | null
  readonly lastCheckedAt: number | null
  readonly lastErrorCode: PeerHostErrorCode | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** Client 管理面板可见的 PeerHost 摘要；路由详情和所有凭据只留在 Host。 */
export type PeerHostClientRoute =
  | { readonly kind: 'lan' }
  | { readonly kind: 'relay' }

export type PeerHostClientRecord = Omit<PeerHostRecord, 'route'> & {
  readonly route: PeerHostClientRoute
}

/** 当前 Host 插件自有 WebSocket 入口；不包含任何目标 Host 地址或凭据。 */
export interface PeerHostWebSocketEndpoint {
  readonly host: string
  readonly port: number
  readonly path: string
}

/** 所有跨 Host 资源共用的完整作用域。 */
export interface HostScope {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
  readonly sessionId: string | null
  readonly scopeGeneration: number
}

/** 会话摘要只用于聚合导航，不包含历史消息或工具内容。 */
export interface PeerHostSessionRecord {
  readonly scope: HostScope
  readonly title: string
  readonly status: string
  readonly updatedAt: number
}

/** 当前 Host 和 PeerHost 统一使用的工作区摘要。 */
export interface AggregateWorkspaceSummary {
  readonly key: string
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
  readonly displayName: string
  readonly hostLabel: string
  readonly availability: 'ready' | 'checking' | 'unreachable' | 'unsupported'
  readonly sessions: readonly PeerHostSessionRecord[]
}

export interface AggregateHostResult {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly hostLabel: string
  readonly availability: 'ready' | 'checking' | 'unreachable' | 'unsupported'
  readonly errorCode: PeerHostErrorCode | null
  /** 摘要能力不可用时保留可诊断原因，禁止以空工作区伪装成功。 */
  readonly diagnostic?: string
  readonly workspaces: readonly AggregateWorkspaceSummary[]
}

export const PEER_HOST_ERROR_CODES = {
  NOT_FOUND: 'PEER_HOST_NOT_FOUND',
  NOT_READY: 'PEER_HOST_NOT_READY',
  SESSION_REQUIRED: 'PEER_HOST_SESSION_REQUIRED',
  PROXY_PATH_NOT_ALLOWED: 'PEER_HOST_PROXY_PATH_NOT_ALLOWED',
  SCOPE_MISMATCH: 'PEER_HOST_SCOPE_MISMATCH',
  PROXY_UNREACHABLE: 'PEER_HOST_PROXY_UNREACHABLE',
  RESPONSE_INVALID: 'PEER_HOST_RESPONSE_INVALID',
  TOOL_UNSUPPORTED: 'PEER_HOST_TOOL_UNSUPPORTED',
  INVALID_ROUTE: 'PEER_HOST_INVALID_ROUTE',
  DUPLICATE: 'PEER_HOST_DUPLICATE',
  PLUGIN_MISSING: 'PEER_HOST_PLUGIN_MISSING',
  VERSION_MISMATCH: 'PEER_HOST_VERSION_MISMATCH',
  IDENTITY_CHANGED: 'PEER_HOST_IDENTITY_CHANGED',
  UNREACHABLE: 'PEER_HOST_UNREACHABLE',
  RELAY_UNAVAILABLE: 'PEER_HOST_RELAY_UNAVAILABLE',
  AGGREGATE_UNAVAILABLE: 'PEER_HOST_AGGREGATE_UNAVAILABLE',
  STALE_GENERATION: 'PEER_HOST_STALE_GENERATION',
} as const

export type PeerHostErrorCode = typeof PEER_HOST_ERROR_CODES[keyof typeof PEER_HOST_ERROR_CODES]

/** 可安全返回 Client 的结构化错误，不携带凭据、完整 URL 或内容数据。 */
export interface PeerHostErrorShape {
  readonly code: PeerHostErrorCode
  readonly peerHostId?: string
  readonly message: string
}

/** 作用域管理器仍使用的兼容引用；新跨 Host 代码应优先使用 HostScope。 */
export interface ResourceScopeRef {
  hostId: string
  workspaceId: string
  targetHostId: string | null
  scopeGeneration: number
  sessionId?: string | null
}

export interface ResourceScopeInput {
  hostId: string
  workspaceId: string
  targetHostId: string | null
  sessionId?: string | null
}

export type ResourceScopeSnapshot = Readonly<ResourceScopeRef>

/** 作用域拥有的清理函数。清理函数必须可重复调用而不会产生副作用。 */
export type ResourceScopeDisposer = () => void | Promise<void>

/** 作用域已经失效时统一抛出的错误。 */
export class ResourceScopeStaleError extends Error {
  readonly code = 'RESOURCE_SCOPE_STALE' as const

  constructor(message = 'Resource scope is stale') {
    super(message)
    this.name = 'ResourceScopeStaleError'
  }
}
