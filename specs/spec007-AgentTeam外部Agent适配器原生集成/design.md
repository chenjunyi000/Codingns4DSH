# 设计文档 - Agent Team 外部 Agent 适配器原生集成

状态：技术规划完成，待实施。

## 1. 概述

### 1.1 目标

- 使用真实 DSH Proxy Teammate 保留原生 Agent Team 的 roster、任务板、mailbox、会话导航和生命周期。
- 将外部 CLI 绑定到 Proxy，而不是伪造 DSH Agent 或写入 DSH 私有 Team 状态。
- 复用现有 CLI adapter registry、消息投影、native session bridge 和 Host-only session store。
- 让官方 Team Web 面板负责“谁在 Team 中、任务是什么”，让插件详情面板负责“外部 Agent 实际做了什么”。
- 在不修改 DSH Host 的前提下，通过 Feature、Cordis 注入、事件总线和已有 provider/Session 扩展点完成集成。

### 1.2 覆盖需求

- `requirements.md` 需求 1 至需求 8。

### 1.3 技术约束

- Host：TypeScript、Cordis Feature、DSH Host 注入上下文、现有 `CodingNsCliAdapterRegistry`。
- Client：DSH Web 注入、现有 Client Feature 和插件详情面板；官方 Team UI 只通过 DSH projection 展示原生数据。
- 数据存储：插件 Host-only settings/session store；不把凭据或绑定私密字段写入 DSH Team projection。
- 事件：现有 `llm/stream`、`agent/created`、`agent/status`、`agent/disposed` 等可观察事件；外部详情使用插件事件协议。
- 版本：第一阶段只支持 DSH `0.1.7-rc.2` 的 Agent Team；`0.1.5-rc.3`、`0.1.6-alpha.2` 保持非 Team CLI 行为。
- 外部依赖：现有各 CLI adapter；ACP 仅作为后续 one-shot 实验，不作为本方案依赖。
- 禁止事项：修改 DSH Host、monkey patch Agent prototype、篡改 `agentTeam` projection、覆盖官方 Team 工具名、伪造 TeamService 私有状态。

## 2. 架构

### 2.1 系统结构

```text
DSH Lead Session
  │
  ├─ 官方 Agent Team Service / Team tools / agentTeam projection
  │       ├─ member: real DSH Proxy Teammate
  │       ├─ task: native task board
  │       └─ message: native Team message boundary
  │
  └─ 插件 Host Feature
          ├─ ExternalTeamService
          ├─ TeamExternalBindingStore (Host-only)
          ├─ ExternalEventJournal (bounded, Host-only)
          ├─ CodingNsCliAdapterRegistry
          ├─ CodingNsDshMessageProjector
          └─ CodingNsNativeSessionBridge
                    │
                    └─ external CLI process/protocol

Plugin Client
  ├─ official Team Web panel: roster/task/session navigation
  └─ external Agent detail panel: stream/tool/permission/question/usage/error
```

核心数据流：

1. Lead 或用户调用 `spawn_external_teammate`。
2. 插件检查能力和 adapter 后，调用公开的 DSH Team/子 Agent 创建边界，得到真实 `memberSessionId`。
3. 插件在 Host-only store 写入绑定，并把 Proxy 的后续运行请求关联到外部 adapter。
4. `external_agent_run` 启动 `CodingNsCliAdapterRegistry`，外部事件写入有界事件日志并投影到 Proxy/插件详情。
5. Team 面板继续从 DSH 原生 projection 读取成员和任务；详情面板从插件 RPC 读取脱敏外部事件。
6. 中断、结束、恢复和销毁沿 Proxy 生命周期反向清理外部运行。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `ExternalTeamCapabilityRoute` | 探测 DSH Team 注入和版本能力 | DSH Context、版本 | 能力解析结果、诊断码 |
| `ExternalTeamService` | 创建 Proxy、绑定 adapter、协调运行生命周期 | Team、adapter、session | `memberSessionId`、绑定状态 |
| `TeamExternalBindingStore` | 保存 Host-only 绑定和脱敏摘要 | binding、状态变更 | 快照、恢复索引 |
| `ExternalEventJournal` | 保存有界、单调序列的外部事件窗口 | 外部事件 | eventSeq、最近窗口、丢弃计数 |
| `CodingNsCliAdapterRegistry` | 执行、恢复、权限、提问、中断和释放外部 CLI | adapter session request | 外部 driver 事件和结果 |
| `CodingNsDshMessageProjector` | 将可表达的外部输出投影到 Proxy 会话 | 外部 chunks、Proxy session | DSH 消息投影 |
| `CodingNsNativeSessionBridge` | 将外部已执行工具写入只读历史 | 工具调用/结果 | 不再触发执行的历史记录 |
| `ExternalTeamRpc` | 返回脱敏绑定、事件窗口和操作结果 | memberSessionId、cursor | Client DTO、错误 |
| `ExternalAgentDetailPanel` | 展示外部运行详情并发送权限/问题/中断操作 | 脱敏 DTO、用户操作 | UI 状态、RPC 请求 |

