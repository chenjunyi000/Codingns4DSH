import type { CodingNsClientFeatureModule } from './types.js'
import { SubscriptionUsagePanel } from './subscription-usage-panel.js'

/**
 * 用量查询设置模块：承载订阅/用量查询的超时与自动间隔设置。
 *
 * 它是纯设置模块，没有自己的浏览器端资源；实际查询调度由工作区会话增强
 * 读取这里的设置执行，设置对所有适配器统一生效，关闭模块后不再发起任何用量查询。
 */
export const subscriptionUsageFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'subscriptionUsage',
    version: '0.1.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    requires: [
      { capability: 'settings.store', required: true, fallback: 'disable' },
    ],
    ui: {
      label: '用量查询',
      description: '设置 Agent 订阅余额与上游用量的查询超时和自动查询间隔；关闭后不再发起用量查询。',
      labelKey: 'feature.subscriptionUsage.label',
      descriptionKey: 'feature.subscriptionUsage.description',
      order: 36,
      defaultOpen: true,
    },
  },
  start() {
    // 纯设置模块：没有浏览器端资源需要登记。
  },
  settingsPanel: SubscriptionUsagePanel,
}
