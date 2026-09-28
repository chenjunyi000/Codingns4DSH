import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CodingNsAgentEvent, CodingNsAgentQuestionResponse, CodingNsCliModelCatalog, CodingNsAgentPermissionResponse, CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { JsonRpcProcess, type JsonRpcMessage } from './json-rpc-process.js'
import { detectBinary, emptyCatalog, isRecord, textValue, usageChunk } from './rpc-driver-utils.js'
import { CODEX_CATALOG, isProviderDefaultModel } from './model-catalog.js'
import { probeStoredSession, readFirstJsonRecord } from './session-probe.js'
import { firstToolText, normalizeToolStatus, serializeToolValue } from './tool-observation.js'
import { isQuestionEvent, questionAnswersRecord, readAgentQuestions } from './interaction-events.js'

export interface CodexAppServerDriverOptions {
  readonly binaries?: readonly string[]
  readonly sessionRoots?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

interface CodexSegmentedTurn {
  readonly queue: CodexTurnEventQueue
  removeNotificationListener: () => void
  removeAbortListener: () => void
  terminalReason: 'stop' | 'cancel' | 'error' | null
  done: boolean
  pendingChunk: CodingNsAgentEvent | undefined
  currentAssistantMessageId: string | undefined
  sawCompletedTool: boolean
}

interface CodexTurnEventQueue {
  readonly iterable: AsyncIterable<JsonRpcMessage>
  next(): Promise<IteratorResult<JsonRpcMessage>>
  push(message: JsonRpcMessage): void
  close(): void
}

interface CodexSession {
  readonly rpc: JsonRpcProcess
  readonly cwd: string | undefined
  modelId: string | undefined
  contextWindow: number | undefined
  threadId: string
  turnId: string | null
  providerSessionId: string
  readonly pendingPermissions: Map<string, PendingCodexPermission>
  readonly pendingQuestions: Map<string, (value: unknown) => void>
  segmentedTurn: CodexSegmentedTurn | undefined
}

interface PendingCodexPermission {
  readonly resolve: (value: unknown) => void
  readonly response: 'legacy' | 'command' | 'file-change'
}

/** Codex app-server 的 JSON-RPC 驱动，Host 只暴露统一文本流，不暴露线程和 token。 */
export class CodexAppServerDriver implements CodingNsCliDriver {
  readonly descriptor = { id: 'codex', name: 'Codex', protocol: 'json-rpc', capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage', 'permission', 'questions', 'steer'] as const } as const
  // Codex 一个 Provider turn 可能同时包含多个工具调用。只有 assistant item
  // 切换后才分段，不能在每个工具完成后注入下一 step。
  readonly supportsSegmentedTurns = true
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private readonly sessionRoots: readonly string[]
  private cachedBinary: string | null = null
  private readonly processes = new Set<JsonRpcProcess>()
  private readonly sessions = new Map<string, CodexSession>()

  constructor(options: CodexAppServerDriverOptions = {}) {
    this.binaries = options.binaries ?? ['codex']
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.sessionRoots = options.sessionRoots ?? [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    const result = await detectBinary({ binaries: this.binaries, spawnSync: this.runSpawnSync })
    if (result.installed) this.cachedBinary = result.command
    return result
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) return emptyCatalog()
    const rpc = new JsonRpcProcess({ command, args: ['app-server'], spawn: this.runSpawn })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'codingns4dsh', version: '0.1.1' },
        capabilities: {},
      }, { signal: controller.signal })
      rpc.notify('initialized', {})
      // config/read 让 Codex 完成一次配置加载；model/list 才返回带 effort 元数据的目录。
      await rpc.request('config/read', {}, { signal: controller.signal })
      const response = await rpc.request('model/list', {}, { signal: controller.signal })
      const catalog = parseCodexCatalog(response)
      return catalog.groups.length > 0 ? catalog : CODEX_CATALOG
    } catch {
      return CODEX_CATALOG
    } finally {
      clearTimeout(timer)
      rpc.dispose()
    }
  }

  async probeSession(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return probeStoredSession(input, {
      roots: this.sessionRoots,
      matches: (path, entry, id) => entry.isFile() && basename(path).endsWith(`${id}.jsonl`),
      validate: async (path, id) => {
        const record = await readFirstJsonRecord(path)
        return isRecord(record?.payload) && record.payload.id === id
      },
    })
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const command = this.cachedBinary ?? (await this.detect()).command
    if (command === null) throw new Error('Codex 未安装')
    if (input.splitToolSteps && this.supportsSegmentedTurns) {
      yield* this.executeSegmentedTurn(input, command)
      return
    }
    const session = await this.getSession(input, command)
    prepareCodexSession(session, input)
    const rpc = session.rpc
    try {
      if (session.threadId === '') {
        const thread = input.providerSessionId
          ? await rpc.request('thread/resume', { threadId: input.providerSessionId, cwd: input.cwd ?? process.cwd(), ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}) }, { signal: input.signal, killOnAbort: false })
          : await rpc.request('thread/start', { cwd: input.cwd ?? process.cwd(), ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}) }, { signal: input.signal, killOnAbort: false })
        session.threadId = readId(thread) ?? input.providerSessionId ?? input.sessionId
        session.providerSessionId = session.threadId
      }
      yield { type: 'session-binding', providerSessionId: session.providerSessionId }
      const eventQueue = createCodexTurnEventQueue()
      let activeTurnId: string | null = null
      let turnStartResolved = false
      const notificationsBeforeTurnStart: JsonRpcMessage[] = []
      let terminalReason: 'stop' | 'cancel' | 'error' | null = null
      let sawMeaningfulEvent = false
      const acceptNotification = (message: JsonRpcMessage, allowUnidentifiedTool: boolean): void => {
        if (!isCodexNotificationForTurn(message, session.threadId, activeTurnId, allowUnidentifiedTool)) return
        const turnId = readTurnId(message)
        if (turnId !== null) {
          activeTurnId = turnId
          session.turnId = turnId
        }
        eventQueue.push(message)
        const reason = readCodexTerminalReason(message)
        if (reason !== null) {
          terminalReason = reason
          eventQueue.close()
        }
      }
      const onNotification = (message: JsonRpcMessage): void => {
        // thread/resume 后，Codex 可能把旧回合的 item 通知迟到到达，并且
        // 与本次 turn/start 的响应交错。响应返回前不能把这些通知当成当前回合，
        // 否则旧工具历史会在流式界面被追加到当前消息末尾。
        if (!turnStartResolved) {
          notificationsBeforeTurnStart.push(message)
          return
        }
        acceptNotification(message, true)
      }
      // 与父仓库 CodexRuntimeAdapter 一致：监听器必须先于 turn/start 注册，
      // 否则响应前到达的 turn/started 或文本通知也会丢失。
      const removeNotificationListener = rpc.addNotificationListener(onNotification)
      const onAbort = (): void => {
        terminalReason = 'cancel'
        eventQueue.close()
      }
      if (input.signal?.aborted) onAbort()
      else input.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await rpc.request('turn/start', codexTurnStartParams(input, session.threadId), { signal: input.signal, killOnAbort: false })
        const responseTurnId = readTurnId(response)
        if (responseTurnId !== null) {
          activeTurnId = responseTurnId
          session.turnId = responseTurnId
        }
        turnStartResolved = true
        // 响应前缓存的通知可能来自 thread/resume 的旧历史。没有 turnId 的工具
        // 事件无法证明属于本次回合，因此只能丢弃；有明确 turnId 的事件仍按
        // 原有规则处理。
        for (const message of notificationsBeforeTurnStart.splice(0)) acceptNotification(message, false)
        // 某些 app-server 会直接在 turn/start 响应中返回终态。父仓库把它
        // 归一化成 turn/completed，这里复用同一规则，避免永久等待通知。
        const responseTerminal = buildCodexCompletionNotification(response, session.threadId)
        if (responseTerminal !== null) onNotification(responseTerminal)

        for await (const message of eventQueue.iterable) {
          const rawChunk = codexMessageToChunk(message)
          if (rawChunk === null) continue
          if (rawChunk.type !== 'finish') sawMeaningfulEvent = true
          const chunk = stabilizeCodexUsage(session, rawChunk)
          yield chunk
        }
        if (input.signal?.aborted) await this.interrupt(input.sessionId)
      } catch (error) {
        if (!input.signal?.aborted) throw error
        await this.interrupt(input.sessionId)
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
        removeNotificationListener()
        eventQueue.close()
      }
      if (!input.signal?.aborted && terminalReason !== 'cancel' && !sawMeaningfulEvent) {
        yield { type: 'text-delta', text: 'CODINGNS_PROVIDER_EMPTY_RESPONSE: Codex Provider 未返回任何有效事件。' }
        yield { type: 'finish', reason: 'error' }
      } else {
        yield { type: 'finish', reason: input.signal?.aborted ? 'cancel' : terminalReason ?? 'stop' }
      }
    } finally { /* app-server 在会话结束前保持连接。 */ }
  }

  /**
   * 将一个 Codex turn 按 assistant item 切成多个 DSH step。
   *
   * DSH 的 step 边界只能由 Agent Loop 提交；这里仅提前结束本次 llm/stream，
   * 保留同一个 Codex turn 的通知队列，下一次 llm/stream 再继续消费它。
   */
  private async *executeSegmentedTurn(input: CodingNsCliTurnInput, command: string): AsyncIterable<CodingNsAgentEvent> {
    const session = await this.getSession(input, command)
    prepareCodexSession(session, input)
    const rpc = session.rpc
    let active: CodexSegmentedTurn | undefined
    try {
      if (session.threadId === '') {
        const thread = input.providerSessionId
          ? await rpc.request('thread/resume', { threadId: input.providerSessionId, cwd: input.cwd ?? process.cwd(), ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}) }, { signal: input.signal, killOnAbort: false })
          : await rpc.request('thread/start', { cwd: input.cwd ?? process.cwd(), ...(!isProviderDefaultModel(input.modelId) ? { model: input.modelId } : {}) }, { signal: input.signal, killOnAbort: false })
        session.threadId = readId(thread) ?? input.providerSessionId ?? input.sessionId
        session.providerSessionId = session.threadId
      }
      active = session.segmentedTurn ?? await this.startSegmentedTurn(session, input)
      const isNew = session.segmentedTurn === undefined
      if (isNew) session.segmentedTurn = active
      if (isNew) yield { type: 'session-binding', providerSessionId: session.providerSessionId }

      for await (const chunk of this.consumeSegment(session, active, input)) yield chunk
      if (active.done && session.segmentedTurn === active) session.segmentedTurn = undefined
    } catch (error) {
      if (active !== undefined && !active.done) this.closeSegmentedTurn(session, active)
      if (!input.signal?.aborted) throw error
      await this.interrupt(input.sessionId)
    }
  }

  private async startSegmentedTurn(
    session: CodexSession,
    input: CodingNsCliTurnInput,
  ): Promise<CodexSegmentedTurn> {
    const eventQueue = createCodexTurnEventQueue()
    let activeTurnId: string | null = null
    let turnStartResolved = false
    const notificationsBeforeTurnStart: JsonRpcMessage[] = []
    const active: CodexSegmentedTurn = {
      queue: eventQueue,
      removeNotificationListener: () => undefined,
      terminalReason: null,
      done: false,
      pendingChunk: undefined,
      currentAssistantMessageId: undefined,
      sawCompletedTool: false,
      removeAbortListener: () => undefined,
    }
    const acceptNotification = (message: JsonRpcMessage, allowUnidentifiedTool: boolean): void => {
      if (!isCodexNotificationForTurn(message, session.threadId, activeTurnId, allowUnidentifiedTool)) return
      const turnId = readTurnId(message)
      if (turnId !== null) {
        activeTurnId = turnId
        session.turnId = turnId
      }
      eventQueue.push(message)
      const reason = readCodexTerminalReason(message)
      if (reason !== null) {
        active.terminalReason = reason
        eventQueue.close()
      }
    }
    const onNotification = (message: JsonRpcMessage): void => {
      if (!turnStartResolved) {
        notificationsBeforeTurnStart.push(message)
        return
      }
      acceptNotification(message, true)
    }
    active.removeNotificationListener = session.rpc.addNotificationListener(onNotification)
    const onAbort = (): void => {
      active.terminalReason = 'cancel'
      eventQueue.close()
    }
    active.removeAbortListener = () => input.signal?.removeEventListener('abort', onAbort)
    if (input.signal?.aborted) onAbort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await session.rpc.request('turn/start', codexTurnStartParams(input, session.threadId), { signal: input.signal, killOnAbort: false })
      const responseTurnId = readTurnId(response)
      if (responseTurnId !== null) {
        activeTurnId = responseTurnId
        session.turnId = responseTurnId
      }
      turnStartResolved = true
      for (const message of notificationsBeforeTurnStart.splice(0)) acceptNotification(message, false)
      const responseTerminal = buildCodexCompletionNotification(response, session.threadId)
      if (responseTerminal !== null) onNotification(responseTerminal)
      return active
    } catch (error) {
      this.closeSegmentedTurn(session, active)
      throw error
    }
  }

  private async *consumeSegment(session: CodexSession, active: CodexSegmentedTurn, input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    while (true) {
      let chunk: CodingNsAgentEvent | null
      if (active.pendingChunk !== undefined) {
        chunk = active.pendingChunk
        active.pendingChunk = undefined
      } else {
        const next = await active.queue.next()
        if (next.done) {
          if (input.signal?.aborted) throw new Error('请求已取消')
          active.done = true
          active.removeAbortListener()
          active.removeNotificationListener()
          yield { type: 'finish', reason: active.terminalReason ?? 'stop' }
          return
        }
        if (input.signal?.aborted) throw new Error('请求已取消')
        chunk = codexMessageToChunk(next.value)
      }
      if (chunk === null) continue

      // 一个 assistant item 可能在多个工具调用之间切换。把新 item 的首个
      // 正文留给下一次 llm/stream，当前流只返回边界，确保 DSH 先创建新 step。
      if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
        && chunk.messageId !== undefined) {
        const previousMessageId = active.currentAssistantMessageId
        if (previousMessageId !== undefined
          && previousMessageId !== chunk.messageId
          && active.sawCompletedTool) {
          active.pendingChunk = chunk
          active.currentAssistantMessageId = chunk.messageId
          active.sawCompletedTool = false
          yield { type: 'step-boundary' }
          return
        }
        active.currentAssistantMessageId = chunk.messageId
      }
      const stabilizedChunk = stabilizeCodexUsage(session, chunk)
      if (stabilizedChunk.type === 'tool-event' && (stabilizedChunk.status === 'completed' || stabilizedChunk.status === 'failed')) {
        active.sawCompletedTool = true
      }
      yield stabilizedChunk
    }
  }

  private closeSegmentedTurn(session: CodexSession, active: CodexSegmentedTurn): void {
    active.done = true
    active.removeAbortListener()
    active.removeNotificationListener()
    active.queue.close()
    if (session.segmentedTurn === active) session.segmentedTurn = undefined
  }

  /** 将新输入 steer 到当前 Codex turn。 */
  async steer(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.threadId === '' || session.turnId === null) throw new Error('Codex 会话未运行')
    const result = await session.rpc.request('turn/steer', { threadId: session.threadId, turnId: session.turnId, input: [{ type: 'text', text: prompt }] }, { killOnAbort: false })
    const turnId = readId(result)
    if (turnId) session.turnId = turnId
  }

  /** 中断当前 Codex turn，但保留 app-server 线程。 */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.threadId === '' || session.turnId === null) return
    try { await session.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }, { killOnAbort: false }) }
    catch { /* app-server 可能已经发出 turn/completed */ }
  }

  /** 回传原生权限请求；审批值只在 Host 进程中流转。 */
  respondPermission(sessionId: string, response: CodingNsAgentPermissionResponse): void {
    const session = this.sessions.get(sessionId)
    const pending = session?.pendingPermissions.get(response.requestId)
    if (pending === undefined || session === undefined) throw new Error('Codex 权限请求不存在')
    session.pendingPermissions.delete(response.requestId)
    if (pending.response === 'file-change') {
      pending.resolve({ decision: response.approved ? 'accept' : 'decline' })
    } else if (pending.response === 'command') {
      pending.resolve({ decision: response.approved ? 'accept' : 'decline' })
    } else {
      pending.resolve({
        approved: response.approved,
        ...(response.reason?.trim() ? { reason: response.reason.trim().slice(0, 512) } : {}),
      })
    }
  }

  /** 回传 requestUserInput 的结构化回答。 */
  respondQuestion(sessionId: string, response: CodingNsAgentQuestionResponse): void {
    const session = this.sessions.get(sessionId)
    const resolve = session?.pendingQuestions.get(response.requestId)
    if (resolve === undefined || session === undefined) throw new Error('Codex 问题请求不存在')
    session.pendingQuestions.delete(response.requestId)
    resolve({ answers: questionAnswersRecord(response) })
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.segmentedTurn !== undefined) this.closeSegmentedTurn(session, session.segmentedTurn)
      for (const pending of session.pendingPermissions.values()) pending.resolve({ approved: false })
      session.pendingPermissions.clear()
      for (const resolve of session.pendingQuestions.values()) resolve({ answers: {} })
      session.pendingQuestions.clear()
      session.rpc.dispose()
    }
    this.sessions.clear()
    this.processes.clear()
    this.cachedBinary = null
  }

  private async getSession(input: CodingNsCliTurnInput, command: string) {
    const previous = this.sessions.get(input.sessionId)
    if (previous !== undefined && previous.cwd === input.cwd) return previous
    if (previous?.segmentedTurn !== undefined) this.closeSegmentedTurn(previous, previous.segmentedTurn)
    previous?.rpc.dispose()
    const rpc = new JsonRpcProcess({ command, args: ['app-server'], cwd: input.cwd, spawn: this.runSpawn })
    const session = {
      rpc,
      cwd: input.cwd,
      modelId: input.modelId,
      contextWindow: undefined as number | undefined,
      threadId: '',
      turnId: null as string | null,
      providerSessionId: input.providerSessionId ?? input.sessionId,
      pendingPermissions: new Map<string, PendingCodexPermission>(),
      pendingQuestions: new Map<string, (value: unknown) => void>(),
      segmentedTurn: undefined as CodexSegmentedTurn | undefined,
    }
    this.processes.add(rpc)
    this.sessions.set(input.sessionId, session)
    await rpc.request('initialize', { clientInfo: { name: 'codingns4dsh', version: '0.1.1' }, capabilities: { experimentalApi: true } }, { signal: input.signal, killOnAbort: false })
    rpc.notify('initialized', {})
    rpc.setServerRequestHandler((request) => {
      const requestId = readRequestId(request)
      if (requestId === null) return { approved: false }
      const params = isRecord(request.params) ? request.params : request
      const item = isRecord(params.item) ? params.item : params
      const method = typeof request.method === 'string' ? request.method : ''
      const type = typeof item.type === 'string' ? item.type : ''
      if (isQuestionEvent(`${method} ${type}`)) {
        return new Promise<unknown>((resolve) => session.pendingQuestions.set(requestId, resolve))
      }
      return new Promise<unknown>((resolve) => session.pendingPermissions.set(requestId, {
        resolve,
        response: permissionResponseKind(method, params),
      }))
    })
    return session
  }
}

