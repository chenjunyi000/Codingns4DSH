import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'
import type {
  CodingNsCliModelCatalog,
  CodingNsAgentEvent,
  CodingNsAgentToolEvent,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliDriver, CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'
import { firstToolText, serializeToolValue } from './tool-observation.js'
import { usageChunk } from './rpc-driver-utils.js'
import { commandEnvironment, resolveCommandPath, terminateChildProcess } from './process-utils.js'

const WINDOWS = process.platform === 'win32'
const COMMAND_CODE_BINARIES = WINDOWS
  ? ['command-code', 'commandcode', 'cmdc']
  : ['command-code', 'commandcode', 'cmdc', 'cmd']
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const CATALOG_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['deepseek/deepseek-v4-flash-vision-exp', ['high', 'max']],
  ['deepseek/deepseek-v4-pro', ['high', 'max']],
  ['deepseek/deepseek-v4-flash', ['high', 'max']],
  ['deepseek/deepseek-v4.1-flash', ['low', 'high', 'max']],
  ['deepseek/deepseek-v4-flash-fast', ['low', 'high', 'max']],
  ['moonshotai/kimi-k3', ['low', 'high', 'max']],
  ['moonshotai/kimi-k2.7-code', []],
  ['moonshotai/kimi-k2.7-code-highspeed', []],
  ['moonshotai/kimi-k2.6', []],
  ['moonshotai/kimi-k2.5', []],
  ['z-ai/glm-5.3-flash', ['low', 'high', 'max']],
  ['z-ai/glm-5.3-flashx', ['low', 'high', 'max']],
  ['zai-org/glm-5.3', ['low', 'high', 'max']],
  ['zai-org/glm-5.2', ['high', 'max']],
  ['zai-org/glm-5.2-fast', []],
  ['zai-org/glm-5.1', []],
  ['zai-org/glm-5', []],
  ['minimaxai/minimax-m3', ['low', 'medium', 'high']],
  ['minimaxai/minimax-m2.7', []],
  ['minimaxai/minimax-m2.5', []],
  ['xiaomi/mimo-v2.6-pro', []],
  ['xiaomi/mimo-v2.6-pro-ultraspeed', []],
  ['xiaomi/mimo-v2.6-flash', []],
  ['xiaomi/mimo-v2.5-pro', []],
  ['xiaomi/mimo-v2.5', []],
  ['qwen/qwen3.8-omni-flash', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-max-0902', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-max', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-27b', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.8-flash', ['low', 'medium', 'xhigh']],
  ['qwen/qwen3.7-max', []],
  ['qwen/qwen3.7-plus', []],
  ['qwen/qwen3.7-flash', []],
  ['qwen/qwen3.6-max-preview', []],
  ['qwen/qwen3.6-plus', []],
  ['meituan/longcat-2.0', []],
  ['stepfun/step-5-preview', []],
  ['stepfun/step-3.7-flash', []],
  ['stepfun/step-3.5-flash', []],
  ['tencent/hy3-paid', []],
  ['tencent/hy4-preview', ['low', 'medium', 'high']],
  ['nvidia/nemotron-3-ultra-550b-a55b', []],
  ['thinkingmachines/inkling', []],
  ['thinkingmachines/inkling-small', []],
  ['poolside/laguna-s-2.1-free', []],
  ['inclusionai/ling-3.0-flash-sante:free', []],
  ['sakana/fugu-ultra', ['high', 'xhigh']],
  ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-sonnet-4-6', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-fable-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['claude-haiku-4-5', []],
  ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-terra', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['gpt-5.5', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh']],
  ['gpt-5.4-mini', ['low', 'medium', 'high']],
  ['google/gemini-3.8-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.7-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.6-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.5-flash', ['low', 'medium', 'high']],
  ['google/gemini-3.5-flash-lite', ['low', 'medium', 'high']],
  ['google/gemini-3.1-flash-lite', ['low', 'medium', 'high']],
  ['meta/muse-spark-1.1', ['low', 'medium', 'high', 'xhigh']],
  ['meta/muse-spark-1.2', ['low', 'medium', 'high', 'xhigh']],
  ['meta/muse-spark-1.2-contributor', ['low', 'medium', 'high', 'xhigh']],
  ['meta/muse-spark-1.3', ['low', 'medium', 'high', 'xhigh', 'max']],
  ['meta/muse-spark-1.3-contributor', ['low', 'medium', 'high', 'xhigh']],
  ['xai/grok-4.6', ['low', 'medium', 'high', 'xhigh']],
  ['xai/grok-4.5', ['low', 'medium', 'high']],
  ['xai/grok-4.7', ['low', 'medium', 'high', 'xhigh']],
])

