import type { CodingNsCarrier } from './carrier.js'
import {
  DSH_ENVELOPE_PROTOCOL,
  decodeDshEnvelope,
  encodeDshEnvelope,
  type DshEnvelope,
  type DshHostScope,
} from './dsh-envelope.js'
import { DSH_VERSION } from '../shared/contracts/version.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from './debug.js'

export type DshSessionRole = 'client' | 'host'
export type DshSessionState = 'idle' | 'handshaking' | 'ready' | 'degraded' | 'closed'

export interface DshSessionOptions {
  carrier: CodingNsCarrier
  role: DshSessionRole
  generation: string
  hostScope: DshHostScope
  dshVersion?: string
  capabilities?: readonly string[]
  protocol?: string
  heartbeatMs?: number
  onReady?(session: DshSession): void
  onEnvelope?(envelope: DshEnvelope): void
  onError?(error: Error): void
  /** Host 首个 session.hello 到达时采用对端 generation；后续帧仍严格校验。 */
  acceptInitialGeneration?: boolean
  debug?: DshTransportDebugLogger
}

/** 负责 DSH hello/ready、协议与能力协商和心跳，不执行任何业务。 */
export class DshSession {
  private stateValue: DshSessionState = 'idle'
  private readonly listeners = new Set<(envelope: DshEnvelope) => void>()
  private readonly unsubscribe: () => void
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private messageCounter = 0
  private remoteCapabilities: readonly string[] = []
  private readyValue: Promise<void> | undefined
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readonly debug: DshTransportDebugLogger
  private generationValue: string

  constructor(private readonly options: DshSessionOptions) {
    this.debug = options.debug ?? createDshTransportDebugLogger({ component: `session-${options.role}` })
    this.generationValue = options.generation
    this.unsubscribe = options.carrier.subscribe((data) => this.receive(data as Uint8Array))
    if (options.onEnvelope) this.listeners.add(options.onEnvelope)
  }

  get state(): DshSessionState { return this.stateValue }
  get ready(): boolean { return this.stateValue === 'ready' }
  get capabilities(): readonly string[] { return this.remoteCapabilities }
  get generation(): string { return this.generationValue }

  start(): void {
    if (this.stateValue !== 'idle') return
    this.stateValue = 'handshaking'
    this.debug.log('session.start', { role: this.options.role, generation: this.generationValue, hostId: this.options.hostScope.hostId, hostKind: this.options.hostScope.kind })
    this.readyValue = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Host 侧通常只监听 onReady，不会调用 waitReady；即使远端作用域
    // 无效，也不能让 ready Promise 变成 Node 的未处理拒绝。
    void this.readyValue.catch(() => undefined)
    if (this.options.role === 'client') this.sendHello()
    this.startHeartbeat()
  }

