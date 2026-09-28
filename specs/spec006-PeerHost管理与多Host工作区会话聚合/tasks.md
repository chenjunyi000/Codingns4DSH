# 任务清单 - PeerHost 管理与多 Host 工作区会话聚合

状态：阶段 6 进行中；阶段 1 至阶段 5 已完成，阶段 6 的 HTTP 作用域适配已完成，原生 WebSocket/UI 接入受 DSH WebServer 扩展点限制。

## 使用规则

- `TODO`：未开始。
- `IN_PROGRESS`：正在实现。
- `IN_REVIEW`：代码与验证完成，等待复核。
- `DONE`：已回写验证证据。
- `BLOCKED`：外部能力或决策阻塞，必须写明原因。
- 每个任务完成后立即回写状态、改动文件和验证命令，不允许最后一次性补记录。
- 任务只修改本任务列出的边界；发现跨边界需求时先在“风险与待确认项”中记录，再拆新任务。

## 阶段 1：建立 Spec 边界、能力矩阵和内部契约

### 1.1 注册 PeerHost 能力 ID 与 Feature descriptor

- 状态：`DONE`
- 改动文件：`src/dsh-capabilities/types.ts`、`src/dsh-capabilities/matrix.ts`、`src/dsh-capabilities/routes.ts`、`src/client/features/peer-host.ts`、`src/client/features/index.ts`、`src/host/features/peer-host.ts`、`src/host/features/index.ts`、`tests/dsh-capability-registry.spec.ts`、`tests/feature-wiring.spec.ts`
- 验证命令：`pnpm run typecheck`；`pnpm run build && node --test tests/dsh-capability-registry.spec.ts tests/feature-wiring.spec.ts`（28 项通过）
- 已知限制：PeerHost 适配器尚未装配，当前仅提供显式结构探测和默认关闭的 Feature；真实配置、握手、代理和聚合留在后续任务。中转能力未宣称可用。
- 对应需求和设计章节：需求 1、12；设计 §1、§2、§3
- 做什么：在能力注册表中增加 PeerHost store、握手、HTTP/WS 代理、聚合、Relay 和导航降级能力，注册独立 `peer-host` Feature。
- 做完看到什么：能力画像能解释 PeerHost 是否可用，模块启停不影响现有 Feature。
- 依赖什么：spec005 能力注册与 FeatureRegistry；无业务代码依赖。
- 先看哪些文档：`requirements.md` 需求 1、12；`design.md` §3。
- 主要改哪些文件：`src/dsh-capabilities/types.ts`、`src/dsh-capabilities/matrix.ts`、`src/client/features/index.ts`、`src/host/features/index.ts`、对应测试。
- 明确不做什么：不连接真实目标 Host，不添加管理面板，不扩大 DSH manifest 范围。
- 怎么验证：能力矩阵单测、Feature 缺失能力禁用测试、`pnpm run typecheck`。

### 1.2 定义 PeerHost、HostScope 和聚合 DTO

- 状态：`DONE`
- 改动文件：`src/shared/contracts/peer-host.ts`、`src/shared/contracts/errors.ts`、`src/shared/index.ts`、`tests/peer-host-contracts.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-contracts.spec.ts tests/resource-scope.spec.ts`（9 项通过）
- 已知限制：契约已定义但尚未接入持久化、握手、代理和聚合运行时；`ResourceScopeManager` 保留旧输入形状，完整 `sessionId` 生命周期由阶段 4 接入。
- 对应需求和设计章节：需求 2、5、6、7、8、12；设计 §4、§6、§7、§11
- 做什么：新增 `PeerHostRecord`、`PeerHostRoute`、`PeerHostStatus`、`HostScope`、工作区/会话摘要和结构化错误码。
- 做完看到什么：Host、Client、代理和导航共享同一套内部契约，不再用裸 workspace/session ID。
- 依赖什么：1.1；现有 `src/shared/contracts/peer-host.ts` 和 `src/features/resource-scope/index.ts`。
- 先看哪些文档：`requirements.md` 需求 2、7、8；`design.md` §4、§11。
- 主要改哪些文件：`src/shared/contracts/peer-host.ts`、`src/shared/contracts/resource-scope.ts`（如需要）、`src/shared/errors/`、契约测试。
- 明确不做什么：不决定数据库实现，不把 DSH 私有类型暴露给业务模块。
- 怎么验证：类型检查、序列化/反序列化测试、错误码稳定性测试。

### 1.3 建立版本和能力 fixture