/** 一个 `-p` 运行的事件队列；进程常驻，DSH step 之间只暂停消费。 */
interface CommandCodeEventQueue {
  next(): Promise<IteratorResult<CodingNsAgentEvent>>
  push(event: CodingNsAgentEvent): void
  close(): void
}

/** Command Code 的 `--output-format json` 在一个进程里跑完整个 agent 循环。 */
interface CommandCodeTurn {
  readonly sessionId: string
  readonly child: ChildProcessWithoutNullStreams
  readonly transcriptPath: string
  readonly queue: CommandCodeEventQueue
  /** 当前 assistant 消息身份；正文/推理增量必须携带它，公共投影层才能切块。 */
  currentMessageId: string | undefined
  /** 只有工具真正完成后才允许在下一个 assistant 消息处结束 DSH step。 */
  sawCompletedTool: boolean
  /** 已提前取出、等待下一个 DSH step 继续消费的事件。 */
  pendingChunk: CodingNsAgentEvent | undefined
  /** 运行已经产出终态事件（可能仍在队列里等待消费）。 */
  terminal: boolean
  /** 消费者已经收到 finish；此后不能再被续段复用。 */
  finished: boolean
  aborted: boolean
  failure: Error | null
  disposed: boolean
}

/** 单次运行内的消息标识与增量补齐状态。 */
interface CommandCodeStreamState {
  messageSequence: number
  messageId: string | null
  emittedText: string
  emittedReasoning: string
  sawText: boolean
  perRequestUsageSeen: boolean
  turnUsageSeen: boolean
  sessionId: string | null
  aborted: () => boolean
}

export interface CommandCodeDriverOptions {
  readonly homeDirectory?: string
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/**
 * Command Code 驱动：沿用 `--session + -p + --output-format json` 的 NDJSON 事件流。
 *
 * 与 Codex 驱动保持同一套消息优化：正文/推理增量携带 assistant 消息身份，工具完成后
 * 的下一条 assistant 消息之前结束当前 DSH step，因此一个 Provider 运行会被切成多个
 * step，而不是把整轮正文堆积到最后一条结算消息里。驱动只输出公共事件契约，工具历史、
 * usage 和原生组件映射全部交给公共消息投影层。
 */
export class CommandCodeDriver implements CodingNsCliDriver {
  readonly descriptor = {
    id: 'command-code',
    name: 'Command Code',
    protocol: 'command',
    capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'usage'] as const,
  } as const
  /** 驱动自己维护 Provider turn 边界，Host 可以把工具边界映射为 DSH step。 */
  readonly supportsSegmentedTurns = true
  private readonly homeDirectory: string
  private readonly binaries: readonly string[]
  private readonly runSpawnSync: typeof spawnSync
  private readonly runSpawn: typeof spawn
  private cachedBinary: string | null = null
  private cachedEnvironment: Record<string, string | undefined> | undefined
  private readonly processes = new Set<ChildProcessWithoutNullStreams>()
  private readonly turns = new Map<string, CommandCodeTurn>()

  constructor(options: CommandCodeDriverOptions = {}) {
    this.homeDirectory = options.homeDirectory ?? join(homedir(), '.commandcode')
    this.binaries = options.binaries ?? COMMAND_CODE_BINARIES
    this.runSpawnSync = options.spawnSync ?? spawnSync
    this.runSpawn = options.spawn ?? spawn
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    for (const command of this.binaries) {
      const direct = this.detectCommand(command)
      if (direct !== null) return direct
      if (!this.lookupAfterDetectionFailure) continue
      const resolved = resolveCommandPath(command, this.runSpawnSync)
      if (resolved === null) continue
      const fallback = this.detectCommand(resolved)
      if (fallback !== null) return fallback
    }
    return { installed: false, version: null, command: null }
  }