### 2.3 关键流程

#### 2.3.1 创建外部 Proxy Teammate

1. 插件能力路由确认 DSH Agent Team、subagents、events 和 session persistence 均可用。
2. 校验 adapter id、model、effort、Team 成员上限和当前用户权限。
3. 通过公开扩展边界创建真实 DSH Proxy Teammate；不得构造假的 Agent 对象。
4. 为 `teamId + memberSessionId` 写入 `TeamExternalBinding`，状态为 `starting`。
5. 向调用者返回 Proxy 成员摘要；官方 Team projection 的更新由 DSH 自己完成。

#### 2.3.2 启动外部运行

1. Lead/用户通过插件工具或任务触发 `external_agent_run`。
2. 服务验证绑定属于当前 Team，检查是否已有活动 run，并生成新的 `runId`。
3. 调用 `CodingNsCliAdapterRegistry.execute()` 或恢复接口，传递工作目录、模型、effort 和 provider session。
4. 将外部事件转换为统一 `ExternalAgentEvent`，分配单调 `eventSeq`，写入有界 journal。
5. 对能表达的文本、思考和工具结果调用现有 DSH message projector；权限和问题保留插件交互状态。
6. 更新绑定状态和原生任务状态的桥接结果，向 Client 推送增量或由 Client 游标拉取。

#### 2.3.3 中断、恢复和销毁

1. 用户从详情面板或原生 Team 成员操作触发中断。
2. 服务以 `runId` 幂等调用 adapter `interrupt()`，等待有限时间后执行 `dispose()`。
3. 更新绑定为 `idle`、`error` 或 `archived`，保留最后一个 `eventSeq` 和错误码。
4. Proxy Session 被 DSH dispose 时，插件监听 `agent/disposed` 并清理外部进程、订阅和临时队列。
5. provider session 可恢复时只允许显式恢复；恢复请求必须携带上次确认的 cursor，避免重复执行。

#### 2.3.4 Web 面板查看

1. 官方 Team 面板显示真实 Proxy 成员、原生状态、任务 Owner、依赖、write scope 和会话导航。
2. 用户从成员详情或插件入口打开外部详情面板，Client 只提交 `memberSessionId` 和事件 cursor。
3. Host 返回 adapter、model、effort、provider session 脱敏摘要、当前工具、权限请求、问题、usage、错误和最近事件。
4. 用户的权限、问题、重试、中断和打开外部原生会话操作全部由 Host 校验绑定后执行。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7、8。

- `createExternalTeamFeature()`：按能力画像注册 Host/Client Feature；不满足能力时返回无害的 disabled module。
- `ExternalTeamService`：唯一拥有绑定生命周期的服务。
- `TeamExternalBindingStore`：唯一保存绑定权威状态的 Host-only store。
- `ExternalEventJournal`：事件序列、窗口和背压的权威实现。
- `ExternalTeamToolService`：注册插件自有工具，不占用官方 Team 工具名称。
- `ExternalTeamRpc`：只输出脱敏 DTO，并执行成员作用域校验。
- `ExternalAgentDetailPanel`：只依赖插件内部契约，不导入 DSH 私有类型。

### 3.2 数据结构