function stabilizeCodexUsage(session: CodexSession, event: CodingNsAgentEvent): CodingNsAgentEvent {
  if (event.type !== 'usage' || event.contextWindow === undefined) return event
  if (session.contextWindow === undefined) {
    session.contextWindow = event.contextWindow
    return event
  }
  if (session.contextWindow === event.contextWindow) return event
  // 同一 Codex thread/model 的 usage 通知可能带有全局默认窗口或迟到旧值。
  // 它不能覆盖首个已确认窗口，否则 DSH 会把 256K 错显示成 1M，并跳过压缩。
  const contextTokens = event.contextTokens ?? event.inputTokens + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0)
  return {
    ...event,
    contextWindow: session.contextWindow,
    contextTokens,
    contextUsageRatio: Number(Math.min(1, contextTokens / session.contextWindow).toFixed(6)),
  }
}

function prepareCodexSession(session: CodexSession, input: CodingNsCliTurnInput): void {
  // 未提供 modelId 表示沿用当前 Codex thread 的模型，不能因为配置字段缺省
  // 就把已经确认的上下文容量清空。
  if (input.modelId === undefined || session.modelId === input.modelId) return
  // 模型切换意味着上下文容量可能改变；只有这类明确路由变化才允许重置
  // 稳定窗口，同一模型的迟到 usage 不能触发重置。
  session.modelId = input.modelId
  session.contextWindow = undefined
}

