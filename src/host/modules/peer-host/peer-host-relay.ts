import type { HostScope, PeerHostRecord } from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'
import type { PeerHostRemoteConnector, PeerHostSocket } from './host-ws-proxy-service.js'
import { PeerHostConnectorError } from './host-ws-connector.js'

/** 已验证的 Host 侧 Relay 适配器；适配器内部必须复用现有 Transport。 */
export interface PeerHostRelayTransportFactory {
  readonly transportVersion: string
  readonly open: (input: {
    readonly record: PeerHostRecord
    readonly scope: HostScope
    /** 只在当前调用栈传递，禁止写入持久状态。 */
    readonly accessToken: string
  }) => Promise<PeerHostSocket>
}

export interface PeerHostRelayConnectorOptions {
  readonly transport?: PeerHostRelayTransportFactory
}

/**
 * 构造中转 connector。没有经过 Host 侧 Transport 验证的实现一律保持不可用。
 * relayEntryId/deviceId 只作为稳定路由标识传给适配器，不会被解释为 URL 或 ticket。
 */
export function createPeerHostRelayConnector(options: PeerHostRelayConnectorOptions = {}): PeerHostRemoteConnector {
  return async (record, accessToken, scope) => {
    if (record.route.kind !== 'relay') {
      throw new PeerHostConnectorError('PEER_HOST_PROXY_UNREACHABLE', 'PeerHost relay connector 收到非中转路由')
    }
    assertScope(scope, record.id)
    const transport = options.transport
    if (transport === undefined || transport.transportVersion.trim() === '' || transport.transportVersion !== record.route.transportVersion) {
      throw new PeerHostConnectorError('PEER_HOST_RELAY_UNAVAILABLE', '中转 PeerHost 尚未具备已验证的 Host Transport')
    }
    if (accessToken.trim() === '') throw new PeerHostConnectorError('PEER_HOST_SESSION_REQUIRED', '目标 Host 登录态为空')
    try {
      return await transport.open({ record, scope, accessToken })
    } catch (error) {
      if (error instanceof PeerHostConnectorError) throw error
      throw new PeerHostConnectorError('PEER_HOST_PROXY_UNREACHABLE', '中转 PeerHost 连接失败')
    }
  }
}

export type PeerHostReconnectState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'unreachable' | 'stopped' | 'relay_unavailable'

export interface PeerHostReconnectSnapshot {
  readonly peerHostId: string
  readonly state: PeerHostReconnectState
  readonly attempts: number
  readonly generation: number
  /** 重连成功后供上层重建订阅的完整作用域快照。 */
  readonly scope: HostScope
  readonly lastErrorCode: string | null
}

export interface PeerHostReconnectManagerOptions {
  readonly connect: PeerHostRemoteConnector
  readonly onState?: (snapshot: PeerHostReconnectSnapshot) => void | Promise<void>
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxAttempts?: number
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

interface Entry {
  readonly record: PeerHostRecord
  readonly accessToken: string
  scope: HostScope
  socket: PeerHostSocket | null
  timer: ReturnType<typeof setTimeout> | null
  state: PeerHostReconnectState
  attempts: number
  generation: number
  lastErrorCode: string | null
  stopped: boolean
}

/**
 * 单个 PeerHost 的有界断线恢复状态机。ticket/token 只存在 Entry 内存，close 后立即释放。
 * 重连成功会递增 generation；调用方必须用新快照重新建立 HostScope 订阅。
 */
export class PeerHostReconnectManager {
  private readonly entries = new Map<string, Entry>()
  private readonly setTimer: NonNullable<PeerHostReconnectManagerOptions['setTimer']>
  private readonly clearTimer: NonNullable<PeerHostReconnectManagerOptions['clearTimer']>
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number
  private closed = false

  constructor(private readonly options: PeerHostReconnectManagerOptions) {
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
    this.initialDelayMs = bounded(options.initialDelayMs ?? 250, 10, 60_000)
    this.maxDelayMs = bounded(options.maxDelayMs ?? 10_000, this.initialDelayMs, 120_000)
    this.maxAttempts = bounded(options.maxAttempts ?? 5, 0, 100)
  }

