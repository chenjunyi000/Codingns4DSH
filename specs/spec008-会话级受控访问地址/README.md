# spec008：会话级受控访问地址

状态：规划完成，待实施。实施任务全部为 `TODO`，本 Spec 只建立需求、设计与任务清单，不包含代码改动。

## 这份 Spec 解决什么问题

用户与外部工具需要「看一眼某个工作区会话在说什么」：把指定会话的消息内容交给另一个人、另一个客户端或另一个会话读取。但当前链路只有两种选择：

1. 把整个 DSH Web 暴露出去（启动令牌或局域网映射），对方随即拿到整机权限：所有会话读写、终端与工具执行。
2. 用 DSH 原生跨会话引用（`@[label](dsh-session:<id>)`），它把有界快照注入模型上下文，既没有地址也不能给外部客户端用。

中间缺的是**会话级、只读、可撤销、可设有效期的访问地址**。本 Spec 规定由插件在 Host 侧生成并托管这类地址：地址只指向一个 `workspaceId + sessionId`，只暴露消息读取，凭据与 DSH 整机 Cookie 隔离，撤销立即生效。

## 核心判断

值得做，且必须由插件实现，不能依赖上游。

- 上游直接提供会话分享地址：不可行，`0/10`。经调查（见 `docs/调查报告/20260929-DSH会话访问与控制能力调查.md`），上游认证最小粒度是进程级 operator Peer，`/api/session.export` 与 Remote 调用都以整机 Cookie 为前提，没有 per-session 授权、没有 logout、Cookie 不带 `Secure`。
- 插件侧实现会话级受控入口：可行性约 `8/10`。传输层与票据骨架（`lan-access-dsh`）、随机地址绑定范式（`debug.ts`）、Host 侧代取 DSH Web（`remote-web-runtime.ts`）都已存在，缺口集中在票据作用域扩展、只读输出契约与审计。
- 直接复用 PeerHost 读远端会话：不作为第一阶段主路径。PeerHost 当前 `disabled: true`，relay route `degrade`，且它的目标是跨 Host 聚合，不是单会话分享。
- 用 `dsh-session-reference` 代替：不满足需求。它没有地址、不可撤销、只服务模型上下文。

## 阅读顺序

1. `requirements.md`：用户故事、范围和可验收行为。
2. `design.md`：方案比较、模块边界、票据与输出契约、安全约束。
3. `docs/调查报告/20260929-DSH会话访问与控制能力调查.md`：上游接口与本仓库现状的调查证据。
4. `tasks.md`：按阶段执行的任务清单；每完成一个任务必须立即回写状态和验证证据。

## 当前范围

本 Spec 覆盖：

- 为指定 `workspaceId + sessionId` 生成、列出、撤销访问地址（不透明 shareId + 会话级票据）。
- 地址有效期、撤销、会话删除/归档后的失效语义。
- 只读、单会话的消息读取输出契约（分页/游标，稳定 JSON）。
- 受控入口：插件自有监听或路由前缀，不把 DSH 整机凭据交给外部。
- 会话内容数据源适配层（Host 侧代取，能力可探测、可降级）。
- 生成/访问/撤销的脱敏审计。
- 其他会话与外部客户端的消费路径说明（HTTP 为主）。
- 旧版本与能力缺失时的安全禁用与诊断。

明确不在本 Spec 内：

- 修改 DSH Host 源码、上游认证模型或 `dsh-client-connection` 行为。
- 把 DSH Web 整机入口（launch token、浏览器 Cookie）作为分享凭据分发。
- 双向能力：通过分享地址写消息、发消息、执行工具或中断会话。
- 任意文件读取：附件与 workspace 文件默认不通过分享地址开放。
- 公网部署方案（TLS 终结、反代、网关）；只定义插件侧契约与安全前提。
- PeerHost、跨 Host 聚合与 relay 可用性修复。

## 与现有 Spec 的关系

- 依赖 `spec005-DSH能力注册与版本路由机制` 提供能力矩阵、版本 route 与诊断门禁；新增会话内容读取能力必须按规范登记。
- 与 `spec006-PeerHost管理与多Host工作区会话聚合` 并列：PeerHost 处理「跨 Host 聚合」，本 Spec 处理「单会话受控外发」，不改变 PeerHost 的 `HostScope` 与代理边界。
- 复用 `spec002` 隧道与传输层打下的连接抽象，但第一阶段不要求跨网络转发，只在插件监听上提供受控入口。
- 复用现有 `lan-access-dsh` 的监听/票据骨架、`debug.ts` 的随机地址范式、`native-session-bridge` 与 `remote-web-runtime` 的会话读取通道。
- 不改变现有局域网访问、终端、文件管理等模块的行为。

## 关键设计结论

```text
生成方（DSH Web / 本机）
  └── sessionShare/create（插件 RPC）
        └── SessionShareService（Host-only）
              ├── SessionShareStore        票据与撤销状态
              ├── SessionContentSource     会话内容数据源（能力探测）
              └── SessionShareEndpoint     插件自有监听 / 路由前缀
                    └── GET /share/session/<shareId>?cursor=...
                          └── 只读 JSON：指定会话的消息窗口

消费方（其他会话 / 外部客户端）
  └── 持有链接即可读取；撤销、过期、会话删除后立即 401/410
```

约束一句话：**上游只认识「整机一把钥匙」，最小权限只能由插件的票据与代理层施加**；本 Spec 的所有安全要求都落在这一层。
