# 设计文档 - PeerHost 管理与多 Host 工作区会话聚合

状态：详细设计完成，待实施。

## 1. 目标与约束

PeerHost 的本质是“当前 Host 代理访问多个目标 Host 的资源”，不是把浏览器当前登录的 Host 替换成另一台 Host。当前 Host 仍然拥有登录会话、PeerHost 配置、目标 Host 凭据和代理权限；Client 只选择目标 Host 作用域并提交 `targetHostId`。

本设计必须满足以下硬约束：

1. 当前 Host、PeerHost 和同名工作区/会话必须使用稳定作用域隔离。
2. 目标 access token、refresh token、密码和中转短期 ticket 只能存在当前 Host 的敏感存储边界。
3. HTTP 和 WebSocket 代理都采用正向白名单，不允许任意 URL 或任意消息透传。
4. 单个 PeerHost 的故障不能阻塞当前 Host 或其他 PeerHost。
5. 版本差异只在 `src/dsh-capabilities/` 和 Transport 适配边界处理，业务模块不写 DSH 版本分支。
6. DSH 0.1.6 缺少原生多 Host 导航扩展点时，允许使用现有 Remote Web Context 降级，但必须显式标记降级能力。

## 2. 总体架构

```text
浏览器 Client
  │ 仅携带 targetHostId + HostScope
  ▼
当前 DSH Host
  ├─ PeerHostFeatureRegistry
  ├─ PeerHostStore（配置、状态、加密会话）
  ├─ PeerHostHandshakeService
  ├─ HostApiProxyService（HTTP 白名单）
  ├─ HostWsProxyService（WS 路径、消息白名单）
  ├─ HostRouter / ScopeGuard
  └─ PeerHostAggregateService（摘要聚合）
  │
  ├─ 局域网 HTTP/WS 目标 Host
  └─ 中转 Host-to-Host Transport（需单独能力验证）
```

### 2.1 边界职责

| 边界 | 负责 | 不负责 |
| --- | --- | --- |
| `PeerHostStore` | 保存配置、握手结果、状态和加密目标登录态 | 不向 Client 返回 token |
| `PeerHostHandshakeService` | 产品、插件、版本、API 能力和 fingerprint 检查 | 不加载工作区全文 |
| `HostApiProxyService` | 将允许的内部 API 映射到目标 Host | 不接受客户端目标 URL |
| `HostWsProxyService` | 代理受支持的工作台 WebSocket 消息 | 不转发未知消息或二进制流 |
| `HostRouter` | 根据 `targetHostId` 解析 HostScope 和能力 | 不修改浏览器当前 Host 登录态 |
| `PeerHostAggregateService` | 并发获取摘要并合并为聚合 DTO | 不把远端资源复制成本地资源 |
| Client Feature | 展示管理入口、导航、会话和工具结果 | 不保存目标 Host 凭据 |

### 2.2 资源生命周期

1. 模块启用时注册 Host/Client 资源、状态检查和聚合导航。
2. 用户新增 PeerHost 后先保存配置，再执行握手；握手成功前不能显示为可用资源。
3. Client 选择资源时创建新的 `scopeGeneration`，旧作用域先失效，再关闭旧订阅和缓存。
4. 模块停用或当前 Host 重启时释放定时器、HTTP AbortController、WebSocket 和 Remote Web Context；持久配置保留。

## 3. 能力与 Feature 注册

PeerHost 作为独立 Feature 注册，不与现有局域网访问或中转访问 Feature 共用启停开关。

建议新增能力 ID：

```ts
type PeerHostCapabilityId =
  | 'peer-host.store'
  | 'peer-host.handshake'
  | 'peer-host.http-proxy'
  | 'peer-host.ws-proxy'
  | 'peer-host.aggregate'
  | 'peer-host.relay-route'
  | 'peer-host.native-navigation'
  | 'peer-host.remote-web-context-fallback'
```