  private lookupAfterDetectionFailure = false

  private detectCommand(command: string): { installed: true; version: string; command: string } | null {
    this.lookupAfterDetectionFailure = false
    try {
      const result = this.runSpawnSync(command, ['--version'], { encoding: 'utf8', timeout: 3_000, windowsHide: true, shell: WINDOWS, env: commandEnvironment(command) })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      const version = output.match(/\d+\.\d+\.\d+/u)?.[0] ?? null
      if (result.status === 0 && version !== null) {
        this.cachedBinary = command
        this.cachedEnvironment = commandEnvironment(command)
        return { installed: true, version, command }
      }
      this.lookupAfterDetectionFailure = result.status === null
    } catch {
      // PATH 中不存在候选命令属于正常的未安装状态。
      this.lookupAfterDetectionFailure = true
    }
    return null
  }

  async listModels(): Promise<CodingNsCliModelCatalog> {
    const detection = await this.detect()
    if (!detection.installed || detection.command === null) return emptyCatalog()
    let stdout = ''
    try {
      const result = this.runSpawnSync(detection.command, ['--list-models'], { encoding: 'utf8', timeout: 12_000, windowsHide: true, shell: WINDOWS, ...(this.cachedEnvironment === undefined ? {} : { env: this.cachedEnvironment }) })
      stdout = result.stdout ?? ''
    } catch {
      return emptyCatalog()
    }

    const groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string; efforts: readonly string[] }> }> = []
    let currentGroup: (typeof groups)[number] | undefined
    for (const rawLine of stdout.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('Available models') || line.startsWith('Pass the full id') || line.startsWith('cmd --') || line.startsWith('Docs:')) continue
      if (!/\s{2,}/u.test(line) && !line.includes(' · ')) {
        currentGroup = { id: line.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), name: line, models: [] }
        groups.push(currentGroup)
        continue
      }
      const match = line.match(/^(\S+)\s{2,}(.*)$/u)
      if (!match || currentGroup === undefined) continue
      const id = match[1]!
      const description = match[2]!.trim()
      currentGroup.models.push({ id, name: id, ...(description ? { description } : {}), efforts: CATALOG_EFFORTS.get(id.toLowerCase()) ?? [] })
    }

    const config = readJson(join(this.homeDirectory, 'config.json'))
    const currentModel = typeof config?.model === 'string' ? config.model : null
    const configuredEffort = currentModel !== null && isRecord(config?.reasoningEffort) ? config.reasoningEffort[currentModel] : undefined
    const currentEffort = typeof configuredEffort === 'string' && VALID_EFFORTS.has(configuredEffort) ? configuredEffort : null
    const result = { groups, currentModel, currentEffort } satisfies CodingNsCliModelCatalog
    return result
  }

  async probeSession(_input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult> {
    return {
      state: 'ephemeral',
      reason: 'Command Code 当前使用单轮临时 transcript，不存在可恢复的 Provider 原始会话',
    }
  }

  async *executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent> {
    const binary = this.cachedBinary ?? (await this.detect()).command
    if (binary === null) throw new Error('Command Code 未安装')

    const segmented = input.splitToolSteps === true
    const turn = segmented ? this.acquireTurn(input, binary) : this.startTurn(input, binary)
    let suspended = false
    const onAbort = (): void => { turn.aborted = true; this.disposeTurn(turn) }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    if (input.signal?.aborted) onAbort()
    try {
      yield* this.consumeTurn(turn, input, segmented, () => { suspended = true })
    } finally {
      input.signal?.removeEventListener('abort', onAbort)
      // 只有驱动自己为下一个 DSH step 挂起时才保留进程；正常结束、取消和调用方
      // 提前关闭流都必须回收 CLI 进程与临时 transcript。
      if (!suspended) this.disposeTurn(turn)
    }
  }

  dispose(): void {
    for (const turn of [...this.turns.values()]) this.disposeTurn(turn)
    this.turns.clear()
    for (const child of this.processes) terminateChildProcess(child)
    this.processes.clear()
    this.cachedBinary = null
  }

  /** 丢弃等待下一个 DSH step 的 `-p` 运行，避免旧进程继续占用新一轮输出。 */
  discardSegmentedTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn !== undefined) this.disposeTurn(turn)
  }

  /** 只有 Host 显式声明续段时才复用常驻进程；新的用户回合必须重新启动。 */
  private acquireTurn(input: CodingNsCliTurnInput, binary: string): CommandCodeTurn {
    const existing = this.turns.get(input.sessionId)
    if (existing !== undefined) {
      if (input.resumeSegmentedTurn === true && !existing.disposed && !existing.finished) return existing
      this.disposeTurn(existing)
    }
    const turn = this.startTurn(input, binary)
    this.turns.set(input.sessionId, turn)
    return turn
  }

  private startTurn(input: CodingNsCliTurnInput, binary: string): CommandCodeTurn {
    const transcriptPath = join(tmpdir(), `codingns4dsh-cc-${safeId(input.sessionId)}.jsonl`)
    writeTranscript(transcriptPath, input)
    const args = ['--session', transcriptPath, '-p', input.prompt, '--output-format', 'json', '--tools-all', '--yolo']
    if (input.modelId) args.push('-m', input.modelId)
    if (input.effortId && input.effortId !== 'default' && input.effortId !== 'Default') args.push('--effort', input.effortId)

    const child = this.runSpawn(binary, args, { cwd: input.cwd ?? process.cwd(), env: this.cachedEnvironment ?? commandEnvironment(binary), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: WINDOWS })
    this.processes.add(child)
    // 必须消费 stderr，错误内容不能回传给 DSH，避免泄露命令参数或文件片段。
    child.stderr?.on('data', () => undefined)
    const turn: CommandCodeTurn = {
      sessionId: input.sessionId,
      child,
      transcriptPath,
      queue: createEventQueue(),
      currentMessageId: undefined,
      sawCompletedTool: false,
      pendingChunk: undefined,
      terminal: false,
      finished: false,
      aborted: false,
      failure: null,
      disposed: false,
    }
    // 未监听 error 的 ChildProcess 会把 spawn 失败升级成宿主进程异常。
    if (typeof (child as { on?: unknown }).on === 'function') {
      child.on('error', (error: Error) => {
        turn.failure ??= error
        turn.queue.close()
      })
    }
    void this.pumpTurn(turn)
    return turn
  }

  /** 常驻读取 stdout：NDJSON 转成公共事件，进程结束后关闭队列。 */
  private async pumpTurn(turn: CommandCodeTurn): Promise<void> {
    const state = createStreamState(() => turn.aborted)
    try {
      const lines = readline.createInterface({ input: turn.child.stdout })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          const item = parseJson(line)
          if (item === null) continue
          const event = item.type === 'event' && isRecord(item.event) ? item.event : item
          for (const chunk of commandCodeEventChunks(event, state)) {
            if (chunk.type === 'finish') turn.terminal = true
            turn.queue.push(chunk)
          }
        }
      } finally {
        lines.close()
      }
    } catch (error) {
      turn.failure ??= error instanceof Error ? error : new Error(String(error))
    } finally {
      turn.queue.close()
      this.processes.delete(turn.child)
    }
  }

  private async *consumeTurn(
    turn: CommandCodeTurn,
    input: CodingNsCliTurnInput,
    segmented: boolean,
    suspend: () => void,
  ): AsyncIterable<CodingNsAgentEvent> {
    while (true) {
      let chunk: CodingNsAgentEvent
      if (turn.pendingChunk !== undefined) {
        chunk = turn.pendingChunk
        turn.pendingChunk = undefined
      } else {
        const next = await turn.queue.next()
        if (next.done) {
          if (turn.failure !== null) throw turn.failure
          if (turn.terminal) return
          if (turn.aborted || input.signal?.aborted === true) {
            yield { type: 'finish', reason: 'cancel' }
            return
          }
          throw new Error('Command Code 执行失败')
        }
        chunk = next.value
      }

      // 一个 `-p` 运行会在同一进程里连续跑多个 agent turn。把新 assistant 消息的
      // 首个正文留给下一次 llm/stream，当前流只返回边界，确保 DSH 先创建新 step。
      if (segmented
        && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
        && chunk.messageId !== undefined) {
        const previousMessageId = turn.currentMessageId
        if (previousMessageId !== undefined
          && previousMessageId !== chunk.messageId
          && turn.sawCompletedTool) {
          turn.pendingChunk = chunk
          turn.currentMessageId = chunk.messageId
          turn.sawCompletedTool = false
          suspend()
          yield { type: 'step-boundary' }
          return
        }
        turn.currentMessageId = chunk.messageId
      }
      if (chunk.type === 'tool-event' && (chunk.status === 'completed' || chunk.status === 'failed')) {
        turn.sawCompletedTool = true
      }
      if (chunk.type === 'finish') turn.finished = true
      yield chunk
    }
  }

  private disposeTurn(turn: CommandCodeTurn): void {
    if (turn.disposed) return
    turn.disposed = true
    turn.queue.close()
    if (this.turns.get(turn.sessionId) === turn) this.turns.delete(turn.sessionId)
    this.processes.delete(turn.child)
    terminateChildProcess(turn.child)
    try { rmSync(turn.transcriptPath, { force: true }) } catch { /* 临时文件清理尽力而为 */ }
  }
}

