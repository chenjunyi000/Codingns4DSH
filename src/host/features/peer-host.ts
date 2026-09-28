import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsHostServices } from './types.js'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { CODINGNS_VERSION, DSH_VERSION, isDshVersionCompatible } from '../../shared/contracts/version.js'
import { PeerHostHandshakeService } from '../modules/peer-host/peer-host-handshake.js'
import { PeerHostSessionService } from '../modules/peer-host/peer-host-session.js'
import { PeerHostHttpProxyService } from '../modules/peer-host/host-api-proxy-service.js'
import {
  EncryptedFilePeerHostCredentialStore,
  FilePeerHostRecordStore,
  PeerHostStore,
} from '../modules/peer-host/peer-host-store.js'
import type { PeerHostRoute } from '../../shared/contracts/peer-host.js'
import type { PeerHostRecord, PeerHostClientRecord } from '../../shared/contracts/peer-host.js'
import type { HostScope } from '../../shared/contracts/peer-host.js'
import type { AggregateHostSource } from '../modules/peer-host/peer-host-aggregate-service.js'
import { PeerHostAggregateService } from '../modules/peer-host/peer-host-aggregate-service.js'
import { CodingNsRpcError } from '../rpc-table.js'
import { PeerHostWebSocketGateway, PEER_HOST_WS_PATH, type PeerHostWsGatewayEndpoint } from '../modules/peer-host/peer-host-ws-gateway.js'
import { PeerHostWsProxyError, PeerHostWsProxyService, type PeerHostRemoteConnector } from '../modules/peer-host/host-ws-proxy-service.js'
import { createPeerHostRemoteConnector } from '../modules/peer-host/host-ws-connector.js'
import { createPeerHostRelayConnector, PeerHostReconnectManager, type PeerHostRelayTransportFactory } from '../modules/peer-host/peer-host-relay.js'
import { PEER_HOST_ERROR_CODES } from '../../shared/contracts/peer-host.js'
import { FileLanAccessDshLoginStore, resolveLoginProtectionCookieName, verifyLoginProtectionSession } from '../lan-access-dsh.js'
import { createPeerHostDiagnosticSink, toPeerHostDiagnosticSnapshot } from '../modules/peer-host/peer-host-diagnostics.js'

export interface PeerHostFeatureOptions {
  readonly stateDirectory?: string
  readonly ownerUserId?: string
  readonly encryptionKey?: Uint8Array
  readonly fetchImpl?: typeof fetch
  /** 测试或已验证的 Host-to-Host WebSocket connector；未注入时保持不可用。 */
  readonly connectRemote?: PeerHostRemoteConnector
  /** 仅允许复用已验证的 Host 侧 Relay Transport；缺省时中转保持不可用。 */
  readonly relayTransport?: PeerHostRelayTransportFactory
  /** 当前 Host/已验证 PeerHost 的摘要源；未注入时必须保持明确降级。 */
  readonly aggregateSources?: () => Promise<readonly AggregateHostSource[]>
}

