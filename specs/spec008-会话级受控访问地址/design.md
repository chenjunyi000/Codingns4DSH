# 设计文档 - 会话级受控访问地址

状态：规划完成，待实施。

## 1. 概述

### 1.1 目标

- 为指定 `workspaceId + sessionId` 生成可分发、可撤销、可设有效期的访问地址。
- 地址只暴露该会话的只读消息内容；DSH 整机凭据不下发、不转发、不落外部日志。
- 复用插件现有资产：`lan-access-dsh` 的监听与票据骨架、`debug.ts` 的随机地址范式、`native-session-bridge` 与 `remote-web-runtime` 的会话读取通道、FeatureRegistry 与能力矩阵。
- 不修改 DSH Host 与上游认证模型；最小权限只落在插件代理层。

### 1.2 覆盖需求

- `requirements.md` 需求 1 至需求 8。

### 1.3 技术约束

- Host：TypeScript、Cordis Feature、`CodingNsHostServices` 注入、现有 RPC 表（`CODINGNS_RPC_ENDPOINTS` 扩展）。
- Client：DSH Web 设置页与卡片（按 `docs/开发规范/` 规则登记）；第一阶段可只做 RPC，UI 在阶段 4。
- 存储：Host-only 记录（内存 + 可选文件持久化），只保存 secret 的哈希，不保存明文票据。
- 网络：复用 `LanAccessDshRuntime` 的 socket 抽象；不引入新的网络依赖。
- 安全前提：项目现有传输是明文 HTTP（DSH 自身上游 Cookie 同样不带 `Secure`），分享地址**不得被视为可用于公网**；设计上默认限制为可信网络并支持撤销与短有效期。
- 禁止事项：修改 DSH Host 源码、复用 DSH launch token/浏览器 Cookie 作为分享凭据、把 `/api` 全量方法或 `session.export` ZIP 直接透传给外部、通过分享地址执行任何写操作。

## 2. 架构

### 2.1 系统结构

```text
生成方（DSH Web 页面 / 本机 RPC 调用）
  │  sessionShare/create
  ▼
SessionShareService（Host-only 唯一权威）
  ├── SessionShareStore        记录、secret 哈希、撤销与审计状态
  ├── SessionContentSource     数据源适配（能力探测后选择实现）
  │     ├── NativeSessionSource     CodingNsNativeSessionBridge
  │     └── DshWebFetchSource       DshWebRuntimeProvider.request（Host 持 Cookie）
  └── SessionShareEndpoint     插件自有入口
        ├── 前缀处理：/share/session/<shareId>
        ├── 复用 lan-access 监听（首选）或独立监听（备选）
        └── 只读 JSON 输出 + 游标

消费方（其他会话 / 脚本 / 外部客户端）
  └── GET http://<插件入口>/share/session/<shareId>?key=<secret>&cursor=...
        └── Authorization: Bearer <secret> 亦可
```

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `SessionShareService` | 生成、撤销、状态查询、审计；唯一生命周期权威 | RPC 请求、票据校验结果 | 记录、DTO、错误 |
| `SessionShareStore` | 记录存储、secret 哈希校验、撤销与计数、持久化策略 | 记录读写请求 | 记录快照 |
| `SessionContentSource` | 会话摘要与消息窗口读取；数据源能力探测 | sessionId、游标、条数 | 消息窗口或结构化错误 |
| `SessionShareEndpoint` | 解析 HTTP 请求、校验票据、限流、输出 JSON | HTTP 请求 | HTTP 响应、审计事件 |
| `SessionShareRpc` | Client 侧 RPC 入口与参数校验 | create/list/revoke/status | DTO、错误 |
| `SessionShareSettings` | 入口开关、监听参数、有效期默认值、来源限制 | 设置页/配置文件 | 校验后的配置 |
| `SessionSharePanel`（阶段 4） | 生成、复制、撤销、查看访问状态 | DTO、用户操作 | UI 状态 |

### 2.3 关键流程

#### 2.3.1 生成分享地址

1. Client 或本机调用 `sessionShare/create`，提交 `workspaceId + sessionId + 可选 expiresInSeconds + 可选 label`。
2. Host 用权威 `resolveWorkspaceRoot` 校验工作区，用数据源确认会话存在且属于该工作区；任一不满足即拒绝。
3. 生成 `shareId`（无歧义字符、URL 安全）与随机 secret（256 bit）；记录只存 `secretHash`。
4. 计算 `expiresAt`（上限受设置约束），写入记录，返回完整 URL（只在创建响应中出现一次）。
5. 审计：记录生成事件（不含 secret 与完整 URL）。

#### 2.3.2 读取会话内容

