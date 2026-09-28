# spec006：PeerHost 管理与多 Host 工作区会话聚合

状态：阶段 1 至阶段 5 已完成；阶段 6、7 进行中；阶段 8 文档同步已完成，等待三版本集成验收。

## 这份 Spec 解决什么问题

当前 `codingns4dsh` 已经具备局域网访问和中转访问能力，但这两种能力只解决“访问当前 DSH Host”。用户无法在一个 DSH 工作区里管理其他已经安装本插件的 DSH Host，也无法把不同 Host 的工作区、会话、消息记录、聊天输入和右侧工具结果放在同一个工作流中使用。

本 Spec 增加一个独立的“管理其他 DSH Host”模块。模块启用后：

- 右下角出现连接管理入口。
- 用户可以添加局域网地址或中转入口对应的 PeerHost。
- 当前 Host 负责保存目标 Host 配置、检查兼容性、代管目标登录态和执行受控代理。
- Client 在一个带 Host 作用域的导航中聚合工作区和会话。
- 每个工作区和会话都带 Host 身份，避免相同 `workspaceId` 或 `sessionId` 串线。
- 打开远端会话后，中栏消息、聊天输入、实时事件和右侧栏请求都路由到对应 DSH Host。

## 设计原则

1. PeerHost 是“当前 Host 代理访问的目标资源”，不是把当前 Host 切换成另一台 Host。
2. Client 只提交 `targetHostId`，不保存目标 Host 的 access token 或 refresh token。
3. 所有跨 Host 资源都必须使用 `hostId + workspaceId + sessionId` 作用域。
4. 代理只允许明确登记的 DSH API、WebSocket 消息和目标 Host，禁止任意 URL 转发。
5. 局域网直连先落地；中转 Host 连接单独验证，不能假设浏览器侧中转 Transport 可以直接复用到 Node Host。
6. DSH 原生扩展点不足时允许阶段性使用远端 Web Context，但最终验收必须明确是否达到了原生三栏交互要求。

## 阅读顺序

1. `requirements.md`：用户可见行为、边界和验收标准。
2. `design.md`：Host/Client 架构、数据结构、代理、作用域和 UI 路由。
3. `docs/20260927-父仓库PeerHost实现对照与本项目边界.md`：父仓库实现可复用的逻辑及本项目差异。
4. `tasks.md`：按阶段执行的任务清单。每个任务完成后必须立即回写状态和验证证据。

## 与现有 Spec 的关系

- 依赖 `spec005-DSH能力注册与版本路由机制` 提供的能力矩阵和 Feature 能力声明。
- 复用 `spec001`、`spec002` 已定义的 Transport、HostScope、generation 和远程 Web 运行时边界。
- 不把父仓库 CodingNS 作为源码依赖；父仓库只作为行为和安全边界参考。
- 不改变当前单 Host 登录、局域网访问和中转访问的既有行为。

## 当前实现边界（2026-09-28）

- 已实现 PeerHost 管理面板、Host 侧加密凭据存储、固定握手、HTTP/WS 正向白名单和局域网 Host-to-Host `/ws` connector。
- 已实现 `HostScope` 作用域校验、`scopeGeneration` 清理、聊天/停止/权限/问题回答命令、实时消息写入、文件/Git/终端/右侧工具的受控适配器，以及有限指数退避和重连后的 generation 重建。
- 聚合层只接受显式注入的稳定 workspace/session source。未注入时返回 `unsupported` 和中文诊断，不把空列表伪装成成功；三版本 fixture 和真实 DSH source 仍属于阶段 8.1 验收范围。
- 原生导航只在结构探测到稳定 DSH 容器时挂载。能力缺失时保持 `degraded`/`unsupported`，不使用 iframe 或 Remote Web Context 冒充原生三栏聚合。
- Relay route 仅代表能力矩阵中的受控扩展点。Host-to-Host 工作台 JSON/WS Transport 尚未验证，所有中转 PeerHost 必须保持 `relay_unavailable/degraded`。
- 诊断只返回 PeerHost ID、路由类型、状态、稳定错误码、检查时间和脱敏 fingerprint；不向 Client 或日志写入 token、密码、relay ticket、完整 URL、文件内容、命令和模型正文。

详细证据见：[PeerHost 能力与中转边界调查](../../docs/调查报告/20260928-PeerHost能力与中转边界调查.md) 与 [PeerHost 聚合与断线重连实现记录](../../docs/开发记录/20260928-PeerHost聚合与断线重连实现记录.md)。

## 当前范围

本 Spec 覆盖：

- PeerHost 管理模块及设置页。
- 局域网和中转 PeerHost 地址模型。
- Host 握手、版本/API 兼容、插件存在性和 fingerprint 检查。
- 目标 Host 登录态的 Host 侧加密存储和刷新。
- 受控 HTTP/WS 代理。
- Host 作用域、聚合工作区/会话导航和 Host 标签。
- 远端会话中栏、聊天输入、实时流和右侧工具路由。
- 断线、版本变化、目标登录过期和作用域切换清理。

明确不在本 Spec 内：

- 跨 Host 数据同步、复制、迁移和全局搜索。
- 任意 URL、任意 WebSocket 或任意第三方 Host 代理。
- PeerHost 的递归代理和代理链路发现。
- 把目标 Host 的插件 Bundle 安装到当前 DSH Profile。
- 破坏当前 Host 切换、局域网访问和中转访问的现有语义。