function parseCodexCatalog(value: unknown): CodingNsCliModelCatalog {
  const root = isRecord(value) && isRecord(value.data) ? value.data : value
  const models = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.models) ? root.models
      : isRecord(root) && Array.isArray(root.data) ? root.data
        : []
  const items = models.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (entry.hidden === true) return []
    const id = typeof entry.model === 'string' ? entry.model.trim() : typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) return []
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? [...new Set(entry.supportedReasoningEfforts.flatMap((item) => {
          const effort = typeof item === 'string'
            ? item
            : isRecord(item) && typeof item.reasoningEffort === 'string'
              ? item.reasoningEffort
              : null
          return effort?.trim() ? [effort.trim()] : []
        }))]
      : []
    return [{
      id,
      name: typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : id,
      efforts,
    }]
  })
  if (items.length === 0) return emptyCatalog()
  return {
    groups: [{ id: 'codex', name: 'Codex', models: [...new Map(items.map((item) => [item.id, item])).values()] }],
    currentModel: null,
    currentEffort: null,
  }
}

function codexMessageToChunk(message: Record<string, any>): CodingNsAgentEvent | null {
  const params = isRecord(message.params) ? message.params : message
  const item = isRecord(params.item) ? params.item : params
  const method = typeof message.method === 'string' ? message.method : ''
  const type = typeof item.type === 'string' ? item.type : ''
  const text = textValue(params.delta ?? params.text ?? params.content ?? params.message)
  if (isQuestionEvent(`${method} ${type}`)) {
    const requestId = readRequestId(message) ?? readRequestId(params)
    const questions = readAgentQuestions(params.questions ?? item.questions ?? params)
    if (requestId !== null && questions.length > 0) return { type: 'question-request', requestId, questions }
  }
  if (method.includes('permission') || method.includes('Approval') || type.includes('permission') || type.includes('approval')) {
    const requestId = readRequestId(message) ?? readRequestId(params)
    const permission = codexPermissionDetails(method, params, item)
    const detail = permission.detail ?? text ?? undefined
    if (requestId !== null) return {
      type: 'permission-request',
      requestId,
      kind: permission.kind,
      ...(permission.toolName === undefined ? {} : { toolName: permission.toolName }),
      ...(permission.callId === undefined ? {} : { callId: permission.callId }),
      ...(detail === undefined ? {} : { detail }),
    }
  }
  const messageId = firstToolText(params.itemId, item.id)
  if (method.includes('agentMessage') || method.includes('message') && (type.includes('text') || type === '')) {
    return text ? { type: 'text-delta', text, ...(messageId === undefined ? {} : { messageId }) } : null
  }
  if (method.includes('reason') || type.includes('reason')) {
    return text ? { type: 'reasoning-delta', text, ...(messageId === undefined ? {} : { messageId }) } : null
  }
  if (isCodexToolEvent(method, type)) {
    const name = firstToolText(
      isFileChangeType(type) ? 'edit_file' : undefined,
      item.name,
      item.toolName,
      item.tool,
      item.command !== undefined ? 'command_execution' : undefined,
      type,
    )
    const callId = firstToolText(item.callId, item.call_id, item.toolCallId, item.id, params.itemId)
    const agentId = firstToolText(item.agentId, item.agent_id, type.includes('agent') || type.includes('collab') ? item.id : undefined)
    const input = serializeToolValue(isFileChangeType(type) ? fileChangeToolInput(item) : item.arguments ?? item.input ?? item.command)
    const rawOutput = item.result ?? item.output ?? item.aggregated_output
    const explicitError = serializeToolValue(item.error)
    const output = serializeToolValue(rawOutput)
    const exitCodeFailed = typeof item.exitCode === 'number' && item.exitCode !== 0 || typeof item.exit_code === 'number' && item.exit_code !== 0
    const failed = explicitError !== undefined || exitCodeFailed || method.includes('failed') || normalizeToolStatus(item.status ?? item.state, 'running') === 'failed'
    const fallback = failed ? 'failed' : method.includes('completed') || output !== undefined ? 'completed' : 'running'
    const detail = serializeToolValue(item.detail ?? item.description)
    return {
      type: 'tool-event',
      toolName: name ?? (agentId ? 'subagent' : 'tool'),
      status: normalizeToolStatus(item.status ?? item.state, fallback),
      ...(callId ? { callId } : {}),
      ...(input !== undefined ? { input } : {}),
      ...(failed
        ? { error: explicitError ?? output ?? `exit code ${String(item.exitCode ?? item.exit_code)}` }
        : output === undefined ? {} : { output }),
      ...(!failed && output !== undefined ? { outputMode: 'snapshot' as const } : {}),
      ...(agentId ? { agentId } : {}),
      ...(detail !== undefined ? { detail } : {}),
    }
  }
  return codexUsageChunk(params)
}

