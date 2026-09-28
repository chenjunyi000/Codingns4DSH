import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CodingNsAgentQuestion,
  CodingNsAgentQuestionResponse,
} from '../shared/contracts/cli-adapter.js'

/**
 * DSH Host 原生会话服务的最小运行时面。
 *
 * 这里故意不直接依赖 dsh-session 或 dsh-api-session-controller：插件的
 * package.json 只锁定 DSH 兼容版本，某些精简 Host 可能没有装载完整会话服务。
 * 运行时探测可以让这类 Host 继续使用 Codingns4DSH，而完整 DSH 则优先走原生 API。
 */
export interface CodingNsNativeSessionStore {
  get(sessionId: string): unknown
  list(): readonly unknown[]
  flush?(session: unknown): Promise<boolean> | Promise<void> | boolean | void
}

/** 公共 CLI 投影层写入 DSH 的工具调用，不包含任何 Provider 私有字段。 */
export interface CodingNsNativeToolCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
  /** 外部适配器 ID；旧调用方缺省时保持通用来源标记。 */
  readonly adapterId?: string
}

/** 一次工具调用在 DSH Session 中的稳定位置。 */
export interface CodingNsNativeToolCallHandle {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  readonly callId: string
  readonly callSeq: number
}

/** 公共 CLI 投影层写入 DSH 的工具结果。 */
export interface CodingNsNativeToolResult {
  readonly output: string
  readonly isError: boolean
  readonly error?: string
  readonly meta?: unknown
}

/** 外部 Agent 工具在 DSH Session 中的只读时间线标记。 */
export interface CodingNsNativeExternalToolEvent {
  readonly phase: 'start' | 'update'
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly output?: string
  readonly error?: string
  readonly adapterId?: string
}