- 状态：`DONE`
- 改动文件：`src/dsh-capabilities/matrix.ts`、`src/dsh-capabilities/routes.ts`、`tests/dsh-capability-registry.spec.ts`、`docs/生成报告/20260925-能力路由报告.md`（脚本生成）
- 验证命令：`pnpm run typecheck`；`pnpm run build && node --test tests/dsh-capability-registry.spec.ts`（8 项通过）；`pnpm run version:check`；`pnpm run capability:check`；`pnpm run capability:report`
- 已知限制：0.1.5-rc.3/0.1.6-alpha.2 仅在显式注入时使用 Remote Web Context；0.1.7 原生导航仍需真实 adapter。Relay 三版本均保持 unavailable，尚未验证 Host-to-Host 中转。
- 对应需求和设计章节：需求 1、4、12；设计 §3、§5、§9、§14、§15
- 做什么：为 DSH 0.1.5-rc.3、0.1.6-alpha.2、0.1.7-rc.2 建立 PeerHost 能力 fixture，记录原生导航、WS 和 Remote Web Context 能力差异。
- 做完看到什么：每个版本都有明确的 ready/degraded/unavailable 结果。
- 依赖什么：1.1、1.2；现有 spec005 版本矩阵。
- 先看哪些文档：`docs/20260927-父仓库PeerHost实现对照与本项目边界.md`、现有 DSH 调查报告。
- 主要改哪些文件：`src/dsh-capabilities/matrix.ts`、`tests/fixtures/`、`tests/dsh-capability-registry.spec.ts`、对应调查文档。
- 明确不做什么：不通过字符串版本判断绕过能力探测，不宣称未验证的中转能力可用。
- 怎么验证：`pnpm run version:check`、能力报告和三版本 fixture 测试。

## 阶段 2：Host PeerHost 注册、握手和目标登录态

### 2.1 实现 PeerHost 持久化和敏感会话存储

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/peer-host-store.ts`、`tests/peer-host-store.spec.ts`
- 验证命令：`pnpm run typecheck`；`pnpm run build && node --test tests/peer-host-store.spec.ts`（3 项通过）
- 已知限制：服务尚未接入 Host Feature/RPC；加密文件密钥由 Host 启动边界注入，密钥生命周期和系统密钥链集成留在 Host 装配任务。
- 对应需求和设计章节：需求 2、4、5、12；设计 §4、§5、§11
- 做什么：实现 PeerHostRecord 的增删改查、路由规范化、重复检查、加密目标登录态和删除清理。
- 做完看到什么：配置和 token 只存当前 Host，Client 只能看到脱敏 DTO。
- 依赖什么：1.2；现有 Host settings store、认证服务和敏感存储边界。
- 先看哪些文档：`requirements.md` 需求 2、5；`design.md` §4、§5。
- 主要改哪些文件：`src/host/modules/peer-host/`、`src/host/settings.ts` 或对应 store、Host 单测。
- 明确不做什么：不让浏览器直接持有目标 token，不保存短期 relay ticket。
- 怎么验证：存储 round-trip、权限隔离、删除清理和日志脱敏测试。

### 2.2 实现目标 Host 握手和状态机

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/peer-host-store.ts`、`src/host/modules/peer-host/peer-host-handshake.ts`、`tests/peer-host-handshake.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-handshake.spec.ts`（4 项通过）
- 已知限制：当前只实现固定 LAN 握手路径；Relay 明确返回 `PEER_HOST_RELAY_UNAVAILABLE`。握手服务尚未接入 Feature/RPC，目标 Host 真实握手端点装配留在后续任务。
- 对应需求和设计章节：需求 3、4、5、11、12；设计 §5、§11、§15
- 做什么：实现产品标识、插件版本、DSH 版本、API 兼容标识和 fingerprint 检查，落地状态转换和诊断码。
- 做完看到什么：未安装插件、版本不兼容、身份变化和网络失败都能显示真实状态并阻止代理。
- 依赖什么：2.1、1.3；能力矩阵和版本解析工具。
- 先看哪些文档：`requirements.md` 需求 3、4；`design.md` §5、§11。
- 主要改哪些文件：`src/host/modules/peer-host/peer-host-service.ts`、握手 adapter、`tests/peer-host-handshake.spec.ts`。
- 明确不做什么：不在握手阶段加载会话全文，不自动信任 fingerprint 变化。
- 怎么验证：成功、插件缺失、版本不兼容、fingerprint 变化、超时和重试测试。