interface CodexPermissionDetails {
  readonly kind: string
  readonly toolName?: string
  readonly callId?: string
  readonly detail?: string
}

function codexPermissionDetails(method: string, params: Record<string, any>, item: Record<string, any>): CodexPermissionDetails {
  const fileChange = method.includes('fileChange') || method.includes('file_change') || String(item.type ?? '').toLowerCase() === 'filechange'
  const command = typeof params.command === 'string' ? params.command : typeof item.command === 'string' ? item.command : undefined
  const reason = typeof params.reason === 'string' ? params.reason : typeof params.description === 'string' ? params.description : undefined
  const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : undefined
  const paths = permissionPaths(params.fileChanges ?? params.file_changes ?? item.changes)
  const callId = firstToolText(params.callId, params.call_id, params.itemId, item.id)
  const detail = [reason, command, paths.length > 0 ? `文件: ${paths.join(', ')}` : undefined, grantRoot ? `允许写入: ${grantRoot}` : undefined]
    .filter((value): value is string => value !== undefined && value.trim() !== '')
    .join('；')
  return {
    kind: typeof params.kind === 'string' ? params.kind : fileChange ? 'file_change' : 'command',
    ...(fileChange ? { toolName: 'edit' } : {}),
    ...(callId === undefined ? {} : { callId }),
    ...(detail === '' ? {} : { detail }),
  }
}

function permissionPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => permissionPaths(entry))
  if (!isRecord(value)) return []
  const path = firstToolText(value.path, value.filePath, value.file_path)
  return path === undefined ? [] : [path]
}

function isFileChangeType(type: string): boolean {
  return type.replace(/[_-]/gu, '').toLowerCase() === 'filechange'
}

function fileChangeToolInput(item: Record<string, any>): unknown {
  const changes = Array.isArray(item.changes) ? item.changes : []
  return {
    changes: changes.map((change) => isRecord(change) ? {
      file_path: firstToolText(change.path, change.filePath, change.file_path) ?? '',
      ...(typeof change.kind === 'string' ? { kind: change.kind } : {}),
      ...(typeof change.diff === 'string' ? { diff: change.diff } : typeof change.patch === 'string' ? { diff: change.patch } : {}),
    } : change),
  }
}

/** Codex app-server 的 tokenUsage 使用未缓存输入和缓存输入两个独立桶。 */
function codexUsageChunk(params: Record<string, any>): CodingNsAgentEvent | null {
  const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : isRecord(params.token_usage) ? params.token_usage : null
  if (tokenUsage === null) return usageChunk(params)
  const latest = isRecord(tokenUsage.last)
    ? tokenUsage.last
    : isRecord(tokenUsage.lastUsage)
      ? tokenUsage.lastUsage
      : isRecord(tokenUsage.last_token_usage)
        ? tokenUsage.last_token_usage
        : isRecord(tokenUsage.total)
          ? tokenUsage.total
          : tokenUsage
  const uncachedInputTokens = optionalToken(latest.inputTokens ?? latest.input_tokens)
  const cacheReadTokens = optionalToken(latest.cachedInputTokens ?? latest.cached_input_tokens)
  const usage = usageChunk({
    inputTokens: uncachedInputTokens ?? 0,
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(latest.outputTokens === undefined && latest.output_tokens === undefined ? {} : { outputTokens: latest.outputTokens ?? latest.output_tokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(latest.totalTokens === undefined && latest.total_tokens === undefined ? {} : { totalTokens: latest.totalTokens ?? latest.total_tokens }),
  })
  if (usage === null) return null
  if (usage.type !== 'usage') return null
  const contextWindowValue = optionalToken(
    tokenUsage.contextWindow
      ?? tokenUsage.context_window
      ?? tokenUsage.modelContextWindow
      ?? tokenUsage.model_context_window
      ?? latest.contextWindow
      ?? latest.context_window
      ?? latest.modelContextWindow
      ?? latest.model_context_window
      ?? params.contextWindow
      ?? params.context_window,
  )
  const contextWindow = contextWindowValue !== undefined && contextWindowValue > 0 ? contextWindowValue : undefined
  const contextTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  return {
    ...usage,
    ...(contextWindow === undefined ? {} : {
      contextWindow,
      contextTokens,
      contextUsageRatio: Number(Math.min(1, contextTokens / contextWindow).toFixed(6)),
    }),
  }
}

function optionalToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readRequestId(value: unknown): string | null {
  if (!isRecord(value)) return null
  for (const key of ['requestId', 'request_id', 'id']) if (typeof value[key] === 'string' || typeof value[key] === 'number') return String(value[key])
  return null
}

function readTurnId(message: unknown): string | null {
  if (!isRecord(message)) return null
  const params = isRecord(message.params) ? message.params : message
  for (const key of ['turnId', 'turn_id']) if (typeof params[key] === 'string') return params[key]
  if (isRecord(params.turn) && typeof params.turn.id === 'string') return params.turn.id
  return null
}

/**
 * 复用父仓库 CodexRuntimeAdapter 的事件队列结构：终止时先排空已入队事件，
 * 再结束异步迭代，保证 turn/completed 前到达的最后一个文本片段不会丢失。
 */
function createCodexTurnEventQueue(): CodexTurnEventQueue {
  const values: JsonRpcMessage[] = []
  const waiters: Array<(result: IteratorResult<JsonRpcMessage>) => void> = []
  let closed = false
  const next = (): Promise<IteratorResult<JsonRpcMessage>> => {
    const value = values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => waiters.push(resolve))
  }
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next,
        }
      },
    },
    next,
    push(message) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ done: false, value: message })
      else values.push(message)
    },
    close() {
      if (closed) return
      closed = true
      while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
    },
  }
}

