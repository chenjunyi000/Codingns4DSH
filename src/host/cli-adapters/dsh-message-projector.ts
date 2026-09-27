import type {
  CodingNsAgentEvent,
  CodingNsAgentQuestionResponse,
  CodingNsAgentPermissionResponse,
} from '../../shared/contracts/cli-adapter.js'
import type { CodingNsNativeSessionBridge, CodingNsNativeUsageSample } from '../native-session-bridge.js'
import { CodingNsDshToolHistoryProjector } from './dsh-tool-history.js'
import {
  CodingNsAgentEventNormalizer,
  type CodingNsNormalizedAgentEvent,
} from './stream-normalizer.js'
import type { CodingNsDshExternalToolMarker } from './dsh-tool-history.js'

export interface CodingNsDshMessageProjectorOptions {
  readonly adapterId: string
  readonly sessionId: string
  readonly modelId?: string
  readonly nativeSessions?: CodingNsNativeSessionBridge
  readonly signal?: AbortSignal
  readonly respondPermission?: (response: CodingNsAgentPermissionResponse) => Promise<void> | void
  readonly respondQuestion?: (response: CodingNsAgentQuestionResponse) => Promise<void> | void
}

/** DSH `llm/stream` 接受的最小结构；具体协议只允许在本文件构造。 */
export type CodingNsDshStreamChunk = Readonly<Record<string, unknown>>

/**
 * 所有外部 Agent 共用的 DSH 消息投影器。
 *
 * 驱动只产生 CodingNsAgentEvent。本类统一完成快照去重、通道索引、工具历史、
 * 原生权限/问题交互、usage 和终态映射，调用方不再按 Provider 或消息类型分支。
 */
export class CodingNsDshMessageProjector {
  private readonly normalizer = new CodingNsAgentEventNormalizer()
  private readonly toolHistory: CodingNsDshToolHistoryProjector
  private reasoningIndex: number | undefined = 0
  private textIndex: number | undefined = 1
  private nextBlockIndex = 2
  private reasoningText = ''
  private textText = ''
  private finished = false

  constructor(private readonly options: CodingNsDshMessageProjectorOptions) {
    this.toolHistory = new CodingNsDshToolHistoryProjector(options.nativeSessions, options.sessionId, options.adapterId)
  }

  get isFinished(): boolean {
    return this.finished
  }

  async push(event: CodingNsAgentEvent): Promise<readonly CodingNsDshStreamChunk[]> {
    if (this.finished) return []
    if (event.type === 'usage') this.recordUsageSample(event)
    const projected: CodingNsDshStreamChunk[] = []
    for (const normalized of this.normalizer.push(event)) {
      projected.push(...await this.project(normalized))
      if (this.finished) break
    }
    return projected
  }

  /** Provider 未发送 finish 时补齐 usage 和正常终态。 */
  async complete(reason: 'stop' | 'cancel' = 'stop'): Promise<readonly CodingNsDshStreamChunk[]> {
    if (this.finished) return []
    const projected = await this.flushUsage()
    projected.push(...await this.project({ type: 'finish', reason }))
    return projected
  }

  /** 把执行异常也交给同一投影层，确保错误正文和终态结构一致。 */
  async fail(message: string, cancelled = false): Promise<readonly CodingNsDshStreamChunk[]> {
    if (this.finished) return []
    const projected = await this.flushUsage()
    const reason = cancelled ? 'cancel' : 'error'
    if (!cancelled) {
      projected.push(...await this.project({ type: 'text-delta', text: formatExecutionFailure(this.options.adapterId, message) }))
    }
    projected.push(...await this.project({ type: 'finish', reason }, message))
    return projected
  }

  private async flushUsage(): Promise<CodingNsDshStreamChunk[]> {
    const projected: CodingNsDshStreamChunk[] = []
    for (const event of this.normalizer.flush()) projected.push(...await this.project(event))
    return projected
  }

