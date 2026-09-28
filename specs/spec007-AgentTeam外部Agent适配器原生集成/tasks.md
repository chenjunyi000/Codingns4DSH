# 任务清单 - Agent Team 外部 Agent 适配器原生集成（人话版）

状态：技术规划完成，待实施。

## 这份文档是干什么的

这份清单把“外部 Agent 以原生方式进入 DSH Agent Team，但不修改 DSH Host”拆成可独立验收的步骤。每个任务都写清楚改什么、看到什么、依赖什么、明确不做什么以及如何验证。

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住，必须写清楚原因
- `IN_REVIEW`：已经有结果，等待复核
- `DONE`：已经完成并回写验证证据
- `CANCELLED`：明确取消，并记录原因

规则：只有完成验证并回写证据后才允许标记 `DONE`。本轮只完成规划任务，实施任务保持 `TODO`。

## 阶段 0：调查和技术规划

- [x] 0.1 完成 DSH `0.1.7-rc.2` Agent Team 与插件外部 Agent 调查
  - 状态：DONE；已记录官方 npm 包、Team projection、九个 Team 工具、生命周期限制、Profile patch 限制和插件现有 CLI 架构。
  - 这一步到底做什么：确认 DSH Team 的真实数据结构、公开扩展边界、Web 面板能看到什么，以及现有外部 adapter 能复用什么。
  - 做完你能看到什么：可以证明“外部 CLI 不能直接伪造为 DSH Agent”，并能比较 Proxy、直接适配和 ACP one-shot 三条路径。
  - 先依赖什么：无。
  - 开始前先看：`docs/20260928-DSH-0.1.7-RC2-AgentTeam与外部适配器调查.md`、现有 CLI adapter 源码、spec005 能力矩阵。
  - 主要改哪里：本 Spec 的调查和规划文档，不改实现。
  - 这一步先不做什么：不修改 DSH Host，不接入私有 TeamService，不启动开发服务器。
  - 怎么算完成：调查证据、可行性评分、Web 展示边界和禁止事项已写清楚。
  - 怎么验证：人工走查包名、源码路径、需求/设计交叉引用。
  - 对应需求：全部需求的前置调查。
  - 对应设计：`design.md` §1、§2、§3.3.4、§8。

- [x] 0.2 完成完整技术规划和实施门禁
  - 状态：DONE；已完成 requirements、design、tasks、docs 目录文档，并定义能力门禁、数据模型、错误码、测试策略和待确认项。
  - 这一步到底做什么：把推荐架构、Host 注入点、Client 展示、状态机、失败隔离和分阶段实施写成可执行 Spec。
  - 做完你能看到什么：后续开发者无需重新讨论“外部 Agent 是否是原生成员”这个核心边界，可以按阶段任务实施。
  - 先依赖什么：0.1。
  - 开始前先看：Spec 模板、`requirements.md`、`design.md`、调查文档和 `docs/20260928-外部Agent代理成员技术规划.md`。
  - 主要改哪里：本 Spec 全部规划文档、根 `AGENTS.md` 索引。
  - 这一步先不做什么：不新增 TypeScript 实现、不改变 package peer 范围、不宣称未验证的 DSH provider 可用。
  - 怎么算完成：需求、设计、任务、调查证据可以互相追踪；实施任务全部有文件边界和验证命令。
  - 怎么验证：`git diff --check`；Markdown 链接和标题检查；人工复核不修改 Host 的约束。
  - 对应需求：全部需求。
  - 对应设计：全文。
### 阶段检查

- [x] 0.3 规划阶段检查点
  - 状态：DONE；已确认主方案为 Proxy Teammate，官方 Team 面板与插件详情面板的职责边界已记录。
  - 这一步到底做什么：检查本 Spec 是否足以进入实施，不把不可行的“直接外部 Agent 成员”带入代码阶段。
  - 做完你能看到什么：实施阶段有明确的 capability gate、公开 API 探测门槛和失败时的取消条件。
  - 先依赖什么：0.1、0.2。
  - 开始前先看：`requirements.md`、`design.md`、`docs/20260928-外部Agent代理成员技术规划.md`。
  - 主要改哪里：本阶段文档。
  - 这一步先不做什么：不开始实现，不把待确认项默认为已解决。
  - 怎么算完成：所有高风险假设都进入 `design.md` §8.2，实施任务可以按顺序执行。
  - 怎么验证：文档走查和交叉引用检查。
  - 对应需求：需求 1、3、4、8。
  - 对应设计：`design.md` §8。