1. 外部客户端请求 `<入口>/share/session/<shareId>`，携带 `key` 查询参数或 `Authorization: Bearer`。
2. 入口按 `shareId` 查记录，校验 secret 哈希、`expiresAt`、`revokedAt`、来源限制与会话有效性；失败按错误类型返回 401/403/404/410。
3. 校验通过后，用票据绑定的 `sessionId` 调数据源读取窗口（客户端不能覆盖 sessionId）。
4. 序列化为稳定 JSON（摘要 + 消息窗口 + `nextCursor`），双上限（条数、字节）生效。
5. 写出完整响应后记录访问审计（shareId、来源摘要、条数、结果）；客户端断开则取消数据源读取并释放句柄。

#### 2.3.3 撤销与失效

1. `sessionShare/revoke` 设置 `revokedAt`（幂等），后续访问立即失败，无需重启。
2. 会话删除、归档或迁移时，数据源校验步骤使读取返回 `SESSION_SHARE_SESSION_GONE`，同时把记录标记为失效。
3. 过期由 `expiresAt` 判定，不依赖定时器；状态查询可主动清理过期记录。
4. 插件停用/重启：默认**不自动复活**任何票据，记录保留可查询（策略可配置为清理）；「已撤销」状态一旦写入不可回退。

#### 2.3.4 数据源能力探测

1. 启动时探测 `CodingNsNativeSessionBridge` 是否可用（`session.format-v4` 能力 route 已可达）。
2. 若原生桥不可用或字段不足，回退探测 DSH Web 代取通道（`DshWebRuntimeProvider.request` 是否可用）。
3. 两者都不可用则模块 `unavailable`：不注册 RPC 与入口，给出诊断码；其他模块不受影响。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7、8。

- `createSessionShareFeature()`：按能力画像注册 Host Feature；不可用时返回无害的 disabled module。
- `SessionShareService`：唯一持有票据生命周期与审计的服务。
- `SessionShareStore`：唯一保存记录权威状态的 Host-only store。
- `SessionShareEndpoint`：唯一对外读取入口，拒绝一切非读取方法。
- `SessionShareRpc`：只返回脱敏 DTO；`create` 响应是 secret 的唯一出口。

### 3.2 数据结构

#### 3.2.1 `SessionShareRecord`（Host-only）

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `shareId` | `string` | 是 | 公开标识，出现在 URL 路径 | Host 生成，URL 安全字符集 |
| `workspaceId` | `string` | 是 | 所属工作区 | Host 权威解析 |
| `sessionId` | `string` | 是 | 绑定会话 | 创建后不可修改 |
| `secretHash` | `string` | 是 | 票据 secret 的哈希 | 不保存明文 |
| `label` | `string` | 否 | 分享备注 | 长度受限，UI 显示 |
| `createdAt` | `string` | 是 | 创建时间 | ISO 8601 |
| `expiresAt` | `string` | 是 | 过期时间 | 受设置上限约束 |
| `revokedAt` | `string` | 否 | 撤销时间 | 写入后不可清除 |
| `accessCount` | `number` | 是 | 成功访问次数 | 只增 |
| `lastAccessedAt` | `string` | 否 | 最近访问时间 | ISO 8601 |
| `invalidReason` | `string` | 否 | 失效原因码 | 如会话消失 |

#### 3.2.2 `SessionShareContentDto`（对外输出）

```json
{
  "session": {
    "id": "…", "workspaceId": "…", "title": "…",
    "createdAt": "…", "updatedAt": "…"
  },
  "messages": [
    { "seq": 12, "role": "user | assistant | system", "kind": "text | tool-summary", "text": "…", "createdAt": "…", "truncated": false }
  ],
  "nextCursor": "…",
  "hasMore": true
}
```

约束：不包含附件字节、绝对路径、凭据、命令环境变量；单条消息超限时截断并置 `truncated`。

#### 3.2.3 `SessionShareSummaryDto`（Client 可见）

`shareId`、`workspaceId`、`sessionId`、`label`、`createdAt`、`expiresAt`、`status`（`active | expired | revoked | invalid`）、`accessCount`、`lastAccessedAt`。创建响应额外返回一次完整 URL；列表与状态接口永远不返回 secret。

### 3.3 接口契约

#### 3.3.1 RPC：`sessionShare/*`

- `sessionShare/create`：`{ workspaceId, sessionId, expiresInSeconds?, label? }` → `{ share: SessionShareSummaryDto, url }`；错误：`SESSION_SHARE_SESSION_NOT_FOUND`、`SESSION_SHARE_SCOPE_MISMATCH`、`SESSION_SHARE_SOURCE_UNAVAILABLE`、`SESSION_SHARE_LIMIT_REACHED`。
- `sessionShare/list`：`{ workspaceId, sessionId? }` → `{ shares: SessionShareSummaryDto[] }`。
- `sessionShare/revoke`：`{ shareId }` → 更新后的摘要；幂等。
- `sessionShare/status`：`{ shareId }` → 摘要（含失效原因）。
- 校验：`workspaceId` 必须由 Host 权威解析；`sessionId` 必须属于该工作区；所有返回脱敏。