  /** Provider 的 usage 到达时立即给 token-meter 一个非 surface 采样点。
   *
   * DSH 规范要求正式 usage 仍随 assistant/message 在 finish 前结算，因此这里不
   * 提前向 LLM 流发送第二个 usage，只写入 assistant/attempt 供上下文计量投影使用。
   */
  private recordUsageSample(event: Extract<CodingNsAgentEvent, { type: 'usage' }>): void {
    const usage: CodingNsNativeUsageSample = {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      ...(event.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.cacheReadTokens }),
      ...(event.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.cacheWriteTokens }),
      ...(event.uncachedInputTokens === undefined ? {} : { uncachedInputTokens: event.uncachedInputTokens }),
      ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
      ...(event.cacheHitRate === undefined ? {} : { cacheHitRate: event.cacheHitRate }),
      ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
      ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
      ...(event.contextUsageRatio === undefined ? {} : { contextUsageRatio: event.contextUsageRatio }),
    }
    if (event.contextWindow !== undefined) {
      this.options.nativeSessions?.appendRequestContext?.(this.options.sessionId, {
        provider: this.options.adapterId,
        model: this.options.modelId ?? this.options.adapterId,
        contextWindow: event.contextWindow,
      })
    }
    this.options.nativeSessions?.appendUsageSample?.(this.options.sessionId, usage)
  }

  private async project(
    event: CodingNsNormalizedAgentEvent,
    failureMessage?: string,
  ): Promise<readonly CodingNsDshStreamChunk[]> {
    switch (event.type) {
      case 'reasoning-delta':
        if (event.text === '') return []
        return this.appendDelta('reasoning', event.text)
      case 'text-delta':
        if (event.text === '') return []
        return this.appendDelta('text', event.text)
      case 'message-boundary':
        return this.closeMessageBlock(event.channel)
      case 'step-boundary':
        // DSH 0.1.7 的 Chat 分组器会把同一 Turn 中没有可见 assistant
        // 回复的连续工具节点合并到一个 process group。Codex 的工具已经
        // 在外部进程完成，分段之间没有 DSH 原生 assistant 文本可供分组器
        // 识别，因此写入一个 Markdown 引用定义作为不可见的回复边界。
        // 必须从新行开始；DSH UI 会忽略 definition 节点，而不是把 HTML 当注释解析。
        // 该内容不会显示给用户，也不会改变工具的原生 step 坐标。
        return this.appendDelta('text', '\n\n[//]: # (codingns-step-boundary)')
      case 'tool-event':
        return this.externalToolChunk(this.toolHistory.observe(event))
      case 'permission-request':
        await this.requestPermission(event)
        return []
      case 'question-request':
        await this.requestQuestions(event)
        return []
      case 'usage':
        return [{
          type: 'usage',
          usage: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.cacheReadTokens === undefined ? {} : { cacheReadTokens: event.cacheReadTokens }),
            ...(event.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: event.cacheWriteTokens }),
            ...(event.uncachedInputTokens === undefined ? {} : { uncachedInputTokens: event.uncachedInputTokens }),
            ...(event.totalTokens === undefined ? {} : { totalTokens: event.totalTokens }),
            ...(event.cacheHitRate === undefined ? {} : { cacheHitRate: event.cacheHitRate }),
            ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
            ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
            ...(event.contextUsageRatio === undefined ? {} : { contextUsageRatio: event.contextUsageRatio }),
          },
        }]
      case 'session-binding':
        return []
      case 'finish':
        const closed = [
          ...this.closeMessageBlock('reasoning'),
          ...this.closeMessageBlock('text'),
        ]
        this.finished = true
        this.toolHistory.finalize(event.reason, failureMessage)
        closed.push({ type: 'finish', reason: toDshFinishReason(event.reason, failureMessage) })
        return closed
    }
  }

  private appendDelta(channel: 'reasoning' | 'text', text: string): readonly CodingNsDshStreamChunk[] {
    const opened = channel === 'reasoning' ? this.reasoningText === '' : this.textText === ''
    const index = this.openBlock(channel)
    if (channel === 'reasoning') this.reasoningText += text
    else this.textText += text
    const delta = { type: `${channel}-delta`, index, text }
    return opened ? [{ type: 'block-start', index, blockType: channel }, delta] : [delta]
  }

  private openBlock(channel: 'reasoning' | 'text'): number {
    const current = channel === 'reasoning' ? this.reasoningIndex : this.textIndex
    if (current !== undefined) return current
    const index = this.nextBlockIndex
    this.nextBlockIndex += 1
    if (channel === 'reasoning') this.reasoningIndex = index
    else this.textIndex = index
    return index
  }

  private closeMessageBlock(channel: 'reasoning' | 'text'): readonly CodingNsDshStreamChunk[] {
    if (channel === 'reasoning') {
      if (this.reasoningText === '') return []
      const index = this.reasoningIndex
      if (index === undefined) return []
      const chunk = { type: 'block-end', index, block: { type: 'reasoning', text: this.reasoningText } }
      this.reasoningText = ''
      this.reasoningIndex = undefined
      return [chunk]
    }
    if (this.textText === '') return []
    const index = this.textIndex
    if (index === undefined) return []
    const chunk = { type: 'block-end', index, block: { type: 'text', text: this.textText } }
    this.textText = ''
    this.textIndex = undefined
    return [chunk]
  }

  private externalToolChunk(marker: CodingNsDshExternalToolMarker | null): readonly CodingNsDshStreamChunk[] {
    if (marker === null) return []
    const index = this.nextBlockIndex
    this.nextBlockIndex += 1
    return [
      { type: 'block-start', index, blockType: 'reasoning' },
      {
        type: 'reasoning-delta',
        index,
        // 空 delta 会被 DSH 的流式聚合器丢弃，空格能保留 live-chunk 但不会显示思考正文。
        text: ' ',
        codingnsExternalTool: marker,
      },
      { type: 'block-end', index, block: { type: 'reasoning', text: ' ' } },
    ]
  }

  private async requestPermission(event: Extract<CodingNsAgentEvent, { type: 'permission-request' }>): Promise<void> {
    const responder = this.options.respondPermission
    if (responder === undefined) throw new Error('外部 Agent 发送了权限请求，但适配器没有权限回复接口')
    const outcome = await this.options.nativeSessions?.requestApproval?.(this.options.sessionId, {
      requestId: event.requestId,
      toolName: event.toolName ?? (event.kind || 'external-agent'),
      ...(event.callId ? { callId: event.callId } : {}),
      ...(event.detail ? { reason: event.detail } : {}),
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    }) ?? 'unavailable'
    const approved = outcome === 'allowed-once'
    const reason = approvalReason(outcome)
    await responder({ requestId: event.requestId, approved, ...(reason === undefined ? {} : { reason }) })
  }

  private async requestQuestions(event: Extract<CodingNsAgentEvent, { type: 'question-request' }>): Promise<void> {
    const responder = this.options.respondQuestion
    if (responder === undefined) throw new Error('外部 Agent 发送了问题请求，但适配器没有问题回复接口')
    const response = await this.options.nativeSessions?.askQuestions?.(this.options.sessionId, {
      requestId: event.requestId,
      questions: event.questions,
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
    }) ?? null
    if (response === null) throw new Error('DSH 原生问题组件不可用或问题已取消')
    await responder(response)
  }
}