### 2.3 接入目标 Host 登录、刷新和退出

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/peer-host-store.ts`、`src/host/modules/peer-host/peer-host-session.ts`、`tests/peer-host-session.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-session.spec.ts`（3 项通过）
- 已知限制：登录服务已完成 Host 侧 token 隔离和自动刷新，但尚未接入生产 Host Feature/RPC；RPC 装配与代理生命周期在阶段 3 统一完成。Relay 登录仍不可用。
- 对应需求和设计章节：需求 5、6、11、12；设计 §5.2、§6、§11
- 做什么：提供 Host 侧登录、refresh、logout 和 `session_required` 处理，确保当前 Host 登录态不受影响。
- 做完看到什么：用户可在管理面板登录 PeerHost，代理前由 Host 自动刷新目标 token。
- 依赖什么：2.1、2.2；现有认证服务和目标 DSH 登录接口。
- 先看哪些文档：`requirements.md` 需求 5；`design.md` §5.2。
- 主要改哪些文件：`src/host/modules/peer-host/peer-host-service.ts`、Host RPC/API、认证测试。
- 明确不做什么：不把密码、token 或 refresh 结果返回 Client，不复用当前 Host token。
- 怎么验证：token 刷新成功/失败、目标退出、目标删除和当前 Host 会话隔离测试。

## 阶段 3：HTTP/WS 受控代理

### 3.1 实现 HTTP 代理入口和白名单

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/host-api-proxy-service.ts`、`tests/peer-host-http-proxy.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-http-proxy.spec.ts`（3 项通过）
- 已知限制：代理服务尚未注册到生产 WebServer/RPC；当前白名单覆盖工作区、会话、文件树、文件、Git、终端和右侧工具的固定 API 前缀，具体 DSH 版本路径适配仍需能力矩阵扩展。
- 对应需求和设计章节：需求 5、6、7、10、12；设计 §6、§11
- 做什么：按固定 PeerHost ID 和资源类别代理工作区、会话、文件、Git、终端和右侧工具 API。
- 做完看到什么：合法请求可到达目标 Host，任意 URL、认证和未登记 API 被拒绝。
- 依赖什么：2.2、2.3；现有 Host HTTP 路由和 `host-api-proxy-service.ts` 参考实现。
- 先看哪些文档：`requirements.md` 需求 6、10；`design.md` §6。
- 主要改哪些文件：`src/host/modules/peer-host/host-api-proxy-service.ts`、路由注册、白名单契约、测试。
- 明确不做什么：不接受客户端 baseUrl，不开放任意 `/api`、插件安装或认证代理。
- 怎么验证：路径、方法、体积、作用域、认证、响应头和错误码测试。

### 3.2 实现 WebSocket 代理和消息过滤