/** 只接收当前 thread/turn 的事件，避免子 Agent 的完成通知提前结束父轮次。 */
function isCodexNotificationForTurn(
  message: JsonRpcMessage,
  threadId: string,
  turnId: string | null,
  allowUnidentifiedTool: boolean,
): boolean {
  const params = isRecord(message.params) ? message.params : null
  const notificationThreadId = readScopedId(params, ['threadId', 'thread_id'], 'thread')
  const notificationTurnId = readTurnId(message)
  if (notificationThreadId !== null && notificationThreadId !== threadId) return false
  // turn/start 响应前的无 turnId 工具通知无法证明属于本次回合，通常是
  // thread/resume 的迟到历史；响应后则把它交给当前开放的 DSH step 处理。
  if (notificationTurnId === null && !allowUnidentifiedTool
    && (isCodexToolNotification(message) || isCodexUsageNotification(message))) return false
  return turnId === null || notificationTurnId === null || notificationTurnId === turnId
}

function readCodexTerminalReason(message: JsonRpcMessage): 'stop' | 'cancel' | 'error' | null {
  if (message.method === 'error') {
    const params = isRecord(message.params) ? message.params : null
    return params?.willRetry === true ? null : 'error'
  }
  if (message.method !== 'turn/completed') return null
  const params = isRecord(message.params) ? message.params : null
  const turn = isRecord(params?.turn) ? params.turn : null
  if (turn?.status === 'failed') return 'error'
  if (turn?.status === 'interrupted' || turn?.status === 'cancelled') return 'cancel'
  return 'stop'
}