#### 3.2.1 `TeamExternalBinding`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `bindingId` | `string` | 是 | 插件绑定唯一标识 | Host 生成，不可由 Client 指定 |
| `teamId` | `string` | 是 | 原生 Team/Lead Session 标识 | 只允许当前 Host 可见 Team |
| `memberSessionId` | `string` | 是 | 真实 Proxy Teammate Session | 不可伪造、不可复用到其他 Team |
| `adapterId` | `string` | 是 | 外部 adapter 标识 | 必须存在于 registry |
| `providerSessionId` | `string` | 否 | 外部可恢复会话 | 脱敏显示；凭据不存此字段 |
| `modelId` | `string` | 否 | 外部模型 | 使用 adapter 允许值 |
| `effortId` | `string` | 否 | 思考强度 | 使用 adapter 允许值 |
| `status` | `starting \| running \| idle \| error \| archived` | 是 | 绑定状态 | 状态迁移由 Host 服务串行化 |
| `runId` | `string` | 否 | 当前外部运行 | 同一绑定最多一个活动 run |
| `lastEventSeq` | `number` | 是 | 最后持久化事件序号 | 单调递增 |
| `lastEventAt` | `string` | 否 | 最近事件时间 | ISO 8601 |
| `createdAt` | `string` | 是 | 创建时间 | ISO 8601 |
| `updatedAt` | `string` | 是 | 更新时间 | ISO 8601 |

#### 3.2.2 `ExternalAgentEvent`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `bindingId` | `string` | 是 | 绑定标识 | 必须匹配请求作用域 |
| `runId` | `string` | 是 | 外部运行标识 | 旧 run 事件必须丢弃 |
| `eventSeq` | `number` | 是 | 单调事件序号 | Host 分配，不能由 driver 提供 |
| `type` | `text \| reasoning \| tool \| permission \| question \| usage \| finished \| failed` | 是 | 事件类型 | 未知类型进入 `failed` 诊断或扩展字段 |
| `payload` | `unknown` | 是 | 脱敏事件载荷 | 大小受 `maxMessageBytes` 类似限制 |
| `createdAt` | `string` | 是 | 事件时间 | ISO 8601 |

#### 3.2.3 `ExternalAgentDetailDto`

Client 可见字段包括 `memberSessionId`、`adapterId`、adapter 展示名、CLI 版本、model、effort、status、当前工具摘要、pending permission/question、usage 摘要、错误码、`lastEventSeq` 和是否可恢复。禁止返回 token、环境变量、完整命令行、完整 provider session secret 和本地绝对路径。

### 3.3 接口契约

#### 3.3.1 `spawn_external_teammate`

- 类型：插件工具 / Function
- 标识：`spawn_external_teammate`
- 输入：`{ adapterId, modelId?, effortId?, name?, prompt? }`
- 输出：`{ bindingId, teamId, memberSessionId, adapterId, status }`
- 校验：Team 能力、成员上限、adapter、模型、名称长度、当前 Team 作用域。
- 错误：`AGENT_TEAM_UNAVAILABLE`、`EXTERNAL_ADAPTER_NOT_FOUND`、`EXTERNAL_MEMBER_LIMIT`、`EXTERNAL_BINDING_EXISTS`。

#### 3.3.2 `external_agent_run`

- 类型：插件工具 / Function
- 标识：`external_agent_run`
- 输入：`{ memberSessionId, prompt, taskId?, providerSessionId?, resumeCursor? }`
- 输出：`{ bindingId, runId, status, lastEventSeq }`
- 校验：成员归属、无活动 run、prompt 大小、任务归属、恢复 cursor。
- 错误：`EXTERNAL_MEMBER_NOT_FOUND`、`EXTERNAL_RUN_ACTIVE`、`EXTERNAL_SESSION_LOST`、`EXTERNAL_PERMISSION_REQUIRED`。

#### 3.3.3 外部详情 RPC

- 类型：RPC
- 标识：`external-agent.get-detail`、`external-agent.list-events`、`external-agent.respond-permission`、`external-agent.respond-question`、`external-agent.interrupt`、`external-agent.resume`
- 输入：`memberSessionId`、可选 `cursor`、操作 payload。
- 输出：脱敏 `ExternalAgentDetailDto`、事件窗口或操作结果。
- 校验：当前用户、Team、memberSessionId 和 bindingId 必须一致；事件分页有界。
- 错误：`EXTERNAL_SCOPE_MISMATCH`、`EXTERNAL_EVENT_CURSOR_INVALID`、`EXTERNAL_RUN_NOT_FOUND`、`EXTERNAL_OPERATION_TIMEOUT`。

#### 3.3.4 Host 注入和监听边界