能力矩阵中至少声明：运行端（Host/Client）、支持的 DSH 版本、检测函数、降级策略、使用者和测试 fixture。`peer-host.native-navigation` 不可用时只能降级到 `peer-host.remote-web-context-fallback`，不能伪装成完整原生三栏聚合。

Feature descriptor 示例：

```ts
{
  id: 'peer-host',
  requires: [
    { capability: 'peer-host.store', required: true, fallback: 'disable' },
    { capability: 'peer-host.handshake', required: true, fallback: 'disable' },
    { capability: 'peer-host.http-proxy', required: true, fallback: 'disable' },
    { capability: 'peer-host.aggregate', required: true, fallback: 'degrade' },
    { capability: 'peer-host.ws-proxy', required: false, fallback: 'degrade' }
  ]
}
```

## 4. 核心数据结构

### 4.1 PeerHostRecord

```ts
interface PeerHostRecord {
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
  readonly lastErrorCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
}
```

`id` 是当前 Host 内部稳定 ID。它不能由客户端传入目标 URL 派生，也不能因为路由从局域网切换到中转而改变。

### 4.2 PeerHostRoute

```ts
type PeerHostRoute =
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
```

中转路由只保存稳定设备/绑定标识和 Transport 版本，不把短期 ticket 写入配置。直连和中转属于同一 `PeerHostRecord` 的候选路由时，由 Host 侧健康检查选择当前路由。

### 4.3 状态模型

```ts
type PeerHostStatus =
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
```

状态转换只能由 Host 服务产生。Client 收到的是脱敏状态和诊断码，不直接推断目标 Host 是否可用。

### 4.4 HostScope

```ts
interface HostScope {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
  readonly sessionId: string | null
  readonly scopeGeneration: number
}
```

`hostId` 是作用域归属的逻辑 Host ID；当前 Host 使用固定的本地主机 ID，PeerHost 使用 `targetHostId` 对应的逻辑 ID。所有查询 key、WebSocket 订阅 key、右侧工具状态和异步回写都必须包含此结构，禁止使用裸 `workspaceId` 或裸 `sessionId`。

### 4.5 会话与聚合 DTO

```ts
interface PeerHostSessionRecord {
  readonly scope: HostScope
  readonly title: string
  readonly status: string
  readonly updatedAt: number
}

interface AggregateWorkspaceSummary {
  readonly key: string
  readonly hostId: string
  readonly targetHostId: string | null
  readonly workspaceId: string
  readonly displayName: string
  readonly hostLabel: string
  readonly availability: 'ready' | 'checking' | 'unreachable' | 'unsupported'
  readonly sessions: readonly PeerHostSessionRecord[]
}
```

聚合接口只返回工作区和会话摘要。会话历史、文件树、Git 状态、终端输出等内容必须在用户打开具体作用域后按需读取。

## 5. 握手、登录态与安全边界

### 5.1 握手接口

当前 Host 对每条 PeerHost 记录调用固定握手路径，建议内部契约如下：

```ts
interface PeerHostHandshakeResult {
  readonly productId: string
  readonly pluginId: string
  readonly pluginVersion: string
  readonly dshVersion: string
  readonly apiCompatibility: string
  readonly fingerprint: string
  readonly capabilities: readonly string[]
}
```

握手顺序：规范化路由 -> 建立连接 -> 验证产品和插件标识 -> 校验能力矩阵 -> 比较 fingerprint -> 写入状态。任何一步失败都保留配置，但禁止代理和聚合为可用 Host。

### 5.2 目标登录态

目标 access token、refresh token、过期时间和登录方式由 `PeerHostStore` 的敏感存储保存。Client 的登录响应只返回 `sessionRequired`、过期时间的粗粒度状态和错误码，不返回 token。

请求代理前执行：

1. 验证当前用户和 PeerHost 所有权。
2. 验证握手状态为 `ready` 且 fingerprint 未改变。
3. 读取当前 Host 保存的目标 access token。
4. token 过期时在 Host 侧刷新一次；刷新失败则清除该 PeerHost 会话并返回 `session_required`。
5. 将 Bearer token 只注入到 Host 到目标 Host 的出站请求。