function createStreamState(aborted: () => boolean): CommandCodeStreamState {
  return {
    messageSequence: 0,
    messageId: null,
    emittedText: '',
    emittedReasoning: '',
    sawText: false,
    perRequestUsageSeen: false,
    turnUsageSeen: false,
    sessionId: null,
    aborted,
  }
}

function createEventQueue(): CommandCodeEventQueue {
  const values: CodingNsAgentEvent[] = []
  const waiters: Array<(result: IteratorResult<CodingNsAgentEvent>) => void> = []
  let closed = false
  const next = (): Promise<IteratorResult<CodingNsAgentEvent>> => {
    const value = values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => waiters.push(resolve))
  }
  return {
    next,
    push(event) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ done: false, value: event })
      else values.push(event)
    },
    close() {
      if (closed) return
      closed = true
      while (waiters.length > 0) waiters.shift()?.({ done: true, value: undefined })
    },
  }
}

/**
 * Command Code NDJSON → 公共 Agent 事件。
 *
 * 关键约定（对照本机 1.66.0 真实事件流）：
 * - `turn_start` / `message_start` 标识新的 assistant 消息，正文和推理增量都带上它；
 * - `tool_*` 使用 `toolCallId` 作为稳定调用 ID，同一调用的 queued/running/completed
 *   只能投影成一个 DSH 工具节点；
 * - `model_request_end` 的 usage 是当前请求的上下文占用；`run_end`/最终 `result`
 *   的 usage 是整个运行的累计值，只在完全没有单请求 usage 时兜底。
 */