- 状态：`DONE`
- 改动文件：`src/host/modules/peer-host/host-ws-proxy-service.ts`、`src/host/modules/peer-host/peer-host-ws-gateway.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`tests/peer-host-ws-proxy.spec.ts`、`tests/peer-host-ws-gateway.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-ws-proxy.spec.ts tests/peer-host-ws-gateway.spec.ts`（代理 3 项通过；网关集成测试在禁止监听端口的环境跳过）
- 已知限制：服务已完成双端过滤、有界队列、插件自有固定路径 upgrade 网关和默认 LAN `/ws` Host-to-Host connector；不修改 DSH WebServer。目标 WS 断线重连留在后续阶段 7，relay connector 在能力验证前保持明确不可用。
- 对应需求和设计章节：需求 6、7、9、10、11、12；设计 §7、§8、§11
- 做什么：建立当前 Host 到目标 Host 的双端 WS 连接，过滤客户端/远端消息类型并绑定 HostScope。
- 做完看到什么：会话、终端、文件树和 Git 实时事件能路由到正确 Host，未知消息不会透传。
- 依赖什么：3.1、2.3；现有 WS auth guard 和 DSH 工作台消息协议。
- 先看哪些文档：`requirements.md` 需求 6、9、10；`design.md` §7。
- 主要改哪些文件：`src/host/modules/peer-host/host-ws-proxy-service.ts`、WS 路由、消息白名单和测试。
- 明确不做什么：不支持二进制透传、任意 WebSocket 路径或 PeerHost 递归代理。
- 怎么验证：双端连接、消息白名单、scope mismatch、上游关闭、背压和清理测试。

### 3.3 增加代理安全和诊断测试

- 状态：`DONE`
- 改动文件：`tests/peer-host-security.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-http-proxy.spec.ts tests/peer-host-ws-proxy.spec.ts tests/peer-host-security.spec.ts`（8 项通过）
- 已知限制：安全测试覆盖当前代理实现和错误脱敏；生产日志扫描、实际 WebServer/upgrade 注册以及新增 DSH API 的持续白名单门禁仍需后续任务。
- 对应需求和设计章节：需求 6、12；设计 §6、§7、§11、§12
- 做什么：把代理路径、消息类型、日志字段和凭据脱敏规则固化为安全契约测试。
- 做完看到什么：新增代理接口如果漏注册白名单或日志包含敏感字段，测试会失败。
- 依赖什么：3.1、3.2。
- 先看哪些文档：`requirements.md` 需求 6、12；`design.md` §11、§12。
- 主要改哪些文件：`tests/peer-host-proxy.spec.ts`、`tests/peer-host-security.spec.ts`、日志工具。
- 明确不做什么：不把安全测试变成对具体第三方网络环境的依赖。
- 怎么验证：`pnpm test` 中的代理/安全测试、敏感字段扫描和失败路径覆盖。

## 阶段 4：HostScope、HostRouter 和聚合摘要

### 4.1 实现 HostRouter 和 generation 清理

- 状态：`DONE`
- 改动文件：`src/features/host-router.ts`、`src/client/host-router.ts`、`src/host/host-router.ts`、`tests/host-router.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/host-router.spec.ts`（3 项通过）
- 已知限制：路由器已提供作用域、generation、清理和稳定 key，但尚未替换现有会话/工具模块的请求入口；接入在阶段 6 完成。
- 对应需求和设计章节：需求 7、9、10、11；设计 §8、§10、§11
- 做什么：统一解析当前 Host/PeerHost、校验作用域、递增 generation、取消旧请求和清理旧订阅。
- 做完看到什么：切换 Host、工作区或会话后，旧请求和旧 WS 结果不能污染新页面。
- 依赖什么：1.2、3.2；现有 resource-scope 和 remote-web-runtime 生命周期。
- 先看哪些文档：`requirements.md` 需求 7、11；`design.md` §8。
- 主要改哪些文件：`src/features/resource-scope/index.ts`、`src/client/host-router.ts`、`src/host/host-router.ts`、测试。
- 明确不做什么：不通过全局锁阻塞所有 Host，不删除现有单 Host 作用域行为。
- 怎么验证：旧 generation 丢弃、取消、WS 关闭、清理失败后新作用域仍能建立的测试。

### 4.2 实现多 Host 工作区/会话摘要聚合

- 状态：`DONE`
- 改动文件：`src/shared/contracts/peer-host.ts`、`src/shared/index.ts`、`src/host/modules/peer-host/peer-host-aggregate-service.ts`、`tests/peer-host-aggregate.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-aggregate.spec.ts`（3 项通过）
- 已知限制：聚合服务只加载摘要，尚未连接真实 workspace/session API 或 Client 导航 store；错误节点暂以 `AggregateHostResult` 状态承载。
- 对应需求和设计章节：需求 7、8、11；设计 §4.5、§8、§9、§11
- 做什么：并发获取当前 Host 和 PeerHost 摘要，合并稳定 key，保留不可用 Host 节点和状态。
- 做完看到什么：导航一次显示所有 Host 的工作区和会话，同名资源不会覆盖。
- 依赖什么：4.1、2.2；工作区/会话摘要 API。
- 先看哪些文档：`requirements.md` 需求 8；`design.md` §4.5、§9。
- 主要改哪些文件：`src/host/modules/peer-host/peer-host-aggregate-service.ts`、Client 聚合 store、DTO 测试。
- 明确不做什么：不预加载会话全文、文件内容或跨 Host 搜索。
- 怎么验证：并发、超时、单 Host 失败、同名 workspace/session、远端删除和刷新测试。

### 4.3 接入 Host 标签和导航数据适配器

- 状态：`DONE`
- 改动文件：`src/client/host-navigation.ts`、`tests/host-navigation.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/host-navigation.spec.ts`（2 项通过）
- 已知限制：当前提供纯数据适配器，尚未挂接 DSH 原生导航 DOM/React Slot；Remote Web Context 降级提示和真实导航装配留在阶段 5/6。
- 对应需求和设计章节：需求 8、11、12；设计 §9.2、§9.3、§14
- 做什么：为当前 Host 和 PeerHost 生成稳定标签、DOM/React key 和导航树模型。
- 做完看到什么：工作区名称后显示 Host 标签，切换和刷新不会跳到错误资源。
- 依赖什么：4.2；现有 workspace/session 导航和 host alias 逻辑。
- 先看哪些文档：`requirements.md` 需求 8；`design.md` §9.2。
- 主要改哪些文件：`src/client/workspace-session-logo-dom.ts`、导航组件/adapter、相关测试。
- 明确不做什么：不把标签写入 workspaceId，不改变当前 Host 默认显示语义。
- 怎么验证：多 Host 同名资源、稳定 key、标签更新和不可用节点保留测试。

## 阶段 5：连接管理入口和设置面板

### 5.1 增加右下角连接管理按钮

- 状态：`DONE`
- 改动文件：`src/client/peer-host-connection-button.ts`、`src/client/features/peer-host.ts`、`src/client/features/index.ts`、`tests/peer-host-connection-button.spec.ts`
- 验证命令：`pnpm run typecheck && pnpm run build && node --test tests/peer-host-connection-button.spec.ts`（1 项通过）
- 已知限制：按钮已由 Feature 生命周期创建/销毁并派发打开事件，管理面板、真实 RPC 以及 DOM 集成回放留在 `5.2`；未复用 active Host 切换器。
- 对应需求和设计章节：需求 1、2、12；设计 §2.1、§9.3
- 做什么：PeerHost Feature 启用时在右下角显示按钮，停用时移除并释放订阅。
- 做完看到什么：用户在当前工作区内打开管理面板，不需要切换页面或 Host。
- 依赖什么：1.1、4.1；现有 account bar/右下角 UI 注册方式。
- 先看哪些文档：`requirements.md` 需求 1、2；`design.md` §9.3。
- 主要改哪些文件：`src/client/account-bar.ts`、PeerHost UI 组件、Feature wiring 和组件测试。
- 明确不做什么：不复用 HostSwitcher 的 active Host 切换语义，不在停用后保留 DOM 节点。
- 怎么验证：Feature 启停、按钮显示、面板打开、资源释放和移动视口测试。

### 5.2 实现 PeerHost 管理面板

- 状态：`DONE`
- 改动文件：`src/client/peer-host-management-api.ts`、`src/client/peer-host-management-panel.ts`、`src/host/features/peer-host.ts`、`src/host/features/types.ts`、`src/host/index.ts`、`src/host/rpc.ts`、`src/shared/contracts/peer-host.ts`、`src/shared/index.ts`、`tests/peer-host-management.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts`（5 项通过）；`pnpm run typecheck`；`pnpm run build`；`git diff --check`
- 已知限制：管理面板和 Host RPC 已接入，LAN 握手使用固定 `/api/public/host-handshake`；relay 路由仍明确显示不可用。当前工作区缺少该独立包的 `node_modules` 链接，类型检查无法完整解析依赖；另有并行 `codex-driver.ts` 改动的既有类型错误。
- 对应需求和设计章节：需求 2、3、4、5、12；设计 §2.1、§5、§9.3、§11
- 做什么：提供添加、编辑、检查、重连、登录、退出和删除 PeerHost 的表单与状态视图。
- 做完看到什么：用户能看到名称、路由、版本、fingerprint 脱敏摘要、最近检查和错误原因。
- 依赖什么：2.1、2.2、2.3、5.1；现有设置表单规范。
- 先看哪些文档：`requirements.md` 需求 2、3、4、5；`docs/开发规范/20260922-设置选项与表单开发规则.md`。
- 主要改哪些文件：`src/client/features/peer-host-management.ts`、管理面板 DOM/React、locale 和测试。
- 明确不做什么：不显示 token、密码、完整 relay ticket 或任意目标 URL 查询串。
- 怎么验证：表单校验、重复目标、删除确认、登录失败、版本错误和中转不可用状态测试。

### 5.3 接入设置项和模块启停

- 状态：`DONE`
- 改动文件：`src/host/rpc.ts`、`src/client/features/peer-host.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-management.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts`（5 项通过）；`pnpm run typecheck`；`pnpm run build`；`git diff --check`
- 已知限制：设置使用现有 `modules` 字典，不新增独立顶层字段；停用时不会删除持久 PeerHost 配置和 Host 加密凭据。完整 DSH 设置页视觉回放留在阶段 8。
- 对应需求和设计章节：需求 1、12；设计 §2.1、§11
- 做什么：新增独立设置项、FeatureRegistry 启停回调和已有配置保留策略。
- 做完看到什么：关闭模块后按钮、轮询、聚合和连接消失，重新开启可恢复配置。
- 依赖什么：1.1、5.1、5.2；现有 settings store。
- 先看哪些文档：`requirements.md` 需求 1、12；功能模块开发规则。
- 主要改哪些文件：`src/shared/contracts/feature.ts`、`src/client/settings-section.ts`、`src/host/settings.ts`、Feature 测试。
- 明确不做什么：不删除用户保存的 PeerHost，不影响当前 Host 的既有开关。
- 怎么验证：重复启停、持久配置保留、定时器/WS/iframe 清理和能力缺失降级测试。

## 阶段 6：远端中栏、聊天输入、实时事件和右侧工具

### 6.1 路由远端会话历史和实时事件

- 状态：`IN_PROGRESS`
- 当前 Host 摘要 source 增量（2026-09-28）：新增 `PeerHostWorkspaceSessionSummarySource` 与 `createAggregateHostSource`。聚合层不再假设 DSH 私有 `SessionStore/WorkspaceRegistry` 结构；未注入稳定 source 时返回 `availability: unsupported` 和明确 `diagnostic`，不把空工作区伪装成成功。注入 source 后统一生成 `hostId/targetHostId/workspaceId/sessionId/scopeGeneration` 作用域节点。
- 验证：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-aggregate.spec.ts`（5 项通过，含 source 不可用诊断和可用 source HostScope 聚合）。
- 本次增量（2026-09-28）：新增 `src/client/peer-host-native-session-ui.ts` 原生会话 UI adapter。adapter 只在结构探测到 DSH `[data-composer-card]`/conversation 容器时挂载，加载历史并把白名单实时事件写入带完整 HostScope 的当前会话节点；generation 失效由 `PeerHostSessionController` 拒绝旧结果。未探测到稳定容器时显示“原生 conversation 容器不可用”降级状态，不创建 iframe 或伪装三栏。
- 验证：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-native-session-ui.spec.ts`（2 项通过）。
- 已完成增量：新增 Host 侧 LAN Host-to-Host WebSocket connector，固定连接目标 DSH `/ws` 工作台端点，在 Host 出站握手注入目标 access token，并把完整 HostScope 传入代理；connector 不接受 Client URL 或凭据。Client 事件流现已严格校验 `hostId`、`targetHostId`、`workspaceId`、`sessionId`、`scopeGeneration`，切换/关闭时清理订阅；事件发送入口仅允许 WS 白名单消息并自动注入作用域。断线采用有界指数退避重连，重连失败不会无限创建定时器。
- 改动文件：`src/client/peer-host-scoped-client.ts`、`src/client/peer-host-session-controller.ts`、`src/client/host-router.ts`、`src/client/features/types.ts`、`src/client/index.ts`、`src/host/modules/peer-host/host-api-proxy-service.ts`、`src/host/modules/peer-host/host-ws-connector.ts`、`src/host/modules/peer-host/host-ws-proxy-service.ts`、`src/host/modules/peer-host/peer-host-session.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`tests/peer-host-management.spec.ts`、`tests/peer-host-http-proxy.spec.ts`、`tests/peer-host-ws-connector.spec.ts`、`tests/peer-host-ws-proxy.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts`（10 项通过，含 HostScope 过滤、终端/右侧工具 WS 消息和有限重连）；`node --test tests/peer-host-ws-connector.spec.ts tests/peer-host-ws-proxy.spec.ts tests/peer-host-ws-gateway.spec.ts`；`pnpm run build`
- 已知限制：已建立带 HostScope 的 HTTP 会话请求适配器、会话控制器、LAN Host-to-Host connector 和插件自有 WebSocket upgrade 入口，可加载历史并在 generation 失效时拒绝旧结果；HTTP 401 与 WS 401/403 会清理该 PeerHost 凭据并转为 `session_required`。原生 DSH 会话导航 store、聊天 UI 和消息写入由独立 UI 适配器接入；本客户端重连沿用当前 generation，generation 重建与摘要刷新必须由上层 HostRouter/会话协调器执行。relay connector 仍保持明确不可用。插件自有网关继续作为当前 Host 的 Client 入口，connector 固定连接目标 DSH `/ws`，不把出口网关当作目标 Host 入站端点。
- 全量回归（2026-09-28）：`pnpm test` 共 566 项，563 项通过、2 项按环境跳过；唯一失败为既有 `tmux-backend` 真实会话在受限环境关闭 socket 时收到 `Operation not permitted`，与 PeerHost 改动无关。
- 对应需求和设计章节：需求 7、9、10、11；设计 §6、§7、§8、§10.1
- 做什么：打开 PeerHost 会话时加载目标历史、订阅实时事件，并将消息写入正确 HostScope。
- 做完看到什么：中栏显示目标 Host 的历史和新消息，切回当前 Host 后旧流停止。
- 依赖什么：3.1、3.2、4.1、4.2；现有 session store 和 remote Web runtime。
- 先看哪些文档：`requirements.md` 需求 9；`design.md` §10.1。
- 主要改哪些文件：`src/client/session/`、`src/client/remote-web-context.ts`、WS adapter、测试。
- 明确不做什么：不把远端消息复制到当前 Host 的持久会话，不用全局 activeHost 推断路由。
- 怎么验证：历史、增量、错误、权限请求、会话删除、切换和旧消息丢弃测试。