### 5.3 指纹变化

目标地址返回新 fingerprint 时，必须先使旧会话和旧资源作用域失效，再保存新身份待用户重新确认。日志只记录 PeerHost ID、旧/新 fingerprint 的截断摘要和错误码。

### 5.4 PeerHost 管理 RPC

管理 RPC 只操作当前 Host 保存的 PeerHost 记录，不直接执行任意目标 URL 请求。建议内部契约如下：

```ts
interface PeerHostManagementRpc {
  list(): Promise<readonly PeerHostPublicDto[]>
  create(input: CreatePeerHostInput): Promise<PeerHostPublicDto>
  update(peerHostId: string, input: UpdatePeerHostInput): Promise<PeerHostPublicDto>
  remove(peerHostId: string): Promise<void>
  check(peerHostId: string): Promise<PeerHostPublicDto>
  login(peerHostId: string, input: PeerHostLoginInput): Promise<PeerHostPublicDto>
  logout(peerHostId: string): Promise<PeerHostPublicDto>
  reconnect(peerHostId: string): Promise<PeerHostPublicDto>
}
```

`PeerHostPublicDto` 只能包含名称、路由类型、状态、版本、能力摘要、脱敏 fingerprint、最近检查时间和错误码。`CreatePeerHostInput` 与 `UpdatePeerHostInput` 只能包含路由配置和展示名称；代理路径、目标 token、refresh token、密码和完整中转 ticket 不属于这些 DTO。所有 mutation 都必须在 Host 侧重新校验当前用户权限、输入规范化和重复目标。

## 6. HTTP 受控代理

### 6.1 路径模型

建议入口：

```text
/api/host-proxy/hosts/:peerHostId/resource/:resourcePath
```

客户端只传 `peerHostId`、固定资源类别和作用域参数；当前 Host 根据 PeerHostRecord 解析目标地址。不得接受 `baseUrl`、完整目标 URL 或任意请求头作为路由依据。

### 6.2 白名单

白名单按资源类别维护，并与能力矩阵和测试一一对应：

- 工作区和会话摘要、历史、发送消息、停止、权限回复。
- 文件树、文件读取和允许的保存操作。
- Git 状态、差异和明确支持的操作。
- 终端创建、订阅、输入、调整大小和关闭。
- 右侧栏已登记的工具快照与刷新接口。

以下路径默认拒绝：认证、PeerHost 管理、插件安装、任意管理 API、任意静态文件、递归代理入口和未登记的 `/api` 路径。

### 6.3 请求校验

代理层必须校验 HTTP 方法、路径、查询参数、请求体大小、Content-Type、作用域归属和响应头。错误统一映射为稳定错误码，例如：

```text
PEER_HOST_NOT_FOUND
PEER_HOST_NOT_READY
PEER_HOST_SESSION_REQUIRED
PEER_HOST_PROXY_PATH_NOT_ALLOWED
PEER_HOST_SCOPE_MISMATCH
PEER_HOST_PROXY_UNREACHABLE
PEER_HOST_RESPONSE_INVALID
```

响应不得回传目标 Host 的认证头、内部路径、完整 token、密码或未脱敏诊断字段。

## 7. WebSocket 受控代理

### 7.1 连接模型

Client 连接当前 Host 的固定 PeerHost WebSocket 路径，Host 再连接目标 Host 的工作台 WebSocket。两端连接生命周期绑定：任一端关闭，另一端按错误类别关闭或重连。

### 7.2 消息白名单

客户端消息至少覆盖：工作台订阅/刷新、文件树订阅/刷新、Git 订阅/刷新、终端订阅/输入/调整大小、会话订阅/加载更早历史。远端消息至少覆盖：快照、增量、会话历史、运行时消息、状态、权限请求、终端输出和错误。