export type CodingNsNativeApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 公共消息投影层交给 DSH 原生权限服务的请求。 */
export interface CodingNsNativeApprovalRequest {
  readonly requestId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** 公共消息投影层交给 DSH 原生问题服务的请求。 */
export interface CodingNsNativeQuestionRequest {
  readonly requestId: string
  readonly questions: readonly CodingNsAgentQuestion[]
  readonly signal?: AbortSignal
}

/** 外部 Agent 已确认的模型路由上下文容量，用于 DSH token-meter 的上下文占用投影。 */
export interface CodingNsNativeRequestContext {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
  /** Provider usage 明确确认的容量；路由占位上下文不应覆盖它。 */
  readonly confirmed?: boolean
  /** 容量来源；catalog 只用于首个 usage 前的已知模型提示，不锁定后续 Provider usage。 */
  readonly source?: 'provider' | 'catalog'
}

/** 外部 Provider 已报告的用量采样；写入 assistant/attempt，不加入模型可见 surface。 */
export interface CodingNsNativeUsageSample {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly uncachedInputTokens?: number
  readonly totalTokens?: number
  readonly cacheHitRate?: number
  readonly contextWindow?: number
  readonly contextTokens?: number
  readonly contextUsageRatio?: number
}

export interface CodingNsNativeSessionController {
  create?(request: { readonly sessionId?: string; readonly cwd?: string }): Promise<{ readonly sessionId: string }>
  list?(request?: unknown, signal?: AbortSignal): Promise<{ readonly items: readonly unknown[] }>
}

/** DSH 工作区控制器负责改变原生侧栏中的会话可见性。 */
export interface CodingNsNativeWorkspaceController {
  archiveSession?(request: { readonly sessionId: string }): Promise<unknown> | unknown
  unarchiveSession?(request: { readonly sessionId: string }): Promise<unknown> | unknown
}

export interface CodingNsNativeSessionBridge {
  readonly available: boolean
  /** 当前 Host 是否提供可接收 Session 事件的事件总线。 */
  readonly supportsEvents: boolean
  readonly store: CodingNsNativeSessionStore | undefined
  readonly controller: CodingNsNativeSessionController | undefined
  readonly workspaceController?: CodingNsNativeWorkspaceController
  /** 获取已经进入 DSH 原生 SessionStore 的会话。 */
  get(sessionId: string): unknown | undefined
  /** 获取当前 Host 已装载的原生会话；失败时返回空数组。 */
  list(): readonly unknown[]
  /** 调用 DSH 原生 session/list；无 Controller 时回退到本地 SessionStore。 */
  listRemote(signal?: AbortSignal): Promise<readonly unknown[]>
  /** 创建或采用一个 DSH 原生会话。 */
  ensure(sessionId: string, cwd?: string): Promise<string | null>
  /** 等待 DSH 原生持久化监听器完成当前会话的检查点。 */
  flush(sessionId: string): Promise<void>
  /**
   * 只追加已由外部 Agent 执行的工具历史，不经过 DSH Agent Loop。
   * 返回 null 表示会话或活动 step 不可用，调用方应安静降级。
   */
  appendToolCall?(sessionId: string, call: CodingNsNativeToolCall): CodingNsNativeToolCallHandle | null
  /** 追加与 appendToolCall 配对的只读结果；不会再次执行工具。 */
  appendToolResult?(handle: CodingNsNativeToolCallHandle, result: CodingNsNativeToolResult): boolean
  /** 兼容旧调用方；内部仍转换为 DSH 原生 tool/call 与 tool/result。 */
  appendExternalToolEvent?(sessionId: string, event: CodingNsNativeExternalToolEvent): boolean
  /** 写入当前原生步骤的路由上下文元数据，不携带凭据或消息正文。 */
  appendRequestContext?(sessionId: string, context: CodingNsNativeRequestContext): boolean
  /** 在当前步骤即时记录外部 Provider 用量；该事件不进入模型可见 surface。 */
  appendUsageSample?(sessionId: string, usage: CodingNsNativeUsageSample): boolean
  /** 判断指定会话是否真的具备下一步注入能力。 */
  canInjectNextStep?(sessionId: string): boolean
  /** 在当前 Agent turn 的下一个合法 step 注入插件上下文，不唤醒空闲 Agent。 */
  injectNextStep?(sessionId: string, summary?: string): boolean
  /** 使用 DSH 原生 approval 组件请求一次权限决定；服务不可用时拒绝。 */
  requestApproval?(sessionId: string, request: CodingNsNativeApprovalRequest): Promise<CodingNsNativeApprovalOutcome>
  /** 使用 DSH 原生 userQuestions 组件提问；服务不可用或取消时返回 null。 */
  askQuestions?(sessionId: string, request: CodingNsNativeQuestionRequest): Promise<CodingNsAgentQuestionResponse | null>
  /** 从 DSH 原生侧栏归档会话；控制器不可用时返回 false。 */
  archive?(sessionId: string): Promise<boolean>
  /** 恢复 DSH 原生侧栏中的归档会话；控制器不可用时返回 false。 */
  unarchive?(sessionId: string): Promise<boolean>
  /** 订阅 DSH 的原生事件流；返回值用于在功能停用时移除监听器。 */
  subscribe(handlers: {
    readonly onEvent?: (session: unknown, event: unknown) => void
    readonly onFlush?: (session: unknown) => void | Promise<void>
  }): () => void
}

export function createCodingNsNativeSessionBridge(ctx: Context, dshVersion?: string): CodingNsNativeSessionBridge {
  // Cordis Context 是运行时代理，直接读取未在 inject 中声明的可选服务会抛错。
  // get() 专门用于无强制依赖的服务探测，精简 Host 缺少服务时会返回 undefined。
  const storeValue: unknown = ctx.get('sessions')
  const controllerValue: unknown = ctx.get('sessionController')
  const workspaceControllerValue: unknown = ctx.get('workspaceController')
  const store = isSessionStore(storeValue) ? storeValue : undefined
  const controller = isSessionController(controllerValue) ? controllerValue : undefined
  const workspaceController = isWorkspaceController(workspaceControllerValue) ? workspaceControllerValue : undefined
  const currentWorkspaceController = (): CodingNsNativeWorkspaceController | undefined => {
    const value: unknown = ctx.get('workspaceController')
    return isWorkspaceController(value) ? value : undefined
  }
  const on = typeof (ctx as unknown as { on?: unknown }).on === 'function'
    ? (ctx as unknown as { on(name: string, listener: (...args: unknown[]) => unknown): () => unknown }).on.bind(ctx)
    : undefined
  const externalHandles = new Map<string, CodingNsNativeToolCallHandle>()
  const confirmedContextWindows = new Map<string, number>()
  // Agent.inject() 只是把消息放进队列，新的 DSH step 会在稍后的事件循环中
  // 才创建。此期间 activeStep 仍然指向旧 step，工具追加必须暂缓，否则会把
  // 下一步的工具写进旧 step；step/start 到达后由工具投影器重试。
  const pendingStepTransitions = new Set<string>()
  let injectedStepSequence = 0
  const modernInjectedSource = isModernDshVersion(dshVersion)
  const appendNativeToolCall = (sessionId: string, call: CodingNsNativeToolCall): CodingNsNativeToolCallHandle | null => {
    if (on !== undefined && pendingStepTransitions.has(sessionId)) return null
    const session = appendableSession(store?.get(sessionId))
    const position = session === null ? null : activeStep(session)
    if (session === null || position === null) return null
    // DSH 的工具生命周期由 assistant/message 先声明，再由 tool/call 开始。
    // 外部 Agent 已经在自身进程执行完请求，这条消息只用于持久化声明，绝不触发 DSH 执行器。
    session.append('assistant/message', {
      turn: position.turn,
      step: position.step,
      message: {
        id: `external-tool-${call.callId}-${position.turn}-${position.step}`,
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: call.callId,
          name: call.name,
          arguments: call.arguments,
        }],
        source: {
          kind: 'model',
          plugin: 'codingns4dsh',
          provider: call.adapterId?.trim() || 'codingns-external',
          model: call.adapterId?.trim() || 'external-agent',
        },
      },
      stream: [],
    }, { surfaceOp: 'append' })
    const event = session.append('tool/call', {
      turn: position.turn,
      step: position.step,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
    })
    const callSeq = eventSeq(event)
    return callSeq === null ? null : { sessionId, ...position, callId: call.callId, callSeq }
  }
  const appendNativeToolResult = (handle: CodingNsNativeToolCallHandle, result: CodingNsNativeToolResult): boolean => {
    const session = appendableSession(store?.get(handle.sessionId))
    if (session === null) return false
    const error = result.error?.trim()
    session.append('tool/result', {
      turn: handle.turn,
      step: handle.step,
      message: {
        id: `${handle.callId}-result-${handle.turn}-${handle.step}`,
        role: 'tool',
        toolCallId: handle.callId,
        content: [{ type: 'text', text: result.output }],
        source: { kind: 'tool', callId: handle.callId },
        ...(result.isError ? { isError: true } : {}),
      },
      ...(result.isError
        ? { error: { name: 'ExternalToolError', code: 'EXTERNAL_TOOL_FAILED', ...(error ? { reason: error } : {}) } }
        : {}),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
    }, {
      surfaceOp: 'append',
      sourceEventSeqs: [handle.callSeq],
    })
    return true
  }
  const appendNativeRequestContext = (sessionId: string, context: CodingNsNativeRequestContext): boolean => {
    const session = appendableSession(store?.get(sessionId))
    if (session === null || context.provider.trim() === '' || context.model.trim() === '') return false
    try {
      // request/context 是 token-meter 的容量来源。相同路由重复追加会让
      // 投影先清空旧 pressure，再等待下一条 usage，ContextMeter 因而闪烁。
      // 保留已有容量并跳过等价事件，让用量更新直接落到同一个组件上。
      const previous = latestRequestContext(session)
      const contextKey = `${sessionId}\u0000${context.provider}\u0000${context.model}`
      if (previous !== null && previous.provider === context.provider && previous.model === context.model) {
        const historicalWindow = historicalUsageContextWindow(session)
        if (context.contextWindow === undefined) {
          if (historicalWindow !== undefined && previous.contextWindow !== historicalWindow) {
            session.append('request/context', {
              provider: context.provider,
              model: context.model,
              contextWindow: historicalWindow,
            })
          }
          return true
        }
        if (previous.contextWindow === context.contextWindow
          && context.confirmed === true
          && historicalWindow !== undefined
          && historicalWindow !== context.contextWindow) {
          session.append('request/context', {
            provider: context.provider,
            model: context.model,
            contextWindow: historicalWindow,
          })
          confirmedContextWindows.set(contextKey, historicalWindow)
          return true
        }
        if (previous.contextWindow === context.contextWindow) {
          if (context.confirmed === true && context.source !== 'catalog' && context.contextWindow !== undefined) {
            confirmedContextWindows.set(contextKey, context.contextWindow)
          }
          return true
        }
        // 已经确认过的同一路由容量是会话级事实。迟到/全局 usage 不能覆盖它。
        // DSH 每个新 step 会先写入一次通用 1M 占位值。catalog 提示必须能把
        // 这个占位值恢复为已知容量，但真实 Provider usage 仍由锁定值保护。
        if (confirmedContextWindows.has(contextKey) && context.source !== 'catalog') return true
        // 进程重启后仍可从历史 usage 恢复稳定容量，避免尾部遗留的错误
        // request/context=1M 在第二轮开始时再次成为当前窗口。
        if (context.confirmed === true && historicalWindow !== undefined && historicalWindow !== context.contextWindow) {
          if (previous.contextWindow !== historicalWindow) {
            session.append('request/context', {
              provider: context.provider,
              model: context.model,
              contextWindow: historicalWindow,
            })
          }
          confirmedContextWindows.set(contextKey, historicalWindow)
          return true
        }
        // 允许本次运行首次明确确认的 usage 修正历史遗留的路由占位值，
        // 例如旧日志中的 1M 随后被 Codex usage 明确纠正为 258400。
        if (context.confirmed !== true) return true
      }
      // Registry 在一轮开始时只能提供适配器身份，不能提供 Provider 容量。
      // 继承上一条已知容量，避免先写无容量事件导致 ContextMeter 卸载；
      // 真正的 usage 到达后，投影器会用 Provider 的最新容量覆盖它。
      const contextWindow = context.contextWindow ?? previous?.contextWindow
      session.append('request/context', {
        provider: context.provider,
        model: context.model,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      })
      if (context.confirmed === true && context.source !== 'catalog' && context.contextWindow !== undefined) {
        confirmedContextWindows.set(contextKey, context.contextWindow)
      }
      return true
    } catch {
      return false
    }
  }
  const appendNativeUsageSample = (sessionId: string, usage: CodingNsNativeUsageSample): boolean => {
    const session = appendableSession(store?.get(sessionId))
    const position = session === null ? null : activeStep(session)
    if (session === null || position === null) return false
    try {
      const previousContext = latestRequestContext(session)
      const normalizedUsage = previousContext?.contextWindow !== undefined
        && usage.contextWindow !== undefined
        && usage.contextWindow !== previousContext.contextWindow
        ? {
            ...usage,
            contextWindow: previousContext.contextWindow,
            ...(usage.contextTokens === undefined ? {} : {
              contextUsageRatio: Number(Math.min(1, usage.contextTokens / previousContext.contextWindow).toFixed(6)),
            }),
          }
        : usage
      session.append('assistant/attempt', {
        turn: position.turn,
        step: position.step,
        stream: [{
          type: 'chunk',
          time: Date.now(),
          chunk: {
            type: 'usage',
          usage: compactUsage(normalizedUsage),
          },
        }],
      })
      return true
    } catch {
      return false
    }
  }
  const injectNativeNextStep = (sessionId: string, summary = '外部工具已完成，继续处理当前任务。'): boolean => {
    const agent = nativeAgent(ctx, sessionId)
    if (agent === null || typeof (agent as { inject?: unknown }).inject !== 'function') return false
    injectedStepSequence += 1
    const boundedSummary = summary.trim().slice(0, 120) || '外部工具已完成，继续处理当前任务。'
    try {
      if (on !== undefined) pendingStepTransitions.add(sessionId)
      ;(agent as { inject(message: unknown): void }).inject({
        id: `codingns-external-step-${injectedStepSequence}-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: boundedSummary }],
        source: modernInjectedSource
          ? { kind: 'model-selection', form: 'notice', summary: boundedSummary }
          : { kind: 'plugin', plugin: 'codingns4dsh', form: 'notice', summary: boundedSummary },
      })
      return true
    } catch {
      pendingStepTransitions.delete(sessionId)
      return false
    }
  }
  const canInjectNativeNextStep = (sessionId: string): boolean => {
    const agent = nativeAgent(ctx, sessionId)
    return agent !== null && typeof (agent as { inject?: unknown }).inject === 'function'
  }

  return {
    get available() {
      return store !== undefined || controller !== undefined || currentWorkspaceController() !== undefined
    },
    supportsEvents: on !== undefined,
    store,
    controller,
    ...(workspaceController === undefined ? {} : { workspaceController }),
    get(sessionId) {
      return store?.get(sessionId)
    },
    list() {
      try { return store?.list() ?? [] } catch { return [] }
    },
    async listRemote(signal) {
      if (controller?.list !== undefined) {
        try { return (await controller.list({}, signal)).items } catch { return [] }
      }
      return this.list()
    },
    async ensure(sessionId, cwd) {
      if (sessionId.trim() === '') return null
      if (store?.get(sessionId) !== undefined) return sessionId
      if (controller?.create !== undefined) {
        const created = await controller.create({ sessionId, ...(cwd ? { cwd } : {}) })
        return typeof created.sessionId === 'string' && created.sessionId.trim() ? created.sessionId : sessionId
      }
      // 不调用裸 SessionStore.create()：它把会话绑定到插件 Fiber，停用插件
      // 时会被移除，无法满足长期会话和原生侧栏持久化要求。
      return null
    },
    async flush(sessionId) {
      const session = store?.get(sessionId)
      if (session === undefined || store?.flush === undefined) return
      await store.flush(session)
    },
    appendToolCall(sessionId, call) {
      return appendNativeToolCall(sessionId, call)
    },
    appendToolResult(handle, result) {
      return appendNativeToolResult(handle, result)
    },
    appendRequestContext(sessionId, context) {
      return appendNativeRequestContext(sessionId, context)
    },
    appendUsageSample(sessionId, usage) {
      return appendNativeUsageSample(sessionId, usage)
    },
    canInjectNextStep(sessionId) {
      return canInjectNativeNextStep(sessionId)
    },
    injectNextStep(sessionId, summary) {
      return injectNativeNextStep(sessionId, summary)
    },
    appendExternalToolEvent(sessionId, externalTool) {
      try {
        // 兼容旧调用方；声明 assistant 工具生命周期，但绝不伪造 assistant/attempt 结算。
        const key = `${sessionId}:${externalTool.callId}`
        if (externalTool.phase === 'start') {
          if (externalHandles.has(key)) return true
          const handle = appendNativeToolCall(sessionId, {
            callId: externalTool.callId,
            name: externalTool.name,
            arguments: externalTool.arguments,
            ...(externalTool.adapterId === undefined ? {} : { adapterId: externalTool.adapterId }),
          })
          if (handle === null) return false
          externalHandles.set(key, handle)
          return true
        }
        const handle = externalHandles.get(key)
        if (handle === undefined) return false
        if (externalTool.status === 'running') return true
        const result = appendNativeToolResult(handle, {
          output: externalTool.output ?? externalTool.error ?? '',
          isError: externalTool.status === 'failed',
          ...(externalTool.error ? { error: externalTool.error } : {}),
        })
        if (result) externalHandles.delete(key)
        return result
      } catch {
        return false
      }
    },
    async requestApproval(sessionId, request) {
      const agent = nativeAgent(ctx, sessionId)
      const approval = nativeApproval(ctx)
      if (agent === null || approval === null) return 'unavailable'
      try {
        const outcome = await approval.request({
          agent,
          toolName: request.toolName,
          ...(request.callId ? { callId: request.callId } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        return isApprovalOutcome(outcome) ? outcome : 'unavailable'
      } catch {
        return request.signal?.aborted ? 'cancelled' : 'unavailable'
      }
    },
    async askQuestions(sessionId, request) {
      const agent = nativeAgent(ctx, sessionId)
      const userQuestions = nativeUserQuestions(ctx)
      if (agent === null || userQuestions === null) return null
      try {
        const answer = await userQuestions.ask({
          agent,
          questions: request.questions,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        if (!isQuestionAnswer(answer)) return null
        return { requestId: request.requestId, answers: answer.answers }
      } catch {
        return null
      }
    },
    async archive(sessionId) {
      const current = currentWorkspaceController()
      if (sessionId.trim() === '' || current?.archiveSession === undefined) return false
      await current.archiveSession({ sessionId })
      return true
    },
    async unarchive(sessionId) {
      const current = currentWorkspaceController()
      if (sessionId.trim() === '' || current?.unarchiveSession === undefined) return false
      await current.unarchiveSession({ sessionId })
      return true
    },
    subscribe(handlers) {
      const disposers: Array<() => unknown> = []
      if (on !== undefined && handlers.onEvent !== undefined) {
        disposers.push(on('session/event', (session: unknown, event: unknown) => {
          if (isNativeStepStart(event)) {
            for (const sessionId of pendingStepTransitions) {
              if (store?.get(sessionId) === session) pendingStepTransitions.delete(sessionId)
            }
          }
          handlers.onEvent?.(session, event)
        }))
      }
      if (on !== undefined && handlers.onFlush !== undefined) {
        disposers.push(on('session/flush', (session: unknown) => handlers.onFlush?.(session)))
      }
      return () => { for (const dispose of disposers) dispose() }
    },
  }
}

interface AppendableSession {
  snapshotEvents(): readonly unknown[]
  append(type: string, data: unknown, options?: unknown): unknown
}

interface RequestContextSnapshot {
  readonly provider: string
  readonly model: string
  readonly contextWindow?: number
}

interface NativeAgentRegistry {
  get(sessionId: string): unknown
}

interface NativeApprovalService {
  request(request: Record<string, unknown>): Promise<unknown>
}

interface NativeUserQuestionService {
  ask(request: Record<string, unknown>): Promise<unknown>
}

function appendableSession(value: unknown): AppendableSession | null {
  if (!isRecord(value)) return null
  if (typeof value.snapshotEvents !== 'function' || typeof value.append !== 'function') return null
  return value as unknown as AppendableSession
}

function isNativeStepStart(value: unknown): boolean {
  return isRecord(value) && value.type === 'step/start'
}

function latestRequestContext(session: AppendableSession): RequestContextSnapshot | null {
  let events: readonly unknown[]
  try { events = session.snapshotEvents() } catch { return null }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]
    const event: Record<string, unknown> | null = isRecord(candidate) ? candidate : null
    if (event?.type !== 'request/context') continue
    const data = isRecord(event.data) ? event.data : null
    if (typeof data?.provider !== 'string' || typeof data.model !== 'string') return null
    return {
      provider: data.provider,
      model: data.model,
      ...(typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow) && data.contextWindow > 0
        ? { contextWindow: data.contextWindow }
        : {}),
    }
  }
  return null
}

function historicalUsageContextWindow(session: AppendableSession): number | undefined {
  let events: readonly unknown[]
  try { events = session.snapshotEvents() } catch { return undefined }
  const counts = new Map<number, number>()
  for (const candidate of events) {
    const event = isRecord(candidate) && candidate.type === 'assistant/attempt' ? candidate : null
    const data = isRecord(event?.data) ? event.data : null
    const stream = Array.isArray(data?.stream) ? data.stream : []
    for (const entry of stream) {
      const chunk = isRecord(entry) && isRecord(entry.chunk) ? entry.chunk : null
      const usage = isRecord(chunk?.usage) ? chunk.usage : null
      const window = usage?.contextWindow
      if (typeof window === 'number' && Number.isFinite(window) && window > 0) counts.set(window, (counts.get(window) ?? 0) + 1)
    }
  }
  let selected: number | undefined
  let count = 0
  for (const [window, occurrences] of counts) {
    if (occurrences >= count) {
      selected = window
      count = occurrences
    }
  }
  return selected
}

function activeStep(session: AppendableSession): { turn: number; step: number } | null {
  let events: readonly unknown[]
  try { events = session.snapshotEvents() } catch { return null }
  const closed = new Set<string>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]
    const event: Record<string, unknown> | null = isRecord(candidate) ? candidate : null
    const data = isRecord(event?.data) ? event.data : null
    const turn = finiteInteger(data?.turn)
    const step = finiteInteger(data?.step)
    if (turn === null || step === null) continue
    const key = `${turn}:${step}`
    if (event?.type === 'step/end') closed.add(key)
    if (event?.type === 'step/start' && !closed.has(key)) return { turn, step }
  }
  return null
}

function eventSeq(value: unknown): number | null {
  return isRecord(value) ? finiteInteger(value.seq) : null
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function compactUsage(usage: CodingNsNativeUsageSample): Record<string, number> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.uncachedInputTokens === undefined ? {} : { uncachedInputTokens: usage.uncachedInputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheHitRate === undefined ? {} : { cacheHitRate: usage.cacheHitRate }),
    ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
    ...(usage.contextTokens === undefined ? {} : { contextTokens: usage.contextTokens }),
    ...(usage.contextUsageRatio === undefined ? {} : { contextUsageRatio: usage.contextUsageRatio }),
  }
}

function isSessionStore(value: unknown): value is CodingNsNativeSessionStore {
  return isRecord(value) && typeof value.get === 'function' && typeof value.list === 'function'
}

function isSessionController(value: unknown): value is CodingNsNativeSessionController {
  return isRecord(value) && (typeof value.create === 'function' || typeof value.list === 'function')
}

function isWorkspaceController(value: unknown): value is CodingNsNativeWorkspaceController {
  return isRecord(value) && (typeof value.archiveSession === 'function' || typeof value.unarchiveSession === 'function')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isModernDshVersion(value: string | undefined): boolean {
  if (value === undefined) return false
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value.trim())
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major > 0 || minor > 1 || minor === 1 && patch >= 7
}

function nativeAgent(ctx: Context, sessionId: string): unknown | null {
  const value: unknown = ctx.get('agents')
  if (!isRecord(value) || typeof value.get !== 'function') return null
  try { return (value as unknown as NativeAgentRegistry).get(sessionId) ?? null } catch { return null }
}

function nativeApproval(ctx: Context): NativeApprovalService | null {
  const value: unknown = ctx.get('approval')
  return isRecord(value) && typeof value.request === 'function' ? value as unknown as NativeApprovalService : null
}

function nativeUserQuestions(ctx: Context): NativeUserQuestionService | null {
  const value: unknown = ctx.get('userQuestions')
  return isRecord(value) && typeof value.ask === 'function' ? value as unknown as NativeUserQuestionService : null
}

function isApprovalOutcome(value: unknown): value is CodingNsNativeApprovalOutcome {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}

function isQuestionAnswer(value: unknown): value is Omit<CodingNsAgentQuestionResponse, 'requestId'> {
  if (!isRecord(value) || !Array.isArray(value.answers)) return false
  return value.answers.every((answer) => isRecord(answer)
    && typeof answer.id === 'string'
    && Array.isArray(answer.selected)
    && answer.selected.every((item) => typeof item === 'string')
    && (answer.custom === undefined || typeof answer.custom === 'string'))
}
