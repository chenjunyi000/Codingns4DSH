import { DshCapabilityRegistry } from './registry.js'
import type { DshCapabilityRoute, DshCapabilityRuntime } from './types.js'

/**
 * 注册 Codingns4DSH 当前实际消费的 DSH 服务能力。
 *
 * 探测只检查结构，不读取版本字符串；版本范围由 Registry 统一处理，避免
 * 业务模块在运行时继续堆叠 if (version >= ...)。
 */
export function createDshCapabilityRegistry(
  dshVersion: string,
  runtime: DshCapabilityRuntime,
  context: unknown,
): DshCapabilityRegistry {
  const registry = new DshCapabilityRegistry(dshVersion, runtime)
  const value = context as Record<string, unknown>
  const rangeLegacy = '>=0.1.5-rc.3 <=0.1.6'
  const rangeModern = '>=0.1.7-rc.2 <=0.1.7-rc.2'
  const add = <T>(route: DshCapabilityRoute<T>): void => registry.register(route)

  if (runtime === 'host') {
    add({ id: 'settings-scope', capability: 'settings.store', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => typeof (ctx as { settings?: { register?: unknown } }).settings?.register === 'function', create: (ctx) => (ctx as { settings: unknown }).settings })
    add({ id: 'config-settings', capability: 'settings.store', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => typeof (ctx as { settings?: { describe?: unknown; mutate?: unknown } }).settings?.describe === 'function' && typeof (ctx as { settings?: { mutate?: unknown } }).settings?.mutate === 'function', create: (ctx) => (ctx as { settings: unknown }).settings })
    add({ id: 'connection-rpc', capability: 'connection.rpc', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { connection?: unknown }).connection !== undefined, create: (ctx) => (ctx as { connection: unknown }).connection })
    add({ id: 'connection-rpc-peer-aware', capability: 'connection.rpc', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => (ctx as { connection?: unknown }).connection !== undefined, create: (ctx) => (ctx as { connection: unknown }).connection })
    add({ id: 'connection-peer', capability: 'connection.peer', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => (ctx as { connection?: { peer?: unknown } }).connection?.peer !== undefined, create: (ctx) => (ctx as { connection: { peer: unknown } }).connection.peer })
    add({ id: 'remote-result', capability: 'typert.remote', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { remote?: unknown }).remote !== undefined, create: (ctx) => (ctx as { remote: unknown }).remote })
    addPeerHostHostRoutes(add)
  } else {
    add({ id: 'settings-scope', capability: 'settings.store', supportedDsh: rangeLegacy, runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => typeof (ctx as { settingsScope?: { bind?: unknown } }).settingsScope?.bind === 'function', create: (ctx) => (ctx as { settingsScope: unknown }).settingsScope })
    add({ id: 'config-form', capability: 'settings.store', supportedDsh: rangeModern, runtime, priority: 20, status: 'supported', introducedIn: '0.1.7-rc.2', detect: (ctx) => typeof (ctx as { configForms?: { get?: unknown } }).configForms?.get === 'function', create: (ctx) => (ctx as { configForms: unknown }).configForms })
    add({ id: 'icon-primitives', capability: 'ui.icon.plus', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: () => value.primitives !== undefined, create: () => value.primitives })
    add({ id: 'locale-runtime', capability: 'locale.runtime', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { locale?: unknown }).locale !== undefined, create: (ctx) => (ctx as { locale: unknown }).locale })
    add({ id: 'theme-runtime', capability: 'theme.runtime', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { theme?: unknown }).theme !== undefined, create: (ctx) => (ctx as { theme: unknown }).theme })
    add({ id: 'conversation-events', capability: 'conversation.tool-call', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { uiConversation?: unknown }).uiConversation !== undefined, create: (ctx) => (ctx as { uiConversation: unknown }).uiConversation })
    add({ id: 'sidebar-right', capability: 'sidebar.right', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { sidebarRight?: unknown }).sidebarRight !== undefined, create: (ctx) => (ctx as { sidebarRight: unknown }).sidebarRight })
    add({ id: 'remote-result', capability: 'typert.remote', supportedDsh: '>=0.1.5-rc.3 <=0.1.7-rc.2', runtime, priority: 10, status: 'supported', introducedIn: '0.1.5-rc.3', detect: (ctx) => (ctx as { remote?: unknown }).remote !== undefined, create: (ctx) => (ctx as { remote: unknown }).remote })
    addPeerHostClientRoutes(add)
  }
  return registry
}

type CapabilityRouteAdder = <T>(route: DshCapabilityRoute<T>) => void

/** PeerHost Host 能力只接受显式注入的适配器，避免把普通 DSH 服务误报为已实现。 */
function addPeerHostHostRoutes(add: CapabilityRouteAdder): void {
  addPeerHostRoute(add, 'peer-host.store', 'peer-host-store', 'peerHostStore')
  addPeerHostRoute(add, 'peer-host.handshake', 'peer-host-handshake', 'peerHostHandshake')
  addPeerHostRoute(add, 'peer-host.http-proxy', 'peer-host-http-proxy', 'peerHostHttpProxy')
  addPeerHostRoute(add, 'peer-host.ws-proxy', 'peer-host-ws-proxy', 'peerHostWsProxy')
  addPeerHostRoute(add, 'peer-host.aggregate', 'peer-host-aggregate', 'peerHostAggregate')
  addPeerHostRoute(add, 'peer-host.relay-route', 'peer-host-relay-route', 'peerHostRelayRoute')
}

/** PeerHost Client 导航能力由独立 adapter 注入；未注入时由 Feature 诊断降级。 */
function addPeerHostClientRoutes(add: CapabilityRouteAdder): void {
  addPeerHostRoute(add, 'peer-host.native-navigation', 'peer-host-native-navigation-legacy', 'peerHostNativeNavigation', '>=0.1.5-rc.3 <=0.1.6', 'deprecated')
  addPeerHostRoute(add, 'peer-host.native-navigation', 'peer-host-native-navigation-modern', 'peerHostNativeNavigation', '>=0.1.7-rc.2 <=0.1.7-rc.2', 'supported', 20)
  addPeerHostRoute(add, 'peer-host.remote-web-context-fallback', 'peer-host-remote-web-context-fallback', 'peerHostRemoteWebContextFallback')
}

function addPeerHostRoute(
  add: CapabilityRouteAdder,
  capability: DshCapabilityRoute<unknown>['capability'],
  id: string,
  field: string,
  supportedDsh = '>=0.1.5-rc.3 <=0.1.7-rc.2',
  status: DshCapabilityRoute<unknown>['status'] = 'supported',
  priority = 10,
): void {
  add({
    id,
    capability,
    supportedDsh,
    runtime: capability === 'peer-host.native-navigation' || capability === 'peer-host.remote-web-context-fallback' ? 'client' : 'host',
    priority,
    status,
    introducedIn: '0.1.5-rc.3',
    detect: (context) => readPeerHostAdapter(context, field) !== undefined,
    create: (context) => readPeerHostAdapter(context, field),
  })
}

function readPeerHostAdapter(context: unknown, field: string): unknown {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return undefined
  return (context as Record<string, unknown>)[field]
}