### 6.2 路由聊天发送、停止和权限回复

- 状态：`IN_PROGRESS`
- 本次增量（2026-09-28）：原生会话节点提供作用域绑定的发送、停止、权限回复和问题回答控件，所有操作直接调用 `PeerHostSessionController`，不接受客户端 target URL/token；发送 Enter、按钮事件均使用当前 HostScope。
- 本次增量（2026-09-28）：`PeerHostSessionController` 的四类命令均在请求前后校验当前 generation；补充切换作用域后发送、停止、权限回复和问题回答的旧结果丢弃测试。新增 `rebuildAfterReconnect` 协调接口，重连成功时强制重建 HostRouter generation、清理旧订阅，并在新作用域上执行可选摘要刷新回调。
- 验证：`pnpm run typecheck`；`pnpm run build`；`node --test tests/peer-host-native-session-ui.spec.ts`（降级路径与无选中会话拒绝通过）。
- 改动文件：`src/client/peer-host-scoped-client.ts`、`src/client/peer-host-session-controller.ts`、`src/client/features/types.ts`、`src/client/index.ts`、`src/host/modules/peer-host/host-api-proxy-service.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-management.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts`（13 项通过，含四类聊天命令 stale 丢弃与重连 generation 重建）；`pnpm run typecheck`；`pnpm run build`
- 已知限制：已提供发送、停止、权限回复和问题回答的 HostScope HTTP 薄封装，并由会话控制器统一校验当前作用域；重连后的摘要刷新由调用方回调负责，控制器不会复制远端消息到当前 Host 持久会话；未登记的 DSH 原生 command 仍保持明确 unsupported。
- 对应需求和设计章节：需求 9、10、11；设计 §5.2、§6、§7、§10
- 做什么：让发送消息、停止运行、回答问题和权限回复携带目标 HostScope 并通过 PeerHost 代理执行。
- 做完看到什么：聊天框操作进入目标 Host，当前 Host 会话不会收到误发消息。
- 依赖什么：6.1；工作台消息协议和 HTTP/WS 白名单。
- 先看哪些文档：`requirements.md` 需求 9；`design.md` §7、§10。
- 主要改哪些文件：聊天输入组件、session command adapter、相关契约和测试。
- 明确不做什么：不允许用户在请求体中覆盖 targetHostId 或目标 URL。
- 怎么验证：发送、停止、权限、问答、超时和目标登录过期测试。