## 阶段 1：能力路由和公开边界探测

- [ ] 1.1 增加 Agent Team 能力 ID、版本 route 和 fixture
  - 状态：TODO
  - 这一步到底做什么：在 `src/dsh-capabilities/` 增加 Team capability、`0.1.7-rc.2` route、注入对象结构探测和诊断码。
  - 做完你能看到什么：Team Profile 开启、关闭、注入缺失和旧版本都有确定的 `supported/degraded/unavailable` 结果。
  - 先依赖什么：0.3；spec005 当前能力矩阵。
  - 开始前先看：`requirements.md` 需求 1、8；`design.md` §3.3.4、§8.2；`src/dsh-capabilities/types.ts`、`matrix.ts`、`routes.ts`。
  - 主要改哪里：`src/dsh-capabilities/types.ts`、`matrix.ts`、`routes.ts`、`tests/dsh-capability-registry.spec.ts`、能力报告脚本/fixture。
  - 这一步先不做什么：不创建外部成员，不调用私有 TeamService，不放宽 peerDependencies。
  - 怎么算完成：三个 DSH fixture 均有解释性诊断；只有真实 `0.1.7-rc.2` Team 能力可进入后续阶段。
  - 怎么验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、能力 Registry 测试。
  - 对应需求：需求 1、需求 8。
  - 对应设计：§3.3.4、§8.2。

- [ ] 1.2 验证公开 Proxy 创建/continuation 契约
  - 状态：TODO；若 DSH 没有公开契约，必须把后续直接创建任务标为 `BLOCKED`，转入降级方案评审。
  - 这一步到底做什么：用真实包和 fake Context 验证 `ctx.subagents.registerProvider`、continuable、Agent Session 和生命周期接口是否足够创建 Proxy。
  - 做完你能看到什么：有一份可运行的最小 provider/Proxy fixture，或一份明确证明公开接口不足的阻塞证据。
  - 先依赖什么：1.1。
  - 开始前先看：调查文档 §3、§6；`design.md` §3.3.4、§8.2。
  - 主要改哪里：`tests/fixtures/agent-team/`、`src/dsh-capabilities/` 适配器、调查补充文档。
  - 这一步先不做什么：不读取或修改 DSH 私有字段，不 monkey patch Agent prototype，不把 ACP one-shot 当 continuable。
  - 怎么算完成：创建、继续、interrupt、dispose 的公开契约和参数已被 fixture 验证。
  - 怎么验证：fake Context 单测、真实 npm 包类型检查、最小生命周期回放。
  - 对应需求：需求 1、需求 2、需求 3、需求 8。
  - 对应设计：§2.3.1、§3.3.4、§8.2。

### 阶段检查

- [ ] 1.3 公开 API 门禁检查
  - 状态：TODO
  - 这一步到底做什么：决定是否进入 Proxy 成员实现，或暂停并采用“原生 Team 成员关联 + 插件详情”的降级路线。
  - 做完你能看到什么：没有公开 continuable 契约时，代码不会偷偷依赖私有实现。
  - 先依赖什么：1.1、1.2。
  - 开始前先看：`design.md` §8.2、调查文档和 fixture 结果。
  - 主要改哪里：`tasks.md`、调查/规划文档和能力诊断。
  - 这一步先不做什么：不为了通过测试而伪造 DSH Agent。
  - 怎么算完成：公开 API 足够则进入阶段 2；不足则记录 BLOCKED 原因和替代范围。
  - 怎么验证：人工走查 fixture、类型签名和禁止事项扫描。
  - 对应需求：需求 1、需求 8。
  - 对应设计：§3.3.4、§8.2。