- 注入：优先通过 `ctx.inject(['agentTeams', 'subagents', 'events', 'sessionPersistence'])` 获取公开能力；真实字段名必须通过版本 route 探测，不在业务层写版本判断。
- 注册：使用 `ctx.subagents.registerProvider` 仅在验证过的公开 provider 契约可表达 continuable Proxy 时启用；不能把 ACP one-shot provider 伪装成可持续成员。
- 事件：使用 `ctx.events.on('llm/stream', ...)` 和生命周期事件观察 Proxy 运行；不得替换 DSH Agent Loop 或修改私有 TeamService。
- 现有服务：复用 `CodingNsCliAdapterRegistry`、`CodingNsDshMessageProjector`、`CodingNsNativeSessionBridge`，将 DSH 类型封装在 `src/dsh-capabilities/` 适配器边界内。

## 4. 数据与状态模型

### 4.1 数据关系

`Lead Session` 通过 DSH 原生 Team 持有 `Proxy Teammate Session`；插件以 `teamId + memberSessionId` 为绑定主键，并以 `bindingId` 作为内部稳定引用。一个绑定最多一个活动 `runId`，一个 run 产生单调 `eventSeq` 事件窗口。`providerSessionId` 只属于外部 adapter，不得用来替代 DSH session id。

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `starting` | Proxy 已创建，外部运行尚未确认 | 创建绑定成功 | 首个运行事件、初始化失败 |
| `running` | 外部 run 正在执行 | adapter execute/resume 成功 | 完成、中断、失败 |
| `idle` | 成员存在但当前无外部 run | run 完成或显式停止 | 新 run、归档、Proxy dispose |
| `error` | 外部失败但仍可诊断/恢复 | adapter 错误、session 丢失、权限失败 | 显式恢复、归档 |
| `archived` | 绑定不可再运行，仅保留历史 | Team/Proxy 销毁或用户归档 | 不允许自动复活 |

### 4.3 一致性规则

- 绑定写入先于运行启动；运行确认后再更新 `running`。
- 所有状态变更按 `bindingId` 串行化，重复中断、重复完成和旧 run 事件必须幂等丢弃。
- 事件 journal 满时优先丢弃最老的非状态摘要事件，并累计丢弃计数；`finished`、`failed`、`permission` 和 `question` 不得静默丢失。
- DSH Team projection 是 Team roster/任务的唯一权威；插件绑定 store 是外部 adapter 关联的唯一权威。

## 5. 错误处理

### 5.1 错误类型

- `AGENT_TEAM_UNAVAILABLE`：DSH 版本或注入能力不支持 Team。
- `EXTERNAL_ADAPTER_NOT_FOUND`：adapter 未注册或检测失败。
- `EXTERNAL_BINDING_EXISTS`：同一 Proxy 已有活动绑定。
- `EXTERNAL_SCOPE_MISMATCH`：请求的 Team/memberSessionId 不属于当前作用域。
- `EXTERNAL_SESSION_LOST`：provider session 不可恢复。
- `EXTERNAL_RUN_ACTIVE`：同一绑定存在活动 run。
- `EXTERNAL_EVENT_CURSOR_INVALID`：事件游标过期或属于其他 run。
- `EXTERNAL_OPERATION_TIMEOUT`：中断、恢复或释放超时。

### 5.2 错误响应格式

```json
{
  "detail": "外部 Agent 会话已失效，请重新启动",
  "error_code": "EXTERNAL_SESSION_LOST",
  "field": "providerSessionId",
  "timestamp": "2026-09-28T00:00:00Z"
}
```

### 5.3 处理策略

1. 输入验证错误：在创建 run 前拒绝，不创建进程、不写入活动绑定。
2. 业务规则错误：返回结构化错误，保持 Team 原生状态不变。
3. 外部依赖错误：更新绑定为 `error`，保留可脱敏诊断，其他 Team 成员继续运行。
4. 重试、降级或补偿：只允许显式恢复；恢复必须复用 provider session 和 cursor 规则，禁止自动重放不确定请求。
5. 关闭清理：Feature 停用、Host 关闭和 Proxy dispose 都必须有超时和最终释放路径。

## 6. 正确性属性

### 6.1 属性 1：Team 状态权威唯一

对于任何 Team roster、任务 Owner、依赖和 write scope，系统都应该只读写 DSH 原生 Team 能力，不在插件创建第二份可竞争的 Team 状态。

**验证需求：** 需求 3、需求 8。

### 6.2 属性 2：外部运行作用域隔离

对于任何外部事件，只有当 `teamId`、`memberSessionId`、`bindingId` 和 `runId` 全部匹配当前活动作用域时，事件才能改变绑定状态或进入 Client 事件窗口。