function commandCodeEventChunks(event: Record<string, unknown>, state: CommandCodeStreamState): CodingNsAgentEvent[] {
  const chunks: CodingNsAgentEvent[] = []
  const type = textValue(event.type).trim().toLowerCase()

  const sessionId = readSessionId(event)
  if (sessionId !== null && sessionId !== state.sessionId) {
    state.sessionId = sessionId
    chunks.push({ type: 'session-binding', providerSessionId: sessionId })
  }

  switch (type) {
    case 'turn_start':
    case 'turn-start':
      beginMessage(state)
      break
    case 'message_start':
    case 'message-start':
      // 正常一轮只有一个模型请求；没有 turn_start 的旧版本由这里补消息身份。
      if (state.messageId === null) beginMessage(state)
      break
    case 'text_delta':
    case 'text-delta': {
      const text = textValue(event.delta ?? event.text ?? event.content)
      if (text) {
        ensureMessage(state)
        state.emittedText += text
        state.sawText = true
        chunks.push(textDelta(text, state))
      }
      break
    }
    case 'thinking_delta':
    case 'thinking-delta': {
      const text = textValue(event.delta ?? event.thinking ?? event.content)
      if (text) {
        ensureMessage(state)
        state.emittedReasoning += text
        chunks.push(reasoningDelta(text, state))
      }
      break
    }
    case 'message':
    case 'message_update':
    case 'message-update':
    case 'message_end':
    case 'message-end':
      // 只补齐增量流没有覆盖到的正文，避免累计快照被重复追加。
      appendContentFallback(chunks, event.content ?? recordValue(event.message)?.content, state)
      break
    case 'model_request_end':
    case 'model-request-end': {
      const usage = usageChunk(recordValue(event.usage))
      if (usage !== null) {
        state.perRequestUsageSeen = true
        state.turnUsageSeen = true
        chunks.push(usage)
      }
      break
    }
    case 'turn_end':
    case 'turn-end': {
      // 旧版本可能只在 turn_end 带 usage；与 model_request_end 去重，不重复结算。
      if (!state.turnUsageSeen) {
        const usage = usageChunk(recordValue(event.usage))
        if (usage !== null) {
          state.perRequestUsageSeen = true
          state.turnUsageSeen = true
          chunks.push(usage)
        }
      }
      break
    }
    case 'result': {
      if (!state.perRequestUsageSeen) {
        const usage = usageChunk(recordValue(event.usage))
        if (usage !== null) chunks.push(usage)
      }
      if (!state.sawText) {
        const finalText = textValue(event.finalText ?? recordValue(event.result)?.finalText ?? (typeof event.result === 'string' ? event.result : undefined))
        if (finalText) {
          ensureMessage(state)
          state.sawText = true
          state.emittedText += finalText
          chunks.push(textDelta(finalText, state))
        }
      }
      chunks.push({ type: 'finish', reason: state.aborted() ? 'cancel' : resultReason(event) })
      break
    }
    default:
      break
  }

  if (isToolStart(type)) {
    const tool = readToolChunk(event, type === 'tool_queued' || type === 'tool_started' ? 'started' : 'running')
    if (tool !== null) chunks.push(tool)
  } else if (isToolResult(type)) {
    const failed = type.includes('error') || type.includes('fail') || type.includes('denied') || type.includes('blocked')
    const tool = readToolChunk(event, failed ? 'failed' : 'completed')
    if (tool !== null) {
      chunks.push(tool)
      // 工具完成后的正文属于下一条 assistant 消息。即使 CLI 没有发送
      // turn_start/message_start，也要让公共投影层看到消息身份切换。
      if (tool.status === 'completed' || tool.status === 'failed') resetMessageIdentity(state)
    }
  }
  return chunks
}