function toDshFinishReason(reason: 'stop' | 'cancel' | 'error', failureMessage?: string): Record<string, unknown> {
  if (reason === 'cancel') {
    return { kind: 'aborted', failure: { message: failureMessage ?? '外部 Agent 执行已取消', code: 'ABORTED' } }
  }
  if (reason === 'error') {
    return { kind: 'error', failure: { message: failureMessage ?? '外部 Agent 执行失败', code: 'PROVIDER_ERROR' } }
  }
  return { kind: 'stop' }
}

function approvalReason(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'): string | undefined {
  if (outcome === 'rejected') return '用户拒绝了权限请求'
  if (outcome === 'cancelled') return '权限请求已取消'
  if (outcome === 'unavailable') return 'DSH 原生权限组件不可用'
  return undefined
}

function formatExecutionFailure(adapterId: string, message: string): string {
  const content = `[${adapterId}] ${message}`
  const fence = '~'.repeat(Math.max(3, longestCharacterRun(content, '~') + 1))
  return `\n\n**外部 Agent 执行失败**\n\n${fence}text\n${content}\n${fence}\n`
}

function longestCharacterRun(value: string, character: string): number {
  let longest = 0
  let current = 0
  for (const item of value) {
    current = item === character ? current + 1 : 0
    longest = Math.max(longest, current)
  }
  return longest
}