/** 将 turn/start 响应里的终态归一化成父仓库使用的 turn/completed 通知。 */
function buildCodexCompletionNotification(value: unknown, threadId: string): JsonRpcMessage | null {
  if (!isRecord(value) || !isRecord(value.turn)) return null
  const status = value.turn.status
  if (status !== 'completed' && status !== 'failed' && status !== 'interrupted' && status !== 'cancelled') return null
  return { method: 'turn/completed', params: { threadId, turn: value.turn } }
}

function readScopedId(value: Record<string, any> | null, keys: readonly string[], nestedKey: string): string | null {
  if (value === null) return null
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
  const nested = value[nestedKey]
  return isRecord(nested) && typeof nested.id === 'string' && nested.id.trim() ? nested.id.trim() : null
}

function isCodexToolEvent(method: string, type: string): boolean {
  if (method.includes('command') || method.includes('tool') || method.includes('agent')) return true
  const normalized = type.replace(/[_-]/gu, '').toLowerCase()
  return ['commandexecution', 'filechange', 'mcptoolcall', 'functioncall', 'customtoolcall', 'dynamictoolcall'].includes(normalized)
}

function isCodexToolNotification(message: JsonRpcMessage): boolean {
  // 带 id 的消息是 Codex 发起的 JSON-RPC 服务请求（例如权限审批），
  // 必须交给 serverRequestHandler，不能被当成实时工具通知过滤掉。
  if (message.id !== undefined && message.id !== null) return false
  const params = isRecord(message.params) ? message.params : null
  const item = isRecord(params?.item) ? params.item : params
  const method = typeof message.method === 'string' ? message.method : ''
  const type = typeof item?.type === 'string' ? item.type : ''
  return isCodexToolEvent(method, type)
}

