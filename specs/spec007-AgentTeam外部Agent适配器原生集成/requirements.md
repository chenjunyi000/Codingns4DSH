# 需求文档 - Agent Team 外部 Agent 适配器原生集成

状态：技术规划完成，待实施。

## 简介

DSH `0.1.7-rc.2` 的 Agent Team 是一个以 Lead Session 为根的原生协作模型：Lead 是真实 DSH Agent，teammate 是可继续运行的 child Agent，成员和任务状态写回 Lead Session，Web UI 从 `agentTeam` projection 读取 roster 和任务。插件的外部 CLI 适配器则拥有另一套进程、会话、工具事件和权限处理模型。

如果直接把外部 CLI 当作 DSH Agent，必须伪造 Agent、Session、inbox 和 continuation manager 状态，最终会破坏 DSH 的授权、持久化和销毁语义。本需求采用 Proxy Teammate：DSH 管理一个真实成员，插件将该成员的运行请求绑定到外部适配器。

## 术语表

- **System**：本插件在 DSH Host 中注入运行的 Host/Client 功能集合。
- **DSH Agent Team**：DSH `0.1.7-rc.2` 的原生智能体团队能力。
- **Proxy Teammate**：由 DSH 创建、代表一个外部 Agent 的真实 DSH 子 Agent。
- **External Agent**：由插件 CLI 适配器驱动的外部 Agent 进程或远程协议会话。
- **Adapter**：现有 `CodingNsCliAdapterRegistry` 中的外部 Agent 驱动实现。
- **Provider Session**：外部适配器返回的可恢复会话标识，不等同于 DSH `memberSessionId`。
- **外部详情面板**：插件提供的面板，用于展示官方 Team 面板无法表达的外部流和工具细节。

## 范围说明

### In Scope

- 在检测到 DSH Agent Team 能力时，通过插件工具创建 External Agent Proxy Teammate。
- 将 Proxy Teammate 与 adapter、model、effort、provider session 建立 Host-only 绑定。
- 使用原生 Team 任务、成员状态、Owner、依赖、write scope 和会话导航。
- 将外部 Agent 的文本、思考、工具、权限、提问、usage、错误、完成和中断状态投影到插件详情面板。
- 支持外部会话恢复、丢失、归档、重试和中断，并保证 Team 失败隔离。
- 在 Team Profile 未启用、版本不支持或能力探测失败时安全降级到现有 CLI 功能。

### Out of Scope

- 修改 DSH Host 源码或其 Agent Team 私有实现。
- 让 External Agent 直接拥有未适配的 `send_message`、`team_task_update` 等 DSH 工具。
- 修改官方 Team 工具名称、官方 projection 格式或直接写入 `agentTeam` projection。
- 跨进程 Team、跨机器 Team、worktree 隔离和文件锁。
- 通过 ACP one-shot provider 声称获得完整 continuable Team 成员能力。

## 需求

### 需求 1：能力识别和安全降级

**用户故事：** 作为插件用户，我希望插件只在 DSH Team 能力真实存在时启用外部 Team 集成，以便旧版本和关闭 Profile 时不影响现有功能。

#### 验收标准

1. WHEN DSH 版本为 `0.1.7-rc.2` 且 `agentTeams`、`subagents`、`events` 和会话持久化能力可用 THEN System SHALL 生成可诊断的 `supported` 能力结果。
2. WHEN Team Profile 未启用、能力探测失败或版本低于支持范围 THEN System SHALL 不注册外部 Team 工具，并保留现有非 Team CLI 功能。
3. WHEN 能力在运行中消失或注入对象不完整 THEN System SHALL 停止新建外部成员、保留可关闭的已有运行，并给出脱敏诊断。

### 需求 2：创建和绑定 Proxy Teammate

**用户故事：** 作为 Lead，我希望通过插件工具把指定外部 Agent 加入 Team，以便它出现在原生 roster 中并接受 Team 任务。

#### 验收标准

1. WHEN 用户选择 adapter、model 和可选 effort 创建外部成员 THEN System SHALL 创建一个真实 DSH Proxy Teammate，并返回 `memberSessionId` 与脱敏绑定摘要。
2. WHEN同一个 `teamId + memberSessionId` 已绑定活动外部运行 THEN System SHALL 拒绝重复绑定，不启动第二个外部进程。
3. WHEN外部 adapter 不可用、模型不存在或 Team 成员上限已达 THEN System SHALL 不留下孤儿 Proxy，并返回结构化错误。

### 需求 3：原生 Team 管理保持不变

**用户故事：** 作为用户，我希望外部成员遵循原生 Team 的成员和任务语义，以便继续使用 Team Web 面板管理协作。

#### 验收标准

1. WHEN Proxy Teammate 创建成功 THEN System SHALL 让官方 Team 面板显示其 roster、状态和会话入口。
2. WHEN原生任务指定 Proxy 为 Owner THEN System SHALL 通过 DSH 原生任务板维护 Owner、状态、依赖和 write scope，不创建第二套任务板。
3. WHEN Proxy 被 DSH 中断、Lead 结束或 Team 被销毁 THEN System SHALL 终止或归档对应外部运行，并释放插件持有的资源。

### 需求 4：外部运行与流投影

**用户故事：** 作为用户，我希望看到外部 Agent 正在做什么，以便在原生 Team 管理之外检查实际执行细节。

#### 验收标准