#### 3.3.2 HTTP：受控读取入口

- `GET <入口>/share/session/<shareId>`，查询参数：`key`（secret，可选改用 `Authorization: Bearer`）、`cursor`、`limit`。
- 成功：`200 application/json`，body 为 `SessionShareContentDto`。
- 失败：`401`（无/错票据）、`403`（来源被限制）、`404`（shareId 未知）、`410`（已撤销/过期/会话消失，附错误码）、`503`（数据源不可用，附重试建议）。
- 只注册 `GET`（`HEAD` 可选）；任何其他方法一律 405，不提供写路由。
- 可选：`GET .../<shareId>/stream`（NDJSON 增量）留待阶段 3 决定，非第一优先级。

#### 3.3.3 数据源接口 `SessionContentSource`

- `describe(sessionId): Promise<{ id, workspaceId, title?, createdAt?, updatedAt? } | null>`：会话存在性与摘要。
- `readWindow(sessionId, cursor: string | null, limit: number): Promise<{ messages: SessionShareMessage[]; nextCursor: string | null; hasMore: boolean }>`。
- `isAvailable(): boolean`：能力探测结果。
- 实现：`NativeSessionSource`（首选，包装 `CodingNsNativeSessionBridge`）与 `DshWebFetchSource`（备选，包装 `DshWebRuntimeProvider.request`，Cookie 留在 Host）。游标语义各自实现、对外一致。

#### 3.3.4 Host 注入与注册边界

- 新增 `CodingNsHostServices` 字段（如 `registerSessionShareRoute` 或明确的监听提供者），沿用 `registerDebugProxyRoute` 的资源注销约定。
- Feature 在 `src/host/features/index.ts` 登记一行；启停、资源释放、能力诊断必须有测试。
- 新增能力 ID（如 `session.content-read`）与矩阵 route、fixture、诊断码，按 `AGENTS.md` 的「新增能力或接口」流程执行。
- 票据 secret 只经 `create` 响应出现一次；日志、审计、DTO 一律不含明文。

## 4. 数据与状态模型

### 4.1 数据关系

`Workspace 1—N Session 1—N SessionShareRecord`。一个会话可并存多个分享记录，各自独立撤销。记录是 Host-only 权威；Client 只看到摘要 DTO。数据源不持有分享状态，只按 `sessionId` 提供内容。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `active` | 可读取 | 创建成功 | 过期、撤销、会话消失、模块停用（按策略） |
| `expired` | 超过 `expiresAt` | 时间到达 | 终态（可被清理） |
| `revoked` | 被显式撤销 | `revoke` 调用 | 终态，不可复活 |
| `invalid` | 绑定会话消失或数据源拒绝 | 会话删除/归档/迁移 | 终态（可被清理） |

### 4.3 一致性规则

- 创建先写记录再返回 URL；写失败不返回地址。
- `revoke` 幂等；重复撤销返回当前状态。
- 访问计数与最近访问时间在响应写出后更新；失败访问单独审计，不污染成功计数。
- 过期判定是纯函数（`now > expiresAt`），不依赖后台定时器；状态查询、列表、访问校验三处结果必须一致。
- 持久化（若启用）只在启动时读取与更新时写入；「已撤销」写盘后即使进程重启也不得复活。

## 5. 错误处理

### 5.1 错误类型

- `SESSION_SHARE_INVALID_TICKET`：secret 不匹配或缺失。
- `SESSION_SHARE_EXPIRED`：超过有效期。
- `SESSION_SHARE_REVOKED`：已被撤销。
- `SESSION_SHARE_SESSION_GONE`：绑定会话被删除、归档或迁移。
- `SESSION_SHARE_SCOPE_MISMATCH`：请求会话/工作区与票据绑定不符（防越权尝试）。
- `SESSION_SHARE_SOURCE_UNAVAILABLE`：数据源不可用或能力缺失。
- `SESSION_SHARE_LIMIT_REACHED`：单会话分享数量或有效期超出设置上限。
- `SESSION_SHARE_RATE_LIMITED`：访问频率/次数超出限制（若启用）。

### 5.2 错误响应格式

```json
{
  "detail": "分享链接已被撤销",
  "error_code": "SESSION_SHARE_REVOKED",
  "timestamp": "2026-09-29T00:00:00Z"
}
```

### 5.3 处理策略