### 6.3 路由文件、Git、终端和右侧工具

- 状态：`IN_REVIEW`
- 本次增量（2026-09-28）：原生会话面板新增作用域绑定的终端订阅、输入、调整大小、关闭和右侧工具订阅/刷新/关闭控件；这些操作通过当前 PeerHost WebSocket 订阅发送，未建立实时通道时明确显示降级，不回退到当前 Host。新增 `peerHost/aggregate` 固定 RPC 入口，Feature 启动时只用 Host 返回的摘要和自有 WS endpoint 装配导航/工具链路。
- 改动文件：`src/client/peer-host-scoped-client.ts`、`src/client/peer-host-session-controller.ts`、`src/client/peer-host-native-session-ui.ts`、`src/client/peer-host-management-api.ts`、`src/client/features/types.ts`、`src/client/index.ts`、`src/client/features/peer-host.ts`、`src/host/modules/peer-host/host-api-proxy-service.ts`、`src/host/modules/peer-host/peer-host-aggregate-service.ts`、`src/host/features/peer-host.ts`、`src/host/rpc.ts`、`tests/peer-host-management.spec.ts`
- 验证命令：`node --test tests/peer-host-management.spec.ts tests/peer-host-native-session-ui.spec.ts`（13 项通过）；`pnpm run typecheck`；`pnpm run build`
- 已知限制：HTTP 适配器已覆盖文件读写、Git 状态、终端和右侧工具固定路径，并统一绑定 HostScope；工具控件仍是 DSH 原生工具 Slot 不可用时的插件节点，不能宣称已替换 DSH 内部工具 Store。未登记消息明确返回 `PEER_HOST_TOOL_UNSUPPORTED`；作用域切换由 HostRouter 清理订阅。
- 对应需求和设计章节：需求 10、11；设计 §6、§7、§8、§10.2
- 做什么：将右侧栏打开/刷新/关闭、文件树、Git、终端和已登记工具绑定到目标 HostScope。
- 做完看到什么：远端文件、Git 状态、终端输出和右侧结果来自目标 Host 的运行时。
- 依赖什么：3.1、3.2、6.1；各工具能力和白名单。
- 先看哪些文档：`requirements.md` 需求 10；`design.md` §6、§7、§10.2。
- 主要改哪些文件：`src/client/features/` 相关工具模块、右侧栏 adapter、Host proxy 白名单和测试。
- 明确不做什么：不把远端路径当作当前 Host 本地路径，不对未登记工具静默降级。
- 怎么验证：作用域隔离、工具切换清理、终端输入/resize、文件读写、Git 刷新和 unsupported 错误测试。

