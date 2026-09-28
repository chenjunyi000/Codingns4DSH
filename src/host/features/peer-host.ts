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
import { CodingNsRpcError } from '../rpc-table.js'

export interface PeerHostFeatureOptions {
  readonly stateDirectory?: string
  readonly ownerUserId?: string
  readonly encryptionKey?: Uint8Array
  readonly fetchImpl?: typeof fetch
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