/** PeerHost Host 模块；配置、握手和目标登录态只在 Host 进程内装配。 */
export function createPeerHostFeature(options: PeerHostFeatureOptions = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'peerHost',
      version: '0.1.0',
      enabledByDefault: false,
      dependencies: [],
      runtime: 'host',
      requires: [
        { capability: 'peer-host.store', required: false, fallback: 'degrade' },
        { capability: 'peer-host.handshake', required: false, fallback: 'degrade' },
        { capability: 'peer-host.http-proxy', required: false, fallback: 'degrade' },
        { capability: 'peer-host.ws-proxy', required: false, fallback: 'degrade' },
        { capability: 'peer-host.aggregate', required: false, fallback: 'degrade' },
        { capability: 'peer-host.relay-route', required: false, fallback: 'degrade' },
      ],
    },
    async start(context) {
      const stateDirectory = options.stateDirectory ?? process.env.CODINGNS4DSH_STATE_DIR?.trim() ?? join(homedir(), '.config', 'codingns4dsh')
      const ownerUserId = options.ownerUserId ?? process.env.CODINGNS4DSH_OWNER_ID?.trim() ?? 'local-host'
      const encryptionKey = options.encryptionKey ?? await loadPeerHostKey(join(stateDirectory, 'peer-host-key.bin'))
      const credentials = new EncryptedFilePeerHostCredentialStore(join(stateDirectory, 'peer-host-credentials.enc'), encryptionKey)
      const store = new PeerHostStore(ownerUserId, new FilePeerHostRecordStore(join(stateDirectory, 'peer-host-records.json')), credentials)
      const handshake = new PeerHostHandshakeService(store, credentials, {
        productId: 'CodingNS',
        pluginId: '@jingyi0605/codingns4dsh',
        pluginVersion: CODINGNS_VERSION,
        apiCompatibility: 'peer-host-v1',
        isDshVersionSupported: isDshVersionCompatible,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
      const sessions = new PeerHostSessionService(store, credentials, options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      const httpProxy = new PeerHostHttpProxyService(store, sessions, options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      const aggregate = new PeerHostAggregateService()
      const diagnostics = createPeerHostDiagnosticSink({
        enabled: process.env.CODINGNS4DSH_DEBUG === '1',
        sink: (event, snapshot) => console.info('[codingns4dsh:peer-host]', { event, ...snapshot }),
      })
      const lanConnector = options.connectRemote ?? createPeerHostRemoteConnector()
      const relayConnector = createPeerHostRelayConnector({ ...(options.relayTransport === undefined ? {} : { transport: options.relayTransport }) })
      const connector: PeerHostRemoteConnector = (record, accessToken, scope) => record.route.kind === 'relay'
        ? relayConnector(record, accessToken, scope)
        : lanConnector(record, accessToken, scope)
      const reconnectManager = new PeerHostReconnectManager({
        connect: connector,
        onState: async (snapshot) => {
          const current = await store.get(snapshot.peerHostId)
          if (current === null || snapshot.state === 'connecting' || snapshot.state === 'reconnecting' || snapshot.state === 'stopped') return
          if (snapshot.state === 'ready') {
            if (current.status !== 'ready') await store.updateStatus(snapshot.peerHostId, 'ready', null)
            return
          }
          const errorCode = snapshot.lastErrorCode === PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE
            ? PEER_HOST_ERROR_CODES.RELAY_UNAVAILABLE
            : PEER_HOST_ERROR_CODES.UNREACHABLE
          await store.updateStatus(snapshot.peerHostId, 'unreachable', errorCode)
        },
      })
      context.resources.add(() => reconnectManager.close())
      // WS 代理的客户端 socket 无法在关闭后替换远端 socket；因此这里保持一条连接一一绑定，
      // 重连 manager 仅治理显式的 Host 侧长连接消费者，避免后台重连产生孤立远端连接。
      const wsProxy = new PeerHostWsProxyService(store, sessions, connector)
      const loginStore = new FileLanAccessDshLoginStore()
      const lanSettings = context.services.settings?.get().lanAccessDsh
      const gateway = new PeerHostWebSocketGateway({
        listenHost: process.env.CODINGNS4DSH_PEER_HOST_WS_HOST?.trim() || (lanSettings?.autoStart === true ? lanSettings.listenHost : '127.0.0.1'),
        listenPort: parsePort(process.env.CODINGNS4DSH_PEER_HOST_WS_PORT),
        path: PEER_HOST_WS_PATH,
        authorizeUpgrade: (request) => authorizePeerHostUpgrade(loginStore, request),
        onConnection: (socket, request) => {
          const scope = parseWebSocketScope(request.url)
          if (scope.targetHostId === null) {
            throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 缺少目标 Host')
          }
          return wsProxy.open(scope.targetHostId, socket, scope)
        },
      })
      let wsEndpoint: PeerHostWsGatewayEndpoint | null = null
      try {
        wsEndpoint = await gateway.start()
        context.resources.add(() => gateway.close())
      } catch {
        console.error('codingns4dsh: PeerHost WebSocket 网关启动失败')
      }
      if (context.services.registerPeerHostHandshakeRoute !== undefined) {
        const unregisterHandshake = context.services.registerPeerHostHandshakeRoute(async () => Response.json({
          productId: 'CodingNS',
          pluginId: '@jingyi0605/codingns4dsh',
          pluginVersion: CODINGNS_VERSION,
          dshVersion: context.services.dshVersion ?? DSH_VERSION,
          apiCompatibility: 'peer-host-v1',
          fingerprint: process.env.CODINGNS4DSH_HOST_FINGERPRINT?.trim() || null,
          capabilities: ['peer-host.store', 'peer-host.handshake', 'peer-host.http-proxy', 'peer-host.ws-proxy', 'peer-host.aggregate'],
        }))
        context.resources.add(unregisterHandshake)
      }
      const unregister = context.services.rpc.register('peerHost', async (action, payload) => {
        const input = record(payload)
        switch (action) {
          case 'list': return (await store.list()).map(toPeerHostClientRecord)
          case 'diagnostics': {
            const snapshots = (await store.list()).map(toPeerHostDiagnosticSnapshot)
            for (const snapshot of snapshots) diagnostics.emit('peer-host.snapshot', snapshot)
            return snapshots
          }
          case 'create': return toPeerHostClientRecord(await store.create({ displayName: requiredString(input.displayName, 'displayName'), route: parseRoute(input.route) }))
          case 'update': return toPeerHostClientRecord(await store.update(requiredString(input.peerHostId, 'peerHostId'), {
            ...(input.displayName === undefined ? {} : { displayName: requiredString(input.displayName, 'displayName') }),
            ...(input.route === undefined ? {} : { route: parseRoute(input.route) }),
          }))
          case 'remove': await store.remove(requiredString(input.peerHostId, 'peerHostId')); return { removed: true }
          case 'check': return handshake.check(requiredString(input.peerHostId, 'peerHostId')).then(toPeerHostClientRecord)
          case 'reconnect': {
            const peerHostId = requiredString(input.peerHostId, 'peerHostId')
            await store.updateStatus(peerHostId, 'reconnecting', null)
            return handshake.check(peerHostId).then(toPeerHostClientRecord)
          }
          case 'login': return sessions.login(requiredString(input.peerHostId, 'peerHostId'), {
            username: requiredString(input.username, 'username'),
            password: requiredString(input.password, 'password'),
          })
          case 'logout': return sessions.logout(requiredString(input.peerHostId, 'peerHostId'))
          case 'wsEndpoint': return wsEndpoint
          case 'aggregate': {
            if (options.aggregateSources === undefined) {
              return aggregate.load([{
                hostId: 'local-host',
                targetHostId: null,
                hostLabel: '当前 Host',
                capability: { available: false, reason: '当前 Host 尚未提供可验证的工作区/会话摘要 source' },
                load: async () => [],
              }])
            }
            return aggregate.load(await options.aggregateSources())
          }
          case 'request': {
            const peerHostId = requiredString(input.peerHostId, 'peerHostId')
            const scope = parseScope(input.scope)
            return httpProxy.request(peerHostId, {
              scope,
              path: requiredString(input.path, 'path'),
              ...(input.method === undefined ? {} : { method: requiredString(input.method, 'method') }),
              ...(input.body === undefined ? {} : { body: requiredString(input.body, 'body') }),
            })
          }
          default: throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 PeerHost RPC: peerHost/${action}`)
        }
      })
      context.resources.add(unregister)
    },
  }
}

async function authorizePeerHostUpgrade(loginStore: FileLanAccessDshLoginStore, request: import('node:http').IncomingMessage): Promise<boolean> {
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin === 'string' && typeof host === 'string') {
    try {
      const originUrl = new URL(origin)
      const originHost = normalizeHostName(originUrl.hostname)
      const requestHost = normalizeHostName(readRequestHost(host))
      if (originHost !== requestHost) return false
    } catch { return false }
  }
  const config = await loginStore.read()
  if (config === null || !config.enabled || !config.scopes.lan) return true
  const token = readCookie(request.headers.cookie, resolveLoginProtectionCookieName())
  return verifyLoginProtectionSession(loginStore, token, 'lan')
}

function parseWebSocketScope(rawUrl: string | undefined): HostScope {
  if (rawUrl === undefined) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 缺少作用域')
  const url = new URL(rawUrl, 'http://peer-host.invalid')
  const allowed = new Set(['hostId', 'targetHostId', 'workspaceId', 'sessionId', 'scopeGeneration'])
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 查询参数未加入白名单')
  const hostId = requiredString(url.searchParams.get('hostId'), 'hostId')
  const targetHostId = requiredString(url.searchParams.get('targetHostId'), 'targetHostId')
  const workspaceId = requiredString(url.searchParams.get('workspaceId'), 'workspaceId')
  const sessionId = url.searchParams.get('sessionId')
  const scopeGeneration = Number(url.searchParams.get('scopeGeneration'))
  if (!Number.isSafeInteger(scopeGeneration) || scopeGeneration < 0) throw new PeerHostWsProxyError(PEER_HOST_ERROR_CODES.SCOPE_MISMATCH, 'PeerHost WebSocket 作用域 generation 无效')
  return { hostId, targetHostId, workspaceId, sessionId: sessionId?.trim() || null, scopeGeneration }
}

function readCookie(value: string | undefined, name: string): string | undefined {
  for (const item of (value ?? '').split(';')) {
    const separator = item.indexOf('=')
    if (separator > 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim()
  }
  return undefined
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0
  const port = Number(value)
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : 0
}

function normalizeHostName(value: string): string {
  const host = value.trim().toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return '127.0.0.1'
  return host
}

function readRequestHost(value: string): string {
  const host = value.trim()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 1 ? host.slice(1, end) : ''
  }
  return host.split(':')[0] ?? ''
}

async function loadPeerHostKey(path: string): Promise<Uint8Array> {
  try {
    const key = await readFile(path)
    if (key.byteLength !== 32) throw new Error('PeerHost 密钥文件长度无效')
    return key
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
    const key = randomBytes(32)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      await writeFile(path, key, { mode: 0o600, flag: 'wx' })
      return key
    } catch (writeError) {
      if (!isNodeError(writeError, 'EEXIST')) throw writeError
      const existing = await readFile(path)
      if (existing.byteLength !== 32) throw new Error('PeerHost 密钥文件长度无效')
      return existing
    }
  }
}

function parseRoute(value: unknown): PeerHostRoute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('route 必须是对象')
  const route = value as Record<string, unknown>
  if (route.kind === 'lan') return { kind: 'lan', baseUrl: requiredString(route.baseUrl, 'baseUrl'), normalizedOrigin: typeof route.normalizedOrigin === 'string' ? route.normalizedOrigin : '' }
  if (route.kind === 'relay') return { kind: 'relay', deviceId: requiredString(route.deviceId, 'deviceId'), relayEntryId: requiredString(route.relayEntryId, 'relayEntryId'), transportVersion: requiredString(route.transportVersion, 'transportVersion') }
  throw new TypeError('route.kind 无效')
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('PeerHost RPC 参数必须是对象')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 不能为空`)
  return value.trim()
}

function parseScope(value: unknown): import('../../shared/contracts/peer-host.js').HostScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('scope 必须是对象')
  const scope = value as Record<string, unknown>
  const hostId = requiredString(scope.hostId, 'scope.hostId')
  const targetHostId = scope.targetHostId === null ? null : requiredString(scope.targetHostId, 'scope.targetHostId')
  const workspaceId = requiredString(scope.workspaceId, 'scope.workspaceId')
  const sessionId = scope.sessionId === null ? null : requiredString(scope.sessionId, 'scope.sessionId')
  if (typeof scope.scopeGeneration !== 'number' || !Number.isSafeInteger(scope.scopeGeneration) || scope.scopeGeneration < 0) throw new TypeError('scope.scopeGeneration 无效')
  return { hostId, targetHostId, workspaceId, sessionId, scopeGeneration: scope.scopeGeneration }
}

export function toPeerHostClientRecord(record: PeerHostRecord): PeerHostClientRecord {
  return {
    ...record,
    fingerprint: redactFingerprint(record.fingerprint),
    route: record.route.kind === 'lan' ? { kind: 'lan' } : { kind: 'relay' },
  }
}

function redactFingerprint(value: string | null): string | null {
  if (value === null || value.length <= 12) return value
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}
