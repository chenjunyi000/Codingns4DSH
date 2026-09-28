import { ReverseProxyPanel } from './reverse-proxy-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'
import type { CodingNsRpcClient } from './types.js'
import { startDshH5Bootstrap } from '../dsh-h5-bootstrap.js'
import { callCodingNsRpc } from '../settings-bridge.js'
import { LOGIN_PROTECTION_SESSION_EVENT, readLoginProtectionSession } from './login-protection-session.js'
import type { LanAccessDshLoginSettings } from '../../shared/contracts/config.js'
import type { CodingNsAuthSessionSnapshot } from '../../shared/contracts/auth.js'
import { CODINGNS_DSH_ERROR_CODES } from '../../shared/index.js'

function isRemoteWebContext(): boolean {
  return (globalThis as typeof globalThis & {
    readonly __CODINGNS4DSH_REMOTE_WEB_CONTEXT__?: boolean
  }).__CODINGNS4DSH_REMOTE_WEB_CONTEXT__ === true
}

/**
 * 中转访问服务模块。
 *
 * 它把 DSH 页面接入 Codingns4DSH 独立设备隧道。登录和设备列表由 Host RPC 提供，
 * 连接状态和设备选择由设置面板承载；隧道本身在模块启用时建立。
 */
export const reverseProxyFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'reverseProxy',
    version: '0.1.1',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '中转访问服务',
      description: '通过 Codingns4DSH 独立设备隧道访问 Host。',
      labelKey: 'feature.reverseProxy.label',
      descriptionKey: 'feature.reverseProxy.description',
      order: 20,
      defaultOpen: true,
    },
  },
  /**
   * 隧道连接属于后续阶段，当前模块只提供配置面，因此这里不创建任何资源。
   * 接入连接后，流与订阅必须登记到 context.resources，由停用自动清理。
   */
  start(context) {
    const runtime = globalThis as typeof globalThis & {
      __CODINGNS4DSH_REVERSE_PROXY_EPOCH__?: symbol
    }
    const epoch = Symbol('codingns4dsh.reverse-proxy')
    runtime.__CODINGNS4DSH_REVERSE_PROXY_EPOCH__ = epoch
    const isCurrent = (): boolean => runtime.__CODINGNS4DSH_REVERSE_PROXY_EPOCH__ === epoch
    if (isRemoteWebContext()) {
      // 远程 DSH Web 的外层已经拥有有效 Tunnel；这里只保留设置 UI 和其它
      // 插件贡献，禁止同一页面重新申请票据并建立第二条中继连接。
      return () => { if (isCurrent()) delete runtime.__CODINGNS4DSH_REVERSE_PROXY_EPOCH__ }
    }
    // 当前 DSH Client 已经在启动期登记默认 Transport。动态功能不能在
    // Cordis 启动后再次接管全局 Connection；独立 H5 页面使用专用入口。
    if (hasPreCordisTransport()) {
      return () => { if (isCurrent()) delete runtime.__CODINGNS4DSH_REVERSE_PROXY_EPOCH__ }
    }
    const abort = new AbortController()
    let disposeConnection: (() => Promise<void>) | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let waitingForLogin = false
    let attemptInFlight = false
    let connected = false
    let transportUnavailable = false
    const onLoginProtectionSession = (): void => {
      waitingForLogin = false
      if (!connected) void attempt()
    }
    globalThis.addEventListener(LOGIN_PROTECTION_SESSION_EVENT, onLoginProtectionSession)
    const attempt = async (): Promise<void> => {
      if (!isCurrent() || stopped || waitingForLogin || connected || transportUnavailable || attemptInFlight) return
      attemptInFlight = true
      try {
        const auth = await readAuthSnapshot(context.services.rpc)
        if (auth.status !== 'authenticated') {
          scheduleRetry()
          return
        }
        const protection = await readLoginProtectionSettings(context.services.rpc)
        const loginProtectionToken = readLoginProtectionSession()
        if (protection.enabled && protection.scopes.relay && loginProtectionToken === undefined) {
          waitingForLogin = true
          return
        }
        if (!isCurrent()) return
        const dispose = await startBrowserRelayConnection(context.services.rpc, abort.signal, loginProtectionToken)
        if (!isCurrent()) { await dispose(); return }
        if (stopped || abort.signal.aborted) { await dispose(); return }
        disposeConnection = dispose
        connected = true
        if (retryTimer !== undefined) {
          clearTimeout(retryTimer)
          retryTimer = undefined
        }
      } catch (error) {
        if (!isCurrent() || stopped || abort.signal.aborted) return
        if (isTransportAlreadyRegistered(error)) {
          // 这是生命周期冲突，不是网络瞬断；继续定时重试只会刷屏。
          transportUnavailable = true
          return
        }
        console.error('codingns4dsh: 中继连接建立失败，将在稍后重试', error)
        scheduleRetry()
      } finally {
        attemptInFlight = false
      }
    }
    const scheduleRetry = (): void => {
      if (retryTimer !== undefined || stopped || abort.signal.aborted) return
      retryTimer = setTimeout(() => { retryTimer = undefined; void attempt() }, 5_000)
    }
    void attempt()
    return async () => {
      stopped = true
      connected = false
      globalThis.removeEventListener(LOGIN_PROTECTION_SESSION_EVENT, onLoginProtectionSession)
      abort.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      await disposeConnection?.()
      if (isCurrent()) delete runtime.__CODINGNS4DSH_REVERSE_PROXY_EPOCH__
    }
  },
  settingsPanel: ReverseProxyPanel,
}

function hasPreCordisTransport(): boolean {
  return (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ !== undefined
}

function isTransportAlreadyRegistered(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { readonly code?: unknown }).code === CODINGNS_DSH_ERROR_CODES.TRANSPORT_NOT_READY
}

/** 浏览器侧真实中继连接；refresh token 和 access token 只经过 Host RPC。 */
export async function startBrowserRelayConnection(rpc: CodingNsRpcClient, signal: AbortSignal, loginProtectionToken?: string): Promise<() => Promise<void>> {
  const bootstrap = await startDshH5Bootstrap({
    rpc,
    signal,
    ...(loginProtectionToken === undefined ? {} : { loginProtectionToken }),
    getLoginProtectionToken: readLoginProtectionSession,
  })
  const state = globalThis as typeof globalThis & { __CODINGNS4DSH_RELAY_MODE__?: 'direct' | 'relay' }
  state.__CODINGNS4DSH_RELAY_MODE__ = bootstrap.relayMode
  return async () => {
    if (state.__CODINGNS4DSH_RELAY_MODE__ === bootstrap.relayMode) delete state.__CODINGNS4DSH_RELAY_MODE__
    await bootstrap.dispose()
  }
}

async function readLoginProtectionSettings(rpc: CodingNsRpcClient): Promise<LanAccessDshLoginSettings> {
  return callCodingNsRpc<LanAccessDshLoginSettings>(rpc, 'lanAccessDsh/login/get', {})
}

async function readAuthSnapshot(rpc: CodingNsRpcClient): Promise<CodingNsAuthSessionSnapshot> {
  return callCodingNsRpc<CodingNsAuthSessionSnapshot>(rpc, 'auth/snapshot', {})
}