## 阶段 7：中转 PeerHost、断线恢复和运行时治理

### 7.1 验证 Host-to-Host 中转能力

- 状态：`BLOCKED`
- 已完成增量：新增 `peer-host-relay.ts` 的受控 relay connector。它只接受 Host 侧显式注入且 `transportVersion` 匹配的已验证 Transport 工厂，稳定的 `deviceId`/`relayEntryId` 只作为路由标识传递，不解析任意 URL，不持久化短期 ticket；未注入适配器或版本不匹配时返回 `PEER_HOST_RELAY_UNAVAILABLE`，保持 `relay_unavailable/degraded`。
- 改动文件：`src/host/modules/peer-host/peer-host-relay.ts`、`src/host/modules/peer-host/host-ws-connector.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-relay.spec.ts`
- 验证命令：`pnpm run build && node --test tests/peer-host-relay.spec.ts`（4 项通过）；`pnpm run typecheck`
- 已知限制：当前仓库已有的 Relay Transport 是 DSH 二进制 `DshGateway`，尚无经过验证的 Host-to-Host 工作台 JSON/WS 适配层；因此默认和三版本 fixture 仍保持中转不可用，不能将浏览器短期 ticket 或任意公网地址伪装为 PeerHost relay。
- 阻塞原因：没有可验证的 Host 侧工作台 JSON/WS Relay Transport；在补齐该 Transport 前，relay 必须保持 `relay_unavailable/degraded`，不得标记 ready。
- 做什么：确认当前中转 Transport 是否支持 Host 到目标 Host 的双向连接、认证转发和断线恢复。
- 做完看到什么：能力矩阵明确 relay PeerHost 是 ready、degraded 还是 unavailable。
- 依赖什么：阶段 2、3 的局域网路径；中转 Transport 文档和真实 fixture。
- 先看哪些文档：`requirements.md` 需求 4、11；父仓库对照文档；现有中转调查报告。
- 主要改哪些文件：`src/dsh-capabilities/` relay route、`src/host/` relay adapter、fixture 和调查文档。
- 明确不做什么：不把浏览器端短期 ticket 直接转发给目标 Host，不用任意公网 URL 替代中转能力。
- 怎么验证：真实/模拟中转握手、双向 WS、断线、重连、ticket 脱敏和能力缺失测试。

### 7.2 实现断线、重连和状态刷新