## 阶段 2：Host 绑定和外部运行核心

- [ ] 2.1 实现 TeamExternalBindingStore 和状态机
  - 状态：TODO
  - 这一步到底做什么：实现绑定唯一性、Host-only 持久化、状态迁移、恢复索引和脱敏摘要。
  - 做完你能看到什么：每个 Proxy 只能绑定一个 adapter，重启后能恢复状态但不会暴露凭据。
  - 先依赖什么：1.3。
  - 开始前先看：`requirements.md` 需求 2、6、7；`design.md` §3.2.1、§4、§5。
  - 主要改哪里：`src/host/modules/agent-team/`、`src/shared/contracts/`、对应测试。
  - 这一步先不做什么：不启动外部 CLI，不创建 DSH Proxy，不接 Client UI。
  - 怎么算完成：唯一索引、状态机、序列化、脱敏和删除清理测试通过。
  - 怎么验证：单元测试、类型检查、敏感字段扫描。
  - 对应需求：需求 2、需求 6、需求 7。
  - 对应设计：§3.2.1、§4、§5。

- [ ] 2.2 实现 ExternalTeamService 和插件工具
  - 状态：TODO
  - 这一步到底做什么：注册 `spawn_external_teammate`、`external_agent_run`、状态查询和中断工具，连接真实 Proxy 与 binding store。
  - 做完你能看到什么：通过插件工具可以创建 Proxy、启动一个外部 run、查询状态和幂等中断。
  - 先依赖什么：1.3、2.1。
  - 开始前先看：`requirements.md` 需求 2、3、6；`design.md` §2.3、§3.3、§4.2。
  - 主要改哪里：`src/host/features/agent-team.ts`、`src/host/modules/agent-team/external-team-service.ts`、工具注册和测试。
  - 这一步先不做什么：不覆盖官方 Team 工具，不修改 `agentTeam` projection，不做 UI 详情。
  - 怎么算完成：Proxy 创建、绑定、单活动 run、重复启动拒绝、interrupt/dispose 清理均有测试。
  - 怎么验证：fake Team provider + fake CLI driver 集成测试；`pnpm run typecheck`。
  - 对应需求：需求 2、需求 3、需求 6。
  - 对应设计：§2.3.1、§2.3.2、§2.3.3、§3.3.1、§3.3.2。

- [ ] 2.3 接入现有 CLI registry 和外部事件 journal
  - 状态：TODO
  - 这一步到底做什么：把现有 adapter execute/resume/permission/question/interrupt/dispose 接到 binding 生命周期，并实现事件序列、背压和旧 run 丢弃。
  - 做完你能看到什么：外部 Agent 的事件能按 run 有序进入 Host journal，adapter 失败不会拖垮 Team。
  - 先依赖什么：2.1、2.2。
  - 开始前先看：`src/host/cli-adapters/driver.ts`、`registry.ts`、`dsh-message-projector.ts`、`native-session-bridge.ts`；`design.md` §2.2、§4.3。
  - 主要改哪里：`src/host/modules/agent-team/external-event-journal.ts`、`external-team-service.ts`、CLI registry 适配层、测试。
  - 这一步先不做什么：不把所有外部事件强行写成 DSH 原生事件，不改变现有非 Team CLI 路径。
  - 怎么算完成：文本/思考/工具/权限/问题/usage/完成/失败事件和有界队列测试通过。
  - 怎么验证：集成测试、压力/背压测试、事件 cursor 测试。
  - 对应需求：需求 4、需求 5、需求 6、需求 8。
  - 对应设计：§2.3.2、§3.2.2、§4.3、§6.2。

### 阶段检查