function isCodexUsageNotification(message: JsonRpcMessage): boolean {
  const method = typeof message.method === 'string' ? message.method.toLowerCase() : ''
  return method.includes('tokenusage') || method.includes('token_usage') || method.includes('usage/updated')
}

function codexTurnStartParams(input: CodingNsCliTurnInput, threadId: string): Record<string, unknown> {
  const cwd = resolve(input.cwd ?? process.cwd())
  return {
    threadId,
    input: [{ type: 'text', text: input.prompt }],
    cwd,
    // DSH 的 workspace-write 只约束自身工具沙箱，不会自动传递给 Codex
    // app-server。显式声明当前工作区，避免 Codex 将文件编辑误判为只读越权。
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    approvalPolicy: 'on-request',
    ...(input.effortId ? { effort: input.effortId } : {}),
  }
}

function permissionResponseKind(method: string, params: Record<string, any>): PendingCodexPermission['response'] {
  if (method.includes('fileChange') || method.includes('file_change')) return 'file-change'
  // 新版 Codex 带 threadId/turnId/itemId，并要求 decision；旧版测试和旧
  // app-server 使用 approved 字段，按请求形状保持向后兼容。
  if (method.includes('commandExecution') && (params.threadId !== undefined || params.turnId !== undefined || params.itemId !== undefined)) return 'command'
  return 'legacy'
}

function readId(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.threadId === 'string') return value.threadId
  if (typeof value.id === 'string') return value.id
  if (isRecord(value.thread) && typeof value.thread.id === 'string') return value.thread.id
  return null
}