**验证需求：** 需求 4、需求 5、需求 7。

### 6.3 属性 3：一次活动运行

对于任何绑定，系统最多允许一个活动 `runId`；重复启动必须在 adapter 调用前失败，重复中断和重复完成必须无副作用。

**验证需求：** 需求 2、需求 6。

### 6.4 属性 4：失败隔离

对于任何单个外部 adapter 或 provider session 的失败，Lead、其他 Team 成员、原生任务历史和默认 DSH `llm/stream` 都必须保持可用。

**验证需求：** 需求 6、需求 8。

## 7. 测试策略

### 7.1 单元测试

- 能力 route：版本、注入缺失、Profile 关闭和诊断码。
- Binding store：唯一性、状态机、序列号、脱敏和恢复索引。
- Event journal：有界队列、背压、旧 run 丢弃、cursor 和关键事件保留。
- ExternalTeamService：创建、重复绑定、单活动 run、幂等中断和释放。
- RPC/工具：作用域校验、参数边界、错误码和凭据不泄露。

### 7.2 集成测试

- fake DSH `0.1.7-rc.2` Context + fake Team provider + fake CLI driver 的创建到完成主链路。
- 文本、思考、工具、权限、问题、usage、失败和恢复事件的投影。
- `agent/created`、`agent/status`、`agent/disposed` 与外部 run 的生命周期联动。
- Team Profile 关闭、旧 DSH fixture 和 adapter registry 空集的安全降级。

### 7.3 端到端测试

- 官方 Team 面板看到 Proxy roster、原生任务和会话导航。
- 插件详情面板看到外部事件、权限/问题交互、中断、重试和打开外部会话。
- 外部进程崩溃、Host 重连、事件窗口追赶、Proxy 销毁和页面切换。
- 敏感字段扫描：Token、环境变量、完整命令行和本地绝对路径不出现在 Client DTO、事件和日志。

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| 需求 1、8 | §2.1、§3.3.4、§7.1 | 三版本 capability fixture、Feature 启停和降级测试 |
| 需求 2、3 | §2.3.1、§3.2.1、§4.1 | Proxy 创建、Team projection 和唯一绑定集成测试 |
| 需求 4、5 | §2.3.2、§3.2.2、§3.3.3、§4.2 | 事件序列、投影、权限/问题 RPC 测试 |
| 需求 6 | §2.3.3、§4.2、§4.3、§6.4 | 崩溃、恢复、中断、释放和失败隔离测试 |
| 需求 7 | §3.2.3、§5、§7.3 | DTO 脱敏、日志扫描和作用域攻击测试 |

## 8. 风险与待确认项

### 8.1 风险

- DSH 公开 `SubagentProvider` 仍可能只支持 seed/one-shot，无法创建真正可持续的 Proxy；必须先完成 fake Context 和真实 `0.1.7-rc.2` API 探测，不能靠私有字段绕过。
- 官方 Team Web 面板可能只展示 roster/任务，不展示 mailbox 时间线和外部工具细节；插件详情面板是必需的，不应承诺官方面板单独显示全部外部操作。
- 外部 CLI 的事件粒度、权限模型和 session resume 能力并不一致；统一契约必须允许能力声明和降级。
- DSH Team 是单进程共享 cwd，没有 worktree/file lock；多个外部成员并行写文件会产生真实冲突，必须在任务说明和 write scope 中提示，而不是假装已解决。
- `llm/stream` 拦截和 native history 投影若与 Team Proxy 同时启用，可能形成重复消息或递归触发；需要明确 projection 去重键和事件来源。

### 8.2 待确认项

- DSH `0.1.7-rc.2` 是否有公开、稳定且可由插件调用的 Proxy Teammate 创建入口；若没有，第一阶段只能落地“原生 roster 关联 + 插件外部详情”，不能宣称完整成员创建。
- DSH Team 是否允许插件工具在 Lead Session 外安全创建 teammate；若不允许，必须由 Lead 原生工具先创建 Proxy，再由插件完成绑定。
- 是否需要把外部任务进度自动同步为 DSH task status；默认只做显式桥接，避免两个状态机互相覆盖。
- 详情面板首期采用事件轮询还是 DSH Client event bridge；默认先实现有界 cursor RPC，再根据真实 UI 注入点升级为实时推送。
