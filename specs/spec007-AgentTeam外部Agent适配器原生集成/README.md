# spec007：Agent Team 外部 Agent 适配器原生集成

状态：技术规划完成，待实施。

## 这份 Spec 解决什么问题

DSH `0.1.7-rc.2` 的实验性 Agent Team 已经提供原生成员、共享任务、消息投递、成员中断和 Team Web 面板。但插件现有的 Command Code、Claude Code、Kimi CLI、Gemini CLI、Pi Agent、Codex、OpenCode、Grok Build 等外部 Agent 仍然由插件自己的 CLI 会话体系管理，不能直接出现在 DSH Team roster 中。

用户需要同时得到两件事：

1. 在 DSH 原生 Team 面板中看到外部 Agent 对应的成员、状态、任务 Owner、依赖和 write scope。
2. 在插件面板中看到外部 Agent 的真实流、工具调用、权限、提问、用量、错误、会话恢复和中断详情。

本 Spec 规定只修改插件代码并通过 DSH 已有注入点接入，绝不修改 DSH Host 源码。核心方案是把外部 CLI 绑定到一个真实的 DSH Proxy Teammate，由 DSH 负责 Team 生命周期和原生状态，由插件负责外部执行和细节投影。

## 核心判断

值得做，但不能把外部 CLI 直接伪造成 DSH Agent。

- 直接成为真实 Team Agent：不可行性高，约 `2/10`。外部 CLI 没有 DSH Agent、Session lineage、inbox 和 continuation lifecycle。
- 原生 Proxy Teammate 方案：可行性约 `8/10`。Team roster、任务板、mailbox 和中断语义保留原生；外部 CLI 继续复用现有适配器和会话持久化。
- ACP one-shot 方案：只能作为后续实验，不作为第一阶段主路径。`dsh-subagent-acp@0.1.7-rc.2` 不提供可持续 Team 成员所需的 continuable 生命周期。

## 阅读顺序

1. `requirements.md`：用户故事、范围和可验收行为。
2. `design.md`：Proxy 架构、注入边界、数据模型、事件和 Web 展示。
3. `docs/20260928-DSH-0.1.7-RC2-AgentTeam与外部适配器调查.md`：官方包和当前插件代码的调查证据。
4. `docs/20260928-外部Agent代理成员技术规划.md`：方案比较、阶段门禁和上线前决策。
5. `tasks.md`：按阶段执行的任务清单；每完成一个任务必须立即回写状态和验证证据。

## 当前范围

本 Spec 覆盖：

- DSH `0.1.7-rc.2` Agent Team 能力探测、启停和降级。
- 通过插件工具创建和管理外部 Agent Proxy Teammate。
- 原生 Team roster、任务板、Owner、依赖、write scope 和会话导航关联。
- 外部 CLI 的流式文本、思考、工具、权限、问题、usage、错误、恢复和中断投影。
- Host-only 外部绑定、provider session id、事件序列和脱敏存储。
- 插件外部 Agent 详情面板，以及从 Proxy Session 打开外部原生会话。
- 外部 Agent 失败与 DSH Lead/其他 Team 成员隔离。
- 旧 DSH 版本和未启用 Team Profile 时的安全降级。

明确不在本 Spec 内：

- 修改 DSH Host、DSH Agent Team Service 私有字段或官方 Team 工具实现。
- 覆盖官方 `spawn_teammate`、`send_message`、`team_task_*` 名称。
- 让外部 CLI 获得未经适配的 DSH Team 工具或伪造 DSH Agent 身份。
- 跨进程 Team、worktree 隔离、文件锁和 exactly-once 任务调度。
- 把外部 CLI 的每个内部事件都强行写成 DSH 原生事件；无法表达的细节只进入插件投影。

## 与现有 Spec 的关系

- 依赖 `spec005-DSH能力注册与版本路由机制` 提供能力矩阵、版本路由和 Feature 门禁。
- 与 `spec006-PeerHost管理与多Host工作区会话聚合` 并列；本 Spec 不改变 PeerHost 的 HostScope 和代理边界。
- 复用现有 `CodingNsCliAdapterRegistry`、`CodingNsDshMessageProjector`、`CodingNsNativeSessionBridge` 和 CLI session store。
- 不改变当前非 Team 模式下的外部 Agent 会话行为。

## 关键设计结论

```text
Lead DSH Agent
  └── 原生 DSH Agent Team
        └── 真实 DSH Proxy Teammate
              └── external_agent_run
                    └── CodingNsCliAdapterRegistry
                          └── 外部 CLI 进程/协议
```

DSH 只知道 Proxy Teammate；插件知道 Proxy 与外部 Agent 的绑定关系。官方 Team 面板显示 Proxy 成员和原生任务状态，插件详情面板显示外部 Agent 的操作明细。这样既保留原生管理体验，也不假装 DSH 已经理解外部 CLI 的内部生命周期。