- [ ] 2.4 Host 核心链路检查
  - 状态：TODO
  - 这一步到底做什么：确认不依赖 Client 的情况下，Proxy 创建、外部运行、事件记录、中断、恢复和释放形成闭环。
  - 做完你能看到什么：一条 fake Host/Team/CLI 主链路可重复回放，失败只落在对应 binding。
  - 先依赖什么：2.1、2.2、2.3。
  - 开始前先看：`requirements.md`、`design.md` §2.3、§4、§6。
  - 主要改哪里：阶段 2 全部相关文件和集成 fixture。
  - 这一步先不做什么：不开始页面视觉调优，不宣称真实 DSH Web 面板已支持细节展示。
  - 怎么算完成：主链路和关键异常路径均有证据，禁止事项扫描无命中。
  - 怎么验证：Host 集成测试、类型检查、敏感字段扫描。
  - 对应需求：需求 2、3、4、5、6、7。
  - 对应设计：§2、§4、§5、§6。

## 阶段 3：DSH 消息投影和 Client 详情面板

- [ ] 3.1 接入 DSH 消息 projector 和生命周期事件
  - 状态：TODO
  - 这一步到底做什么：把可表达的外部文本、思考和工具结果投影到 Proxy Session，同时监听 Agent created/status/disposed。
  - 做完你能看到什么：官方 Team 会话入口能看到可读的外部摘要，且不重复触发工具执行。
  - 先依赖什么：2.4。
  - 开始前先看：`src/host/cli-adapters/dsh-message-projector.ts`、`src/host/native-session-bridge.ts`；`design.md` §2.3.2、§3.3.4。
  - 主要改哪里：`src/host/modules/agent-team/`、现有 projector/bridge 的 Team adapter 和测试。
  - 这一步先不做什么：不修改 DSH 原生历史 schema，不把外部权限/问题伪装成 DSH permission。
  - 怎么算完成：投影去重、只读工具历史、生命周期清理和失败回退测试通过。
  - 怎么验证：DSH fake session 集成测试、现有 native-session-bridge 回归测试。
  - 对应需求：需求 3、需求 4、需求 8。
  - 对应设计：§2.3.2、§3.1、§4.3。

- [ ] 3.2 实现外部详情 RPC 和脱敏 DTO
  - 状态：TODO
  - 这一步到底做什么：提供详情、事件窗口、权限、问题、恢复和中断 RPC，并按 memberSessionId 做作用域校验。
  - 做完你能看到什么：Client 能读取外部 Agent 详情，但拿不到 token、环境变量和完整命令行。
  - 先依赖什么：2.4。
  - 开始前先看：`requirements.md` 需求 4、5、7；`design.md` §3.2.3、§3.3.3、§5。
  - 主要改哪里：`src/host/rpc.ts`、`src/shared/contracts/agent-team.ts`、Host RPC 测试。
  - 这一步先不做什么：不开放任意 provider session 查询，不让 Client 直接调用外部 CLI。
  - 怎么算完成：作用域、分页、cursor、错误码和日志脱敏测试通过。
  - 怎么验证：RPC 单测、安全测试、敏感字段扫描。
  - 对应需求：需求 4、需求 5、需求 7。
  - 对应设计：§3.2.3、§3.3.3、§5。

- [ ] 3.3 增加插件外部 Agent 详情面板
  - 状态：TODO
  - 这一步到底做什么：在插件 UI 中展示 adapter、model、effort、状态、当前工具、权限、问题、usage、错误、事件时间线和操作按钮。
  - 做完你能看到什么：官方 Team 面板负责 roster/任务，插件面板负责外部执行详情；两者通过 memberSessionId 对齐。
  - 先依赖什么：3.2。
  - 开始前先看：`docs/开发规范/20260922-功能模块开发规则.md`、`design.md` §2.3.4、§3.2.3。
  - 主要改哪里：`src/client/features/agent-team.ts`、`src/client/agent-team-detail-panel.ts`、locale、Client 测试。
  - 这一步先不做什么：不重做 DSH 官方 Team 面板，不承诺官方面板显示外部工具时间线。
  - 怎么算完成：加载、增量刷新、权限/问题响应、中断、恢复、打开外部会话和空/错误状态均可用。
  - 怎么验证：Client 组件测试、人工 UI 走查、事件 cursor 回放。
  - 对应需求：需求 3、需求 4、需求 5、需求 6。
  - 对应设计：§2.3.4、§3.1、§3.3.3。

### 阶段检查