function beginMessage(state: CommandCodeStreamState): void {
  state.messageSequence += 1
  state.messageId = `command-code-message-${state.messageSequence}`
  state.emittedText = ''
  state.emittedReasoning = ''
  state.turnUsageSeen = false
}

/** 丢弃当前消息身份；下一条正文增量会懒加载新的身份。 */
function resetMessageIdentity(state: CommandCodeStreamState): void {
  state.messageId = null
  state.emittedText = ''
  state.emittedReasoning = ''
}

function ensureMessage(state: CommandCodeStreamState): void {
  if (state.messageId === null) beginMessage(state)
}

function textDelta(text: string, state: CommandCodeStreamState): CodingNsAgentEvent {
  return { type: 'text-delta', text, ...(state.messageId === null ? {} : { messageId: state.messageId }) }
}

function reasoningDelta(text: string, state: CommandCodeStreamState): CodingNsAgentEvent {
  return { type: 'reasoning-delta', text, ...(state.messageId === null ? {} : { messageId: state.messageId }) }
}

/** 用完整的 assistant content 补齐缺失的正文/推理增量（只发送尚未发送的尾部）。 */
function appendContentFallback(chunks: CodingNsAgentEvent[], content: unknown, state: CommandCodeStreamState): void {
  if (!Array.isArray(content)) return
  let text = ''
  let reasoning = ''
  for (const block of content) {
    const value = recordValue(block)
    if (value === null) continue
    const blockType = textValue(value.type).toLowerCase()
    const isReasoning = blockType.includes('thinking') || blockType.includes('reasoning')
      || typeof value.thinking === 'string' || typeof value.reasoning === 'string'
    if (isReasoning) reasoning += textValue(value.thinking ?? value.reasoning ?? value.text ?? value.content)
    else text += textValue(value.text ?? value.content)
  }
  if (text.length > state.emittedText.length) {
    const delta = text.slice(state.emittedText.length)
    ensureMessage(state)
    state.emittedText = text
    state.sawText = true
    chunks.push(textDelta(delta, state))
  }
  if (reasoning.length > state.emittedReasoning.length) {
    const delta = reasoning.slice(state.emittedReasoning.length)
    ensureMessage(state)
    state.emittedReasoning = reasoning
    chunks.push(reasoningDelta(delta, state))
  }
}