消息转发前必须解析 `type`、`hostId`、`workspaceId`、`sessionId` 和 `scopeGeneration`；字段缺失、作用域不匹配或类型不在白名单时只向当前连接返回错误，不广播给其他连接。

### 7.3 背压与重连

每个 PeerHost WebSocket 使用有界消息队列。目标 Host 慢或队列达到上限时丢弃可重建的刷新事件，保留错误和终止事件；不得无限缓存会话消息。重连使用指数退避和上限，成功后重新创建 generation 并刷新摘要。

## 8. HostRouter 与作用域清理

`HostRouter` 是所有资源请求的唯一入口，职责是把 Client 请求转换为内部 `HostScope` 和目标 Host 适配器。

```ts
interface HostRouter {
  resolve(scope: HostScope): Promise<ResolvedHostRoute>
  assertScope(scope: HostScope, expected: HostScope): void
  invalidate(scope: HostScope): Promise<void>
}
```

切换顺序固定为：

1. 递增新 generation 并标记旧 scope inactive。
2. 取消旧 scope 的 AbortController。
3. 关闭旧 WebSocket、终端和右侧工具订阅。
4. 清理旧 scope 的短期缓存和 DOM/iframe 降级节点。
5. 建立新 scope 的历史请求和实时订阅。
6. 所有异步回写都比较 generation，不匹配则丢弃。

## 9. 聚合工作区与会话导航

### 9.1 聚合流程

1. 当前 Host 作为第一个并发任务，PeerHost 按记录分别启动独立超时任务。
2. 每个任务只请求摘要，不加载会话全文。
3. 将结果映射成 `AggregateWorkspaceSummary`，用 `hostId/workspaceId` 生成稳定 key。
4. 失败任务保留 Host 节点并展示状态，不能以空数组替代失败。
5. 合并完成后只更新仍然有效的当前选中作用域。

### 9.2 Host 标签

工作区名称显示为“工作区名称 + Host 标签”。Host 标签来自 PeerHost displayName；当前 Host 使用固定的“当前 Host”或用户配置别名。标签不参与资源 ID，不得通过改名破坏缓存和导航状态。

### 9.3 UI 入口与降级

PeerHost Feature 启用后，在右下角注册连接管理按钮；按钮只负责打开当前页面内的管理面板，不触发 Host 切换。管理面板显示配置、握手状态、版本、路由、最近检查和登录操作。

当 DSH 提供原生工作区/会话扩展点时，使用原生导航 adapter。当能力不可用时，使用 `remote-web-context` 挂载目标页面并限制在目标 Host 作用域；面板必须显示“远端 Web Context 降级”状态，不能把 iframe 内容冒充成完整原生三栏。

## 10. 远端会话与右侧工具路由

### 10.1 中栏消息和聊天输入

打开会话时先用 `HostScope` 请求目标历史，再建立目标 Host 的实时订阅。发送消息、停止、权限回复和问答都从当前会话 scope 生成请求，禁止从全局 active Host 推断目标。

### 10.2 右侧栏和工具

文件、Git、终端、调试和其他右侧工具都必须接收完整 `HostScope`。目标 Host 的路径、运行时和操作系统能力只在目标 Host 侧解析；当前 Host 不得把本地路径传给目标 Host，也不得让远端工具回调当前 Host 的本地文件系统。

每个工具在白名单中登记自己的 HTTP/WS 操作。尚未登记的工具返回 `PEER_HOST_TOOL_UNSUPPORTED` 并显示可用状态，不得静默回退到当前 Host。

## 11. 状态、错误与可观测性

### 11.1 错误分类