- [ ] 3.4 Web 展示边界检查
  - 状态：TODO
  - 这一步到底做什么：确认官方 Team 面板和插件详情面板的职责没有混淆，回答“方案 A 是否看得到外部操作详情”。
  - 做完你能看到什么：官方面板可见 Proxy 成员/任务；插件面板可见完整外部操作；两者导航不会串线。
  - 先依赖什么：3.1、3.2、3.3。
  - 开始前先看：调查文档 §4、`design.md` §2.3.4、§7.3。
  - 主要改哪里：Client/Host 相关文件和验收清单。
  - 这一步先不做什么：不向 DSH 官方 UI 注入未验证的私有组件，不修改官方 projection。
  - 怎么算完成：桌面和窄屏布局、空态、断线、无权限和详情事件均通过人工走查。
  - 怎么验证：Client 测试、浏览器人工走查；不启动开发服务器作为默认动作。
  - 对应需求：需求 3、需求 4、需求 7。
  - 对应设计：§2.3.4、§7.3。

## 阶段 4：兼容性、失败隔离和验收

- [ ] 4.1 完成三版本兼容和旧路径回归
  - 状态：TODO
  - 这一步到底做什么：验证 `0.1.5-rc.3`、`0.1.6-alpha.2`、`0.1.7-rc.2` 以及 Team Profile 开关组合下的行为。
  - 做完你能看到什么：只有受支持的 Team 环境启用集成，旧版本和关闭 Profile 保持现有 CLI 行为。
  - 先依赖什么：3.4；spec005 fixture。
  - 开始前先看：`requirements.md` 需求 1、8；`design.md` §7、§8。
  - 主要改哪里：能力 fixture、Feature 测试、manifest/version 检查、回归测试。
  - 这一步先不做什么：不扩大 DSH peer 范围，不把实验性能力标成稳定。
  - 怎么算完成：三版本能力诊断、旧 CLI 流程、Team 开关和 adapter 失败隔离均通过。
  - 怎么验证：`pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、定向 `pnpm test`。
  - 对应需求：需求 1、需求 6、需求 8。
  - 对应设计：§7.1、§7.2、§8。

- [ ] 4.2 完成安全、资源和并发验收
  - 状态：TODO
  - 这一步到底做什么：验证作用域、凭据脱敏、并发 run、背压、Host 关闭、Proxy dispose 和外部进程泄漏。
  - 做完你能看到什么：失败和重连场景不会泄露数据、重复执行或遗留进程。
  - 先依赖什么：4.1。
  - 开始前先看：`requirements.md` 非功能需求；`design.md` §4.3、§5、§6。
  - 主要改哪里：安全测试、资源清理测试、外部 driver fake、日志扫描脚本。
  - 这一步先不做什么：不引入跨进程锁、worktree 或新的调度系统。
  - 怎么算完成：关键属性测试、敏感字段扫描、资源释放和失败隔离测试通过。
  - 怎么验证：定向测试、`git diff --check`、`pnpm test`。
  - 对应需求：需求 5、需求 6、需求 7、非功能需求 1、2。
  - 对应设计：§4.3、§5、§6、§7。

- [ ] 4.3 最终检查点
  - 状态：TODO
  - 这一步到底做什么：确认需求、设计、实现、测试和已知限制逐项对上，决定是否可以交付。
  - 做完你能看到什么：能够明确回答“外部 Agent 是否原生出现在 Team”“官方面板能看到什么”“插件详情能看到什么”“哪些能力仍不支持”。
  - 先依赖什么：4.1、4.2。
  - 开始前先看：本 Spec 全部文件、相关调查报告、`AGENTS.md`。
  - 主要改哪里：`tasks.md`、验收文档、能力报告和必要的 README/索引。
  - 这一步先不做什么：不追加未评审的新需求，不修改 DSH Host。
  - 怎么算完成：所有实现任务有验证证据，BLOCKED/CANCELLED 项有原因，风险和后续工作已回写。
  - 怎么验证：按 Spec 验收清单逐项核对；完整验证命令见项目 `AGENTS.md`。
  - 对应需求：全部需求。
  - 对应设计：全文。