function readToolChunk(event: Record<string, unknown>, status: 'started' | 'running' | 'completed' | 'failed'): CodingNsAgentToolEvent | null {
  const callId = firstToolText(event.callId, event.call_id, event.toolCallId, event.tool_call_id, event.toolUseId, event.tool_use_id, event.id)
  const fn = recordValue(event.function)
  const toolName = textValue(event.name ?? event.toolName ?? event.tool_name ?? event.tool ?? fn?.name) || 'tool'
  const error = textValue(event.error ?? event.reason ?? event.message)
  const output = textValue(event.output ?? event.result ?? event.content)
  const input = event.input ?? fn?.arguments ?? event.arguments
  const agentId = firstToolText(event.agentId, event.agent_id)
  const detail = serializeToolValue(event.detail ?? event.metadata ?? event.description)
  if (!callId && !toolName) return null
  return {
    type: 'tool-event',
    toolName,
    ...(callId ? { callId } : {}),
    ...(input !== undefined ? { input: structuredText(input) } : {}),
    ...(output ? { output } : {}),
    ...(output ? { outputMode: 'snapshot' as const } : {}),
    ...(error ? { error } : {}),
    ...(agentId ? { agentId } : {}),
    ...(detail !== undefined ? { detail } : {}),
    status,
  }
}

function isToolStart(type: string): boolean {
  return ['tool_queued', 'tool_started', 'tool_running', 'tool_use', 'tool_call', 'function_call'].includes(type)
}

function isToolResult(type: string): boolean {
  return ['tool_completed', 'tool_result', 'tool_return', 'tool_failed', 'tool_error', 'tool_denied', 'tool_hook_blocked', 'function_result'].includes(type)
}

function resultReason(event: Record<string, unknown>): 'stop' | 'cancel' | 'error' {
  const resultRecord = recordValue(event.result)
  const stopReason = textValue(event.stopReason ?? resultRecord?.stopReason).toLowerCase()
  const subtype = textValue(event.subtype).toLowerCase()
  if (event.error !== undefined || subtype === 'error' || stopReason.includes('error') || stopReason.includes('fail')) return 'error'
  if (stopReason.includes('interrupt') || stopReason.includes('cancel') || stopReason === 'aborted') return 'cancel'
  return 'stop'
}

function readSessionId(event: Record<string, unknown>): string | null {
  const value = textValue(event.sessionId ?? event.session_id ?? recordValue(event.session)?.id ?? recordValue(event.result)?.sessionId).trim()
  return value === '' ? null : value
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : structuredText(value)
}

function structuredText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}

function recordValue(value: unknown): Record<string, any> | null {
  return isRecord(value) ? value : null
}

function writeTranscript(path: string, input: CodingNsCliTurnInput): void {
  const history = input.messages.length > 0 ? input.messages.slice(0, -1) : []
  let parentId: string | null = null
  const lines = [JSON.stringify({ type: 'session', version: 3, id: input.sessionId, timestamp: new Date().toISOString(), cwd: input.cwd ?? process.cwd() })]
  history.forEach((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') return
    const id = message.id ?? `message-${index}`
    lines.push(JSON.stringify({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role: message.role, content: [{ type: 'text', text: extractText(message.content) }] } }))
    parentId = id
  })
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

function extractText(content: unknown): string { if (typeof content === 'string') return content; if (!Array.isArray(content)) return ''; return content.filter(isRecord).map((part) => typeof part.text === 'string' ? part.text : '').join('\n').trim() }
function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/gu, '_').slice(0, 96) || 'default' }
function parseJson(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null } catch { return null } }
function readJson(path: string): Record<string, unknown> | null { if (!existsSync(path)) return null; try { const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')); return isRecord(parsed) ? parsed : null } catch { return null } }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function emptyCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
