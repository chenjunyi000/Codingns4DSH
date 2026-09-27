import type { CodingNsClientFeatureModule } from './types.js'
import { startFileManagementDom } from '../file-management-dom.js'

/** 文件管理增强：只在模块启用期间挂载右键菜单和文本编辑器。 */
export const fileManagementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'fileManagement',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '文件管理增强',
      description: '为 DSH 文件侧栏增加操作菜单，并支持编辑和保存常用文本文件。',
      labelKey: 'feature.fileManagement.label',
      descriptionKey: 'feature.fileManagement.description',
      order: 40,
      defaultOpen: true,
    },
  },
  start(context) {
    context.resources.add(startFileManagementDom(context.services.rpc))
  },
}