  async connect(record: PeerHostRecord, accessToken: string, scope: HostScope): Promise<PeerHostSocket> {
    if (this.closed) throw new PeerHostConnectorError('PEER_HOST_PROXY_UNREACHABLE', 'PeerHost reconnect manager 已关闭')
    assertScope(scope, record.id)
    const previous = this.entries.get(record.id)
    if (previous) this.stopEntry(previous)
    const entry: Entry = {
      record,
      accessToken,
      scope,
      socket: null,
      timer: null,
      state: 'connecting',
      attempts: 0,
      generation: scope.scopeGeneration,
      lastErrorCode: null,
      stopped: false,
    }
    this.entries.set(record.id, entry)
    await this.publish(entry)
    try {
      const socket = await this.options.connect(record, accessToken, scope)
      this.attach(entry, socket)
      entry.state = 'ready'
      entry.attempts = 0
      entry.lastErrorCode = null
      await this.publish(entry)
      return socket
    } catch (error) {
      this.markFailure(entry, error)
      this.schedule(entry)
      throw error
    }
  }

  snapshot(peerHostId: string): PeerHostReconnectSnapshot | null {
    const entry = this.entries.get(peerHostId)
    return entry ? toSnapshot(entry) : null
  }

  async close(peerHostId?: string): Promise<void> {
    if (peerHostId === undefined) {
      this.closed = true
      for (const entry of this.entries.values()) this.stopEntry(entry)
      this.entries.clear()
      return
    }
    const entry = this.entries.get(peerHostId)
    if (!entry) return
    this.stopEntry(entry)
    this.entries.delete(peerHostId)
  }

  private attach(entry: Entry, socket: PeerHostSocket): void {
    entry.socket = socket
    socket.on('close', () => this.onClosed(entry))
    socket.on('error', () => this.onClosed(entry))
  }

  private onClosed(entry: Entry): void {
    if (entry.stopped || this.closed || entry.socket === null) return
    entry.socket = null
    entry.state = 'reconnecting'
    this.schedule(entry)
    void this.publish(entry)
  }

  private markFailure(entry: Entry, error: unknown): void {
    entry.attempts += 1
    entry.lastErrorCode = error instanceof PeerHostConnectorError ? error.code : PEER_HOST_ERROR_CODES.PROXY_UNREACHABLE
    entry.state = entry.lastErrorCode === PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE ? 'relay_unavailable' : 'unreachable'
  }

  private schedule(entry: Entry): void {
    if (entry.stopped || this.closed || entry.timer !== null) return
    if (entry.lastErrorCode === PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE) {
      entry.state = 'relay_unavailable'
      void this.publish(entry)
      return
    }
    if (this.maxAttempts === 0 || entry.attempts >= this.maxAttempts) {
      entry.state = entry.lastErrorCode === PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE ? 'relay_unavailable' : 'unreachable'
      void this.publish(entry)
      return
    }
    const delay = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** Math.max(0, entry.attempts - 1))
    entry.timer = this.setTimer(() => {
      entry.timer = null
      if (entry.stopped || this.closed) return
      void this.reconnect(entry)
    }, delay)
    void this.publish(entry)
  }

  private async reconnect(entry: Entry): Promise<void> {
    if (entry.stopped || this.closed) return
    entry.state = 'reconnecting'
    await this.publish(entry)
    try {
      const socket = await this.options.connect(entry.record, entry.accessToken, { ...entry.scope, scopeGeneration: ++entry.generation })
      if (entry.stopped || this.closed) {
        socket.close(1000, 'PeerHost reconnect manager 已关闭')
        return
      }
      entry.scope = { ...entry.scope, scopeGeneration: entry.generation }
      this.attach(entry, socket)
      entry.state = 'ready'
      entry.attempts = 0
      entry.lastErrorCode = null
      await this.publish(entry)
    } catch (error) {
      this.markFailure(entry, error)
      this.schedule(entry)
    }
  }

  private stopEntry(entry: Entry): void {
    entry.stopped = true
    entry.state = 'stopped'
    if (entry.timer !== null) this.clearTimer(entry.timer)
    entry.timer = null
    const socket = entry.socket
    entry.socket = null
    if (socket?.readyState === 1) socket.close(1000, 'PeerHost reconnect manager 已清理')
    void this.publish(entry)
  }

  private async publish(entry: Entry): Promise<void> {
    await this.options.onState?.(toSnapshot(entry))
  }
}

function assertScope(scope: HostScope, peerHostId: string): void {
  if (scope.targetHostId !== peerHostId || scope.hostId.trim() === '' || scope.workspaceId.trim() === '' || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0 || (scope.sessionId !== null && scope.sessionId.trim() === '')) {
    throw new PeerHostConnectorError('PEER_HOST_PROXY_UNREACHABLE', 'PeerHost relay 作用域无效')
  }
}

function toSnapshot(entry: Entry): PeerHostReconnectSnapshot {
  return { peerHostId: entry.record.id, state: entry.state, attempts: entry.attempts, generation: entry.generation, scope: entry.scope, lastErrorCode: entry.lastErrorCode }
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('PeerHost reconnect 参数无效')
  return value
}