  waitReady(signal?: AbortSignal): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.stateValue === 'closed') return Promise.reject(new Error('DSH Session 已关闭'))
    if (!this.readyValue) this.start()
    const promise = this.readyValue as Promise<void>
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('会话等待已取消'))
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('会话等待已取消')), { once: true })),
    ])
  }

  subscribe(listener: (envelope: DshEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(envelope: DshEnvelope): void {
    if (this.stateValue === 'closed') throw new Error('DSH Session 已关闭')
    const pending = this.options.carrier.send(encodeDshEnvelope(envelope))
    this.debug.log('session.send', envelopeDebugFields(envelope))
    if (pending && typeof pending.catch === 'function') {
      void pending.catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    }
  }

  close(reason = 'DSH Session 已关闭'): void {
    if (this.stateValue === 'closed') return
    this.stateValue = 'closed'
    this.debug.log('session.close', { reason })
    this.unsubscribe()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.readyReject?.(new Error(reason))
    this.readyReject = undefined
    this.readyResolve = undefined
  }

  private sendHello(): void {
    this.send(this.createEnvelope('session.hello', 'session', {
      protocol: this.options.protocol ?? DSH_ENVELOPE_PROTOCOL,
      dshVersion: this.options.dshVersion ?? DSH_VERSION,
      capabilities: [...this.options.capabilities ?? []],
    }))
  }

  private sendReady(capabilities: readonly string[], peerDshVersion?: string): void {
    this.send(this.createEnvelope('session.ready', 'session', {
      protocol: this.options.protocol ?? DSH_ENVELOPE_PROTOCOL,
      // 回显对端上报的版本：旧客户端按自身兼容区间校验 ready，回显其自身版本才能放行。
      dshVersion: peerDshVersion ?? this.options.dshVersion ?? DSH_VERSION,
      hostDshVersion: this.options.dshVersion ?? DSH_VERSION,
      capabilities: [...capabilities],
      byteCredit: 64 * 1024,
      messageCredit: 32,
    }))
  }

  /**
   * 握手只校验隧道协议版本：对端缺省不带协议时按 v1 处理。
   * DSH 应用版本不再参与握手门槛；只有插件升级 DSH_ENVELOPE_PROTOCOL
   * （对应不再兼容的 WebRTC 变更）时，才会在此拒绝旧协议对端。
   */
  private handshakeProtocolMatches(envelope: DshEnvelope): boolean {
    const protocol = envelope.meta.protocol ?? DSH_ENVELOPE_PROTOCOL
    return protocol === (this.options.protocol ?? DSH_ENVELOPE_PROTOCOL)
  }

  /** 协议不兼容时先回发 session.close 让对端拿到明确原因，再收敛本地会话。 */
  private rejectHandshake(reason: string): void {
    this.send(this.createEnvelope('session.close', 'session', { reason }))
    this.fail(new Error(reason))
  }

  private receive(data: Uint8Array): void {
    if (this.stateValue === 'closed') return
    let envelope: DshEnvelope
    try {
      envelope = decodeDshEnvelope(data)
      this.validateScope(envelope)
    } catch (error) {
      this.debug.log('session.receive.invalid', { bytes: data.byteLength, error: error instanceof Error ? error.message : String(error) })
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.debug.log('session.receive', { bytes: data.byteLength, ...envelopeDebugFields(envelope) })
    if (envelope.channel === 'session') {
      this.receiveSession(envelope)
      return
    }
    if (!this.ready) {
      this.fail(new Error('SESSION_NOT_READY'))
      return
    }
    for (const listener of [...this.listeners]) listener(envelope)
  }

  private receiveSession(envelope: DshEnvelope): void {
    if (envelope.type === 'session.hello') {
      if (this.options.role !== 'host' || envelope.sequence !== 0 || this.stateValue === 'ready') {
        this.fail(new Error('非法 session.hello'))
        return
      }
      if (!this.handshakeProtocolMatches(envelope)) {
        this.rejectHandshake('PROTOCOL_VERSION_UNSUPPORTED')
        return
      }
      const peerDshVersion = typeof envelope.meta.dshVersion === 'string' ? envelope.meta.dshVersion : undefined
      const offered = readCapabilities(envelope.meta.capabilities)
      const allowed = new Set(this.options.capabilities ?? offered)
      this.remoteCapabilities = offered.filter((capability) => allowed.has(capability))
      this.stateValue = 'ready'
      this.debug.log('session.ready', { role: this.options.role, capabilities: this.remoteCapabilities })
      this.sendReady(this.remoteCapabilities, peerDshVersion)
      this.readyResolve?.()
      this.options.onReady?.(this)
      return
    }
    if (envelope.type === 'session.ready') {
      if (this.options.role !== 'client' || this.stateValue !== 'handshaking') {
        this.fail(new Error('非法 session.ready'))
        return
      }
      if (!this.handshakeProtocolMatches(envelope)) {
        this.rejectHandshake('PROTOCOL_VERSION_UNSUPPORTED')
        return
      }
      this.remoteCapabilities = readCapabilities(envelope.meta.capabilities)
      this.stateValue = 'ready'
      this.debug.log('session.ready', { role: this.options.role, capabilities: this.remoteCapabilities })
      this.readyResolve?.()
      this.options.onReady?.(this)
      return
    }
    if (envelope.type === 'session.ping') {
      this.send(this.createEnvelope('session.pong', 'session', { timestamp: Date.now() }))
      return
    }
    if (envelope.type === 'session.pong') return
    if (envelope.type === 'session.close') {
      this.close(typeof envelope.meta.reason === 'string' ? envelope.meta.reason : '远端关闭 DSH Session')
      return
    }
    this.fail(new Error('MESSAGE_INVALID'))
  }

  private validateScope(envelope: DshEnvelope): void {
    const isInitialHello = this.options.role === 'host'
      && this.options.acceptInitialGeneration === true
      && this.stateValue === 'handshaking'
      && envelope.channel === 'session'
      && envelope.type === 'session.hello'
      && envelope.sequence === 0
    if (envelope.hostScope.hostId !== this.options.hostScope.hostId
      || envelope.hostScope.kind !== this.options.hostScope.kind
      || (!isInitialHello && envelope.generation !== this.generationValue)) {
      throw new Error('RESOURCE_SCOPE_STALE')
    }
    if (isInitialHello && envelope.generation !== this.generationValue) {
      this.debug.log('session.generation.adopt', {
        previousGeneration: this.generationValue,
        generation: envelope.generation,
        hostId: envelope.hostScope.hostId,
      })
      this.generationValue = envelope.generation
    }
  }

  private createEnvelope(type: string, channel: DshEnvelope['channel'], meta: Record<string, unknown>): DshEnvelope {
    return {
      version: 1,
      messageId: `${this.options.role[0]}_${++this.messageCounter}`,
      streamId: 'session',
      channel,
      type,
      sequence: this.messageCounter - 1,
      generation: this.generationValue,
      hostScope: this.options.hostScope,
      meta,
    }
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatMs ?? 30_000
    if (!Number.isFinite(interval) || interval <= 0) return
    this.heartbeat = setInterval(() => {
      if (this.stateValue === 'closed') return
      try { this.send(this.createEnvelope('session.ping', 'session', { timestamp: Date.now() })) } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    }, interval)
  }

  /**
   * 会话失败必须同时收敛物理线路。
   *
   * 早期实现只把本地状态改成 `degraded`、拒绝 `waitReady`：对端既收不到
   * `session.close`，DataChannel 也不会关闭，于是一次发送失败（例如浏览器宣告的
   * max-message-size 太小、分片发送被拒、背压超时）之后，对端会在一个已经死掉的
   * 线路上等一个永远不回来的响应。中继页面的原生设置 `settings/describe` 正是这样
   * 永久停在 loading：页面空白、没有任何报错。
   */
  private fail(error: Error): void {
    if (this.stateValue === 'closed' || this.stateValue === 'degraded') return
    const wasReady = this.stateValue === 'ready'
    this.stateValue = 'degraded'
    this.debug.log('session.error', { error: error.message })
    this.readyReject?.(error)
    this.options.onError?.(error)
    if (wasReady) {
      // 先尽力通知对端失败原因；发送本身失败也已经不影响后续收敛。
      try { this.send(this.createEnvelope('session.close', 'session', { reason: error.message })) } catch { /* 线路不可用时尽力而为 */ }
    }
    const carrier = this.options.carrier
    // 让已排队的收尾帧先进入发送链，再关闭物理线路。
    setTimeout(() => { void carrier.close(`DSH Session 失败：${error.message}`) }, 0)
  }
}

function envelopeDebugFields(envelope: DshEnvelope): Record<string, unknown> {
  return {
    type: envelope.type,
    channel: envelope.channel,
    streamId: envelope.streamId,
    sequence: envelope.sequence,
    generation: envelope.generation,
    hostId: envelope.hostScope.hostId,
    hostKind: envelope.hostScope.kind,
    operation: typeof envelope.meta.operation === 'string' ? envelope.meta.operation : undefined,
    bodyBytes: envelope.body?.byteLength ?? 0,
  }
}

function readCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('MESSAGE_INVALID')
  return [...new Set(value)]
}
