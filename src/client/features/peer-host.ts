import type { CodingNsClientFeatureModule } from './types.js'
import { startPeerHostConnectionButton } from '../peer-host-connection-button.js'
import { startPeerHostManagementPanel } from '../peer-host-management-panel.js'

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
  start: (context) => {
    const controller = startPeerHostConnectionButton()
    context.resources.add(() => controller.dispose())
    const panel = startPeerHostManagementPanel({ rpc: context.services.rpc })
    context.resources.add(() => panel.dispose())
  },
}