- 状态：`IN_PROGRESS`
- 已完成增量：新增 `PeerHostReconnectManager`，管理单 PeerHost 的 `connecting/ready/reconnecting/unreachable/relay_unavailable/stopped` 状态，使用有界指数退避和最大尝试次数；断线后下一次连接只提升该作用域 generation，重连成功触发状态回调并返回新的完整 `HostScope` 快照，关闭时清理 timer、socket 和内存中的短期凭据。PeerHost Feature 已注册 manager 资源清理，并通过 connector 入口接入 LAN/受控 relay 生命周期。
- 本次增量（2026-09-28）：Client `HostRouter.rebuild` 和 `PeerHostSessionController.rebuildAfterReconnect` 已接入重连状态回调边界；重连成功后旧 HostScope disposer/WS 订阅先清理，再递增 Client generation，调用方可在返回的新作用域上刷新摘要并重新订阅。
- 改动文件：`src/host/modules/peer-host/peer-host-relay.ts`、`src/host/features/peer-host.ts`、`tests/peer-host-relay.spec.ts`
- 验证命令：`pnpm run build && node --test tests/peer-host-relay.spec.ts`（4 项通过）；`pnpm run typecheck`
- 已知限制：当前 WebSocket 代理客户端连接关闭后不能在同一个浏览器 socket 上替换远端 socket；manager 负责 Host 侧连接状态和资源治理，UI/session adapter 必须消费新的 `HostScope` 并重新订阅，不能复用旧 generation。relay Transport 未验证时仍保持 `relay_unavailable/degraded`。
- 做什么：为单个 PeerHost 提供有界重试、手动重连、摘要刷新和可恢复订阅。
- 做完看到什么：目标不可达显示真实状态，恢复后只刷新该 Host 并恢复允许的会话流。
- 依赖什么：4.1、4.2、7.1；Host 状态机和 WS 生命周期。
- 先看哪些文档：`requirements.md` 需求 11；`design.md` §7.3、§11。
- 主要改哪些文件：PeerHost service、aggregate store、WS reconnect manager、测试。
- 明确不做什么：不无限创建计时器，不用过期缓存伪装成可用数据。
- 怎么验证：超时、断线、指数退避上限、恢复 generation、单 Host 隔离和模块停用清理测试。

### 7.3 增加运行时诊断和隐私检查

- 状态：`TODO`
- 做什么：补充 PeerHost 状态诊断、性能指标和日志敏感字段扫描。
- 做完看到什么：维护者能定位握手、代理、作用域和中转失败，同时日志不含凭据和内容数据。
- 依赖什么：全部前置阶段；现有 resource-scope debug log 规范。
- 先看哪些文档：`requirements.md` 需求 12；`design.md` §11、§12。
- 主要改哪些文件：诊断 DTO、日志工具、`tests/peer-host-privacy.spec.ts`、文档。
- 明确不做什么：不采集完整文件、命令、模型消息或 relay ticket。
- 怎么验证：敏感字段断言、错误码覆盖、诊断接口权限和性能计时测试。

## 阶段 8：完整验证、文档和验收

### 8.1 三版本和多场景集成测试

- 状态：`IN_PROGRESS`
- 本次增量（2026-09-28）：新增 `tests/peer-host-integration.spec.ts`，串联当前 Host、LAN PeerHost、同名工作区/会话、单个 PeerHost 故障和目标路由隔离；三版本能力 fixture 仍待补齐。
- 当前验证：待下一轮构建后运行 `node --test tests/peer-host-integration.spec.ts`。
- 做什么：把当前 Host、局域网 PeerHost、中转 PeerHost、未登录、版本不兼容、fingerprint 变化和断线恢复串成集成 fixture。
- 做完看到什么：一套可重复测试证明单 Host 行为未被破坏，多 Host 作用域正确。
- 依赖什么：阶段 1 至 7。
- 先看哪些文档：`requirements.md` 全部需求；`design.md` §13、§14。
- 主要改哪些文件：`tests/peer-host-integration.spec.ts`、三版本 fixture、测试脚本。
- 明确不做什么：不依赖未锁定的公网 Host 或不可重复的人工环境。
- 怎么验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`pnpm test`。

### 8.2 文档、能力报告和索引同步

- 状态：`TODO`
- 做什么：更新能力报告、README、AGENTS Spec 索引、调查报告和开发记录，记录已实现能力与降级边界。
- 做完看到什么：新成员能从 Spec、能力矩阵和验证证据追踪 PeerHost 的完整边界。
- 依赖什么：8.1 及各阶段完成证据。
- 先看哪些文档：仓库 `AGENTS.md` 文档规范；本 Spec README、设计和父仓库对照文档。
- 主要改哪些文件：`AGENTS.md`、`README.md`、`docs/生成报告/`、`docs/开发记录/` 和本 Spec 文档。
- 明确不做什么：不手工编辑脚本生成产物，不删除已有 Spec 引用。
- 怎么验证：链接检查、`git diff --check`、能力报告生成和文档路径扫描。

### 8.3 发布前回归与验收签字

- 状态：`TODO`
- 做什么：逐条对照需求验收标准，记录已知限制、未支持工具和发布阻塞项。
- 做完看到什么：需求 1 至 12、非功能需求和成功定义都有测试或明确证据。
- 依赖什么：8.1、8.2；用户确认的 fingerprint 信任策略和中转能力结论。
- 先看哪些文档：`requirements.md` 验收标准、`design.md` 风险项、所有测试报告。
- 主要改哪些文件：本 Spec `tasks.md`、验收记录文档、必要的调查报告。
- 明确不做什么：不在没有证据时把降级能力标记为 ready，不执行提交、推送或发布。
- 怎么验证：完整四项验证命令、验收清单逐项勾选和 `git diff --check`。