1. WHEN外部 Agent 产生文本、思考、工具、权限、问题、usage 或错误事件 THEN System SHALL 按单调序列号写入 Host-only 外部事件流，并投影到插件详情面板。
2. WHEN外部事件无法映射为 DSH 原生消息类型 THEN System SHALL 保留原始事件的脱敏结构于插件事件流，不伪造 DSH 原生事件。
3. WHEN Web 面板只打开官方 Team 页面 THEN System SHALL 至少显示 Proxy 成员和原生状态；外部工具时间线、权限详情和 usage SHALL 通过插件详情面板提供。

### 需求 5：消息、权限和提问边界

**用户故事：** 作为外部 Agent 用户，我希望权限和提问仍由插件适配器处理，同时不破坏 DSH Team 的授权边界。

#### 验收标准

1. WHEN外部 Agent 请求权限或提问 THEN System SHALL 通过现有 adapter registry 的 `respondPermission`、`respondQuestion` 契约处理，并绑定 `memberSessionId`。
2. WHEN Proxy 需要向 Lead 或其他成员汇报 THEN System SHALL 只通过已定义的插件桥接或原生 Team 消息入口发送，不直接修改 DSH 私有 mailbox。
3. WHEN用户尝试从插件面板操作不属于当前 Team 或当前用户的成员 THEN System SHALL 拒绝操作并不泄露 provider session 或凭据。

### 需求 6：恢复、归档和失败隔离

**用户故事：** 作为用户，我希望外部 CLI 崩溃或会话过期时 Team 仍然可用，以便一个成员失败不会拖垮整个工作区。

#### 验收标准

1. WHEN外部进程退出且 provider session 可恢复 THEN System SHALL 标记 Proxy 为可恢复状态，并允许显式恢复，不重复执行已确认的请求。
2. WHEN provider session 丢失或凭据失效 THEN System SHALL 标记绑定为 `error` 或 `archived`，保留诊断和原生任务历史，但不阻断 Lead 与其他成员。
3. WHEN用户中断 Proxy THEN System SHALL 先停止外部执行，再让 DSH Proxy 进入终止或空闲状态，并保证重复中断幂等。

### 需求 7：安全和隐私

**用户故事：** 作为部署者，我希望外部 Agent 的凭据和内部路径不会出现在 Team UI 或日志中，以便插件集成满足 Host 安全边界。

#### 验收标准

1. WHEN绑定或事件写入 Host store THEN System SHALL 只保存 adapter id、脱敏 session 摘要、状态和时间，不保存明文凭据。
2. WHEN Client 请求外部详情 THEN System SHALL 按 `memberSessionId` 返回脱敏 DTO，不返回 provider token、环境变量、完整命令行或任意本地绝对路径。
3. WHEN日志记录失败、权限和退出信息 THEN System SHALL 对 token、refresh token、命令参数和敏感输入进行脱敏。

### 需求 8：版本兼容和向后兼容

**用户故事：** 作为现有插件用户，我希望升级插件后原有 CLI 会话行为不变，以便 Team 集成不会破坏当前工作流。

#### 验收标准

1. WHEN运行于支持范围内但未启用 Agent Team 的 DSH THEN System SHALL 保持现有 CLI adapter 的检测、执行、恢复、权限、提问、中断和释放行为。
2. WHEN运行于 `0.1.5-rc.3` 或 `0.1.6-alpha.2` THEN System SHALL 不注册依赖 `agentTeams` 的能力，并提供明确的不可用原因。
3. WHEN外部 Team 功能发生异常 THEN System SHALL 只影响对应 Proxy/adapter，不改变默认 DSH `llm/stream` 和其他会话。

## 非功能需求

### 非功能需求 1：性能

1. WHEN外部事件到达 THEN System SHALL 在不阻塞 DSH Agent Loop 的前提下完成有界队列入列；详情面板首屏只读取摘要和最近窗口。
2. WHEN单个外部成员产生高频工具输出 THEN System SHALL 使用每成员有界队列、事件大小上限和背压策略，不能无限增长 Host 内存。

### 非功能需求 2：可靠性

1. WHEN Host、adapter 或 Web 面板重连 THEN System SHALL 通过 `teamId + memberSessionId + eventSeq` 恢复可重放窗口，并丢弃旧 generation 的事件。
2. WHEN任意单个外部成员失败 THEN System SHALL 保留 Team roster 和任务历史，其他成员继续工作。

### 非功能需求 3：可维护性

1. WHEN新增外部 adapter THEN System SHALL 只实现现有 `CodingNsCliAdapterDriver` 契约并声明事件能力，不直接依赖 DSH 版本专属类型。
2. WHEN新增 DSH 版本或 Team API 变化 THEN System SHALL 通过 `src/dsh-capabilities/` 的 route、fixture 和诊断更新，而不是在业务模块散落版本判断。
3. WHEN排查问题 THEN System SHALL 能按 `teamId`、`memberSessionId`、`bindingId` 和 `eventSeq` 关联日志、状态和外部会话。

## 成功定义

- DSH `0.1.7-rc.2` 中可创建至少一个外部 Proxy Teammate，官方 Team 面板可见成员和原生任务状态。
- 插件详情面板可展示文本、思考、工具、权限、提问、usage、错误、恢复和中断结果，且不泄露凭据。
- Team Profile 关闭、旧 DSH 版本、adapter 失败和外部进程崩溃均有可解释降级，现有非 Team CLI 流程回归通过。
- `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check` 和相关单元/集成测试通过；不修改 DSH Host 源码。
