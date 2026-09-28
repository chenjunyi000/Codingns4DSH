import type { CodingNsClientFeatureModule } from './types.js'
import { startPeerHostConnectionButton } from '../peer-host-connection-button.js'
import { startPeerHostManagementPanel } from '../peer-host-management-panel.js'
import { startPeerHostNativeNavigation, startPeerHostNativeSession } from '../peer-host-native-session-ui.js'
import { createPeerHostManagementApi } from '../peer-host-management-api.js'
import { createPeerHostWebSocketFactory } from '../peer-host-scoped-client.js'

/** PeerHost Client 模块的边界声明；实际连接资源在后续任务中装配。 */
export const peerHostFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'peerHost',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    requires: [
      { capability: 'peer-host.native-navigation', required: false, fallback: 'degrade' },
      { capability: 'peer-host.remote-web-context-fallback', required: false, fallback: 'degrade' },
    ],
    ui: {
      label: '管理其他 DSH Host',
      description: '管理局域网和中转 PeerHost，并按 Host 作用域聚合工作区与会话。',
      order: 50,
      defaultOpen: false,
    },
  },
  start: async (context) => {
    const controller = startPeerHostConnectionButton()
    context.resources.add(() => controller.dispose())
    const panel = startPeerHostManagementPanel({ rpc: context.services.rpc })
    context.resources.add(() => panel.dispose())
    const management = createPeerHostManagementApi(context.services.rpc)
    let endpoint = null as Awaited<ReturnType<typeof management.webSocketEndpoint>>
    let results: Awaited<ReturnType<typeof management.aggregate>> | null = null
    let aggregateError: unknown
    try {
      ;[endpoint, results] = await Promise.all([management.webSocketEndpoint(), management.aggregate()])
    } catch (error) {
      aggregateError = error
      try { endpoint = await management.webSocketEndpoint() } catch { endpoint = null }
    }
    const session = startPeerHostNativeSession({
      controller: context.services.peerHostSession,
      client: context.services.peerHost,
      ...(endpoint === null ? {} : { socketFactory: createPeerHostWebSocketFactory(endpoint) }),
    })
    context.resources.add(() => session.close())
    const navigation = startPeerHostNativeNavigation({
      controller: context.services.peerHostSession,
      onSelect: async (scope) => {
        const selected = await context.services.peerHostSession.select({
          hostId: scope.hostId,
          targetHostId: scope.targetHostId,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
        })
        await session.open(selected)
      },
    })
    context.resources.add(() => navigation.dispose())
    if (results !== null) navigation.refresh(results)
    else navigation.setStatus({
      status: 'degraded',
      reason: aggregateError instanceof Error ? aggregateError.message : 'PeerHost 聚合摘要暂不可用',
    })
  },
}