1. 输入验证错误：在写记录前拒绝，不产生地址、不写审计成功项。
2. 票据错误：统一返回同类错误与固定延迟，避免通过错误差异枚举 `shareId`。
3. 数据源错误：区分临时（503 + 重试建议）与终态（会话消失 → 410，并标记记录失效）。
4. 取消与超时：请求取消时释放数据源句柄；审计记录结果，不写半截响应。
5. 模块停用/关闭：撤销内存中的活动句柄，按策略处理记录；不干预其他模块。

## 6. 正确性属性

### 6.1 属性 1：作用域隔离

对于任何持有分享票据的请求，系统只能返回票据绑定的 `sessionId` 内容；请求参数、请求头或路径不得改变绑定会话或工作区。

**验证需求：** 需求 2、需求 3。

### 6.2 属性 2：只读无副作用

对于任何分享访问，系统不得触发消息写入、工具执行、权限审批、会话状态变更或文件写操作。

**验证需求：** 需求 2、需求 4。

### 6.3 属性 3：撤销即时生效

对于任何已撤销、已过期或已失效的票据，系统在写入状态后必须立即拒绝后续访问，且状态不可回退。

**验证需求：** 需求 1、需求 5。

### 6.4 属性 4：凭据不外泄

对于任何响应、日志、审计与 DTO，系统不得输出 DSH 整机凭据、分享 secret 明文、环境变量、完整命令行或 workspace 绝对路径。

**验证需求：** 需求 3、需求 6、需求 7。

## 7. 测试策略

### 7.1 单元测试

- 票据：secret 生成与哈希、校验、过期、撤销、幂等撤销。
- Store：并发读写、持久化恢复、撤销不复活、状态一致性。
- 序列化：双上限（条数/字节）、截断标记、游标单调性。
- 错误映射：每个错误码对应的 HTTP 状态与 DTO。

### 7.2 集成测试

- fake 数据源 + fake 客户端：创建 → 读取 → 撤销 → 拒绝的完整链路。
- 越权尝试：客户端指定其他 `sessionId`、构造他人 `shareId`、伪造 secret、跨工作区读取。
- 数据源故障：临时失败、会话消失、探测不可用三种情形。
- 能力/版本：`unavailable`、`degraded`、`supported` 三种诊断输出。

### 7.3 端到端测试

- 真实 DSH 环境：会话 A 生成地址，脚本（无 Cookie）读取 A 的内容，确认读不到 B 的内容。
- 撤销后立即 410；过期后立即 410；删除会话后 410 + 记录失效。
- 敏感扫描：响应、日志、审计中无 secret 明文、无绝对路径、无 DSH 凭据。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1、5 | §2.3.1、§2.3.3、§4.2、§4.3 | 生成/撤销/过期/会话消失测试 |
| 需求 2、3 | §2.2、§3.3.2、§6.1、§6.2 | 越权与只读测试、入口方法白名单 |
| 需求 4、7 | §3.3.2、§3.3.3、§7.3 | 脚本读取 E2E、分页与游标测试 |
| 需求 6 | §2.3.2、§5.2、§6.4 | 审计字段与脱敏扫描 |
| 需求 8 | §2.3.4、§3.3.4 | 三态能力 fixture 与降级测试 |

## 8. 风险与待确认项

### 8.1 风险

- `CodingNsNativeSessionBridge` 返回 `unknown` 结构，消息投影解析可能不足；若字段不足需回退 DSH Web 代取，而 `/api` 会话方法族是版本敏感契约，必须走能力 route 探测。
- 明文 HTTP 前提：票据在传输中可被同网络观察者读取；默认应限制为可信网络、短有效期、可撤销，并明确「不要用于公网」。
- 与 `lan-access-dsh` 共用监听会让「整机局域网访问」与「单会话分享」共享一个端口与生命周期；若 lan-access 未启用，sessionShare 需要独立监听能力，避免强绑定。
- 会话内容可能包含敏感信息（密钥、路径、业务数据）；分享动作本身缺少二次确认与范围提示，UI 阶段必须提示「对方将看到该会话全部消息」。
- 消息内容可能非常大；若不设字节上限，单次响应会拖垮内存或被用于放大攻击。

### 8.2 待确认项

- 数据源主选：先做 `nativeSessions` 投影，还是直接以 DSH Web 代取为主（取决于阶段 1 探测结果）。
- 入口形态：复用 lan-access 监听的前缀处理，还是独立端口；这决定设置项设计（是否新增监听配置）。
- 是否在阶段 4 提供「本机其他会话读取」的插件工具（如 `read_shared_session`），还是只保证 HTTP 路径。
- 记录持久化默认值：重启后保留（可查询、可按策略清理）还是默认清理。
- 是否需要在读取端支持 `last-event-id` 式增量（stream）以及是否需要 ETag/条件请求。
- 有效期上限、单会话分享数量上限、限流默认值的具体数值。
