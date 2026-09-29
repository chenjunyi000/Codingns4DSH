# 需求文档 - 会话级受控访问地址

状态：规划完成，待实施。

## 简介

插件的用户想把「某个工作区会话的消息内容」交给其他会话或外部客户端读取——例如让同事的浏览器看一眼排查过程、让脚本拉取会话记录做归档、让本机另一个 agent 读取上下文。当前只有两条路：暴露整个 DSH Web（对方拿到整机权限），或者使用 DSH 原生跨会话引用（无地址、不可撤销、只进模型上下文）。

本需求定义第三条路：由插件生成**会话级、只读、可撤销、可设有效期**的访问地址。地址只绑定一个 `workspaceId + sessionId`，只暴露消息读取；DSH 的整机凭据（launch token、浏览器 Cookie）不下发给持有链接的一方，插件的票据与代理层承担全部最小权限控制。

## 术语表

- **System**：本插件（Codingns4DSH）在 DSH Host 中注入运行的 Host/Client 功能集合。
- **会话（Session）**：DSH 工作区中的一段消息历史，具有稳定 `sessionId` 与所属 `workspaceId`。
- **会话访问地址（分享地址）**：形如 `<插件入口>/share/session/<shareId>` 的可分发 URL，携带或要求会话级票据。
- **分享票据（Share Ticket）**：绑定 `shareId + workspaceId + sessionId + 只读范围 + 有效期` 的签名凭据，可撤销。
- **会话内容数据源（Content Source）**：Host 侧读取会话消息的通道，候选为 `CodingNsNativeSessionBridge` 或 DSH Web 代取（`DshWebRuntimeProvider`），由能力探测决定。
- **受控入口（Endpoint）**：插件自有的监听或路由前缀，独立于 DSH 整机 Web 入口。
- **审计记录**：生成、访问、撤销、拒绝事件的脱敏日志。
- **其他会话**：持有分享地址进行读取的另一个 DSH 会话、浏览器、脚本或外部客户端。

## 范围说明

### In Scope

- 为指定 `workspaceId + sessionId` 生成分享地址，支持列出与撤销。
- 有效期与撤销语义；会话删除、归档、Host 重启后的失效规则。
- 只读消息读取输出契约（分页游标、稳定 JSON、脱敏）。
- 插件自有受控入口与票据校验；与 DSH 整机凭据隔离。
- 数据源能力探测与降级；旧 DSH 版本禁用。
- 脱敏审计与基本访问约束（可选速率/次数限制）。
- 外部客户端与「其他会话」的读取路径说明。

### Out of Scope

- 修改 DSH Host、上游认证模型或浏览器会话行为。
- 通过分享地址写消息、发消息、执行工具、审批权限或中断会话。
- 通过分享地址读取附件、workspace 文件或任意路径内容。
- 把 DSH Web 整机入口（launch token、Cookie、`/api` 全量方法）作为分享凭据。
- 公网部署、TLS 终结、反向代理与域名方案。
- PeerHost 跨 Host 聚合与 relay 可用性。
- 多租户与账号体系；本 Spec 不引入第二个用户模型。

## 需求

### 需求 1：生成与撤销会话访问地址

**用户故事：** 作为插件用户，我希望为指定会话生成一个可控的访问地址，并能在不需要时撤销，以便安全地分享会话内容。

#### 验收标准

1. WHEN 用户为当前工作区的一个可见会话请求生成地址 THEN System SHALL 创建唯一 `shareId`、签发会话级票据，并返回完整 URL、绑定信息（workspaceId、sessionId）与过期时间。
2. WHEN 同一会话重复生成地址 THEN System SHALL 允许并存多个独立票据，每个可单独撤销，互不影响。
3. WHEN 用户撤销某个地址 THEN System SHALL 立即让该票据失效，重复撤销幂等且不报错。
4. WHEN 请求的会话不属于当前工作区或不可见 THEN System SHALL 拒绝生成，并返回结构化错误，不泄露其他会话信息。

### 需求 2：只读且单会话的作用域

**用户故事：** 作为分享方，我希望拿到链接的人只能读这一个会话的消息，以便不会因为一次分享暴露整个实例。

#### 验收标准

1. WHEN 持有有效票据的客户端请求消息 THEN System SHALL 只返回票据绑定 `sessionId` 的内容。
2. WHEN 请求试图指定其他 `sessionId`、workspace 路径或管理操作 THEN System SHALL 拒绝，不因参数覆盖票据绑定。
3. WHEN 客户端尝试写操作（发送消息、执行工具、审批、中断）THEN System SHALL 拒绝，且受控入口不暴露任何写路由。
4. WHEN 响应构造时 THEN System SHALL 不返回 DSH 整机凭据、环境变量、完整命令行或 workspace 绝对路径。

### 需求 3：受控入口与凭据隔离

**用户故事：** 作为部署者，我希望分享地址使用独立入口和自己的票据，以便 DSH 整机凭据不被复制或转交给第三方。

#### 验收标准

1. WHEN 受控入口处理请求 THEN System SHALL 只接受本插件的会话级票据，不接受 DSH launch token、浏览器 Cookie 或整机登录票据。
2. WHEN 数据源需要访问 DSH Web THEN System SHALL 由 Host 侧代取并保持 Cookie 不出 Host，外部只见插件输出。
3. WHEN 受控入口未启用或未配置监听 THEN System SHALL 不监听端口，生成地址功能保持不可用并给出原因。
4. WHEN 分享地址被访问 THEN System SHALL 不要求、不记录、不转发 DSH 整机凭据。

### 需求 4：输出契约与分页