| 类别 | 示例 | 用户动作 |
| --- | --- | --- |
| 配置 | `PEER_HOST_INVALID_ROUTE`、`PEER_HOST_DUPLICATE` | 修改配置 |
| 握手 | `PEER_HOST_PLUGIN_MISSING`、`PEER_HOST_VERSION_MISMATCH` | 安装/升级插件 |
| 身份 | `PEER_HOST_IDENTITY_CHANGED` | 重新确认目标 Host |
| 登录 | `PEER_HOST_SESSION_REQUIRED` | 在管理面板登录 |
| 网络 | `PEER_HOST_UNREACHABLE`、`PEER_HOST_RELAY_UNAVAILABLE` | 检查网络或重连 |
| 作用域 | `PEER_HOST_SCOPE_MISMATCH`、`PEER_HOST_STALE_GENERATION` | 刷新当前资源 |
| 工具 | `PEER_HOST_TOOL_UNSUPPORTED` | 使用已支持工具 |

### 11.2 日志字段

日志允许记录 `peerHostId`、路由类型、目标 Host 脱敏 fingerprint、scope 摘要、错误码、耗时和状态码。禁止记录 token、密码、完整 ticket、完整 URL 查询串、文件内容、完整命令和模型消息。

## 12. 正确性属性

以下属性应写成单元或契约测试：

1. 任意代理请求的目标地址都来自已保存且握手成功的 PeerHostRecord。
2. 不同 `hostId` 的相同 `workspaceId/sessionId` 不会命中同一个缓存键或订阅。
3. 旧 `scopeGeneration` 的 HTTP/WS 结果不能更新当前 UI 状态。
4. 删除、地址变化或 fingerprint 变化后，目标登录态不可再被代理使用。
5. 未登记的 HTTP 路径、方法和 WebSocket 消息类型始终被拒绝。
6. 单个 PeerHost 失败时，当前 Host 和其他 PeerHost 的聚合任务仍能完成。

## 13. 测试策略

### 13.1 Host 单元测试

- 路由规范化、重复记录和状态转换。
- 握手版本、插件标识和 fingerprint 校验。
- 目标 token 刷新、失效和删除清理。
- HTTP 路径/方法/体积白名单。
- WebSocket 消息白名单、作用域校验和双端关闭。
- 中转能力不可用时的明确降级，不回退任意 URL。

### 13.2 Client 单元和组件测试

- Feature 启停和右下角入口显示。
- 管理面板增删改、检查、登录和错误状态。
- 多 Host 同名工作区/会话稳定 key 与标签。
- 旧 generation 结果丢弃和切换清理。
- 中栏、聊天框、右侧工具请求携带正确 HostScope。
- 原生导航和 Remote Web Context 降级提示。

### 13.3 集成与 fixture

至少覆盖 DSH `0.1.5-rc.3`、`0.1.6-alpha.2`、`0.1.7-rc.2` 的当前 Host 与 PeerHost fixture，并覆盖：局域网可用、中转不可用、目标未登录、版本不兼容、fingerprint 改变、目标断线和恢复。

## 14. 版本迁移与发布边界

第一阶段只在现有能力矩阵允许的 DSH 版本上启用 PeerHost。新增 DSH 版本时先写调查报告和能力 route，再扩展 Feature。任何原生导航能力缺失都必须保持降级状态，不能通过修改前端 DOM 选择器假装兼容。

PeerHost 不应改变当前 Host 的 manifest、登录入口、局域网访问和中转访问语义。发布前必须运行 `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 和 `pnpm test`。

## 15. 风险与待确认项

1. DSH 0.1.6 的原生导航扩展点是否足以渲染聚合树，需要真实 Profile 回放确认。
2. 当前中转 Transport 是否支持 Node Host 到目标 Host 的双向 Host-to-Host 连接，需要单独能力探测和安全审查。
3. 右侧工具和终端消息类型可能随 DSH 版本变化，新增消息必须先进入能力矩阵和白名单测试。
4. 多 Host 并发摘要和实时流需要压测，避免单个慢目标拖垮当前 Host 的事件循环和内存。
5. 目标 Host 的 fingerprint 信任确认交互需要产品决定是首次自动信任还是必须显式确认；实现前不能默认放宽身份校验。