**用户故事：** 作为消费方（脚本或其他会话），我希望拿到稳定、可分页的消息内容，以便增量读取而不必下载全部历史。

#### 验收标准

1. WHEN 客户端请求会话内容 THEN System SHALL 返回稳定 JSON：会话摘要 + 消息窗口 + 下一页游标。
2. WHEN 客户端携带游标请求 THEN System SHALL 返回该游标之后的消息，游标语义在会话内单调且可重放。
3. WHEN 会话很大或消息很多 THEN System SHALL 限制单次返回条数与字节数，不把完整历史缓冲进内存。
4. WHEN 消息包含附件或二进制内容 THEN System SHALL 只输出文本与引用摘要，不输出附件字节。
5. WHEN 数据源暂时不可用 THEN System SHALL 返回结构化错误与重试建议，不返回部分损坏的数据。

### 需求 5：有效期与失效生命周期

**用户故事：** 作为分享方，我希望分享地址在过期或会话消失后自动失效，以便不用反复手工清理。

#### 验收标准

1. WHEN 票据超过 `expiresAt` THEN System SHALL 拒绝访问并返回可区分的过期错误。
2. WHEN 绑定的会话被删除、归档或迁移 THEN System SHALL 让对应票据失效，并可通过状态查询观察到失效原因。
3. WHEN 插件停用、Host 关闭或重启 THEN System SHALL 按配置策略决定票据是否保留；默认策略必须在重启后仍可查询状态且不可被静默复活。
4. WHEN 过期或失效的票据被再次撤销 THEN System SHALL 幂等处理，不报错。

### 需求 6：审计与可观测

**用户故事：** 作为分享方，我希望知道谁在什么时候读取了分享的会话，以便判断是否需要提前撤销。

#### 验收标准

1. WHEN 票据生成、撤销、访问成功或被拒绝 THEN System SHALL 记录脱敏审计（时间、shareId、sessionId、来源摘要、结果），不记录票据明文。
2. WHEN 审计输出到日志或 UI THEN System SHALL 对票据、URL 查询参数和请求头中的敏感信息脱敏。
3. WHEN 查询分享状态 THEN System SHALL 返回绑定信息、有效期、访问计数与最近访问时间。

### 需求 7：跨会话与外部消费路径

**用户故事：** 作为另一个会话或外部工具的维护者，我希望知道如何用分享地址读取内容，以便把它接入自动化。

#### 验收标准

1. WHEN 其他会话或外部客户端持有链接 THEN System SHALL 支持直接 HTTP 读取（含示例请求与响应说明）。
2. WHEN 外部客户端无法携带浏览器 Cookie THEN System SHALL 仍能通过票据完成访问，不依赖浏览器会话。
3. WHEN 需要限制访问来源 THEN System SHALL 支持可选的来源约束（如仅本机、指定网段），并给出明确拒绝错误。
4. WHEN 本机其他 DSH 会话读取 THEN System SHALL 至少通过 HTTP 路径可读；是否提供插件工具入口由阶段 4 决策。

### 需求 8：能力探测与降级兼容

**用户故事：** 作为现有插件用户，我希望会话分享在能力不足时安全关闭，以便不影响局域网访问、终端等其他功能。

#### 验收标准

1. WHEN DSH 版本或数据源能力可用 THEN System SHALL 生成 `supported` 能力结果并允许启用会话分享。
2. WHEN 版本低于支持范围或数据源探测失败 THEN System SHALL 禁用会话分享模块，保留其他模块，并给出可解释诊断。
3. WHEN 运行中数据源失效 THEN System SHALL 让分享读取返回结构化错误，不使插件其他模块崩溃。
4. WHEN 新增支持版本 THEN System SHALL 通过 `src/dsh-capabilities/` 的 route、fixture 与诊断更新，而不是在业务模块散落版本判断。

## 非功能需求

### 非功能需求 1：性能

1. WHEN 单次读取 THEN System SHALL 只读取所需的消息窗口，按条数与字节双上限返回；不随会话总长度线性增加内存。
2. WHEN 多个客户端并发读取同一会话 THEN System SHALL 支持并发，不重复构建整份历史，且在数据源限流时给出可重试错误。

### 非功能需求 2：可靠性

1. WHEN 票据校验、数据源读取或响应写出失败 THEN System SHALL 保证失败原子性：不写出半截 JSON、不产生一半的审计记录。
2. WHEN Host 重启 THEN System SHALL 按配置策略恢复或清理票据，并保证「已撤销」状态不被复活。
3. WHEN 请求被取消（客户端断开） THEN System SHALL 释放数据源句柄与内存。

### 非功能需求 3：可维护性

1. WHEN 新增数据源或输出格式 THEN System SHALL 只实现既有内容源/序列化接口，不修改票据与入口核心。
2. WHEN 排查问题 THEN System SHALL 能用 `shareId`、`sessionId`、`requestId` 关联审计、错误与数据源日志。
3. WHEN 新增配置项 THEN System SHALL 按 `docs/开发规范/20260922-设置选项与表单开发规则.md` 登记到设置页与契约。

## 成功定义

- 为指定会话生成的地址可被脚本（无浏览器 Cookie）成功读取消息，且只能读到该会话。
- 撤销后访问立即失败；过期后返回可区分错误；会话删除后票据自动失效。
- 响应与日志中不出现 DSH 整机凭据、分享票据明文、绝对路径。
- 能力缺失、旧版本、数据源失败均有可解释降级，局域网访问、终端、文件管理等现有模块回归通过。
- `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test` 通过；不修改 DSH Host 源码。
