import type { CodingNsClientFeatureModule } from './types.js'
import { DEFAULT_FILE_MANAGEMENT_SETTINGS } from '../../shared/contracts/config.js'
import { startFileManagementDom } from '../file-management-dom.js'
import { FileManagementPanel } from './file-management-panel.js'
import { registerSessionChangedFilesView } from '../session-changed-files-view.js'

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
    const readOptions = () => {
      const value = { ...DEFAULT_FILE_MANAGEMENT_SETTINGS, ...context.services.settings.getSnapshot().value?.fileManagement }
      return { menuEnhancement: value.menuEnhancement, fileEditor: value.fileEditor }
    }
    const dom = startFileManagementDom(context.services.rpc, readOptions())
    let disposeSessionView: (() => void) | undefined
    const syncSessionView = (): void => {
      const value = { ...DEFAULT_FILE_MANAGEMENT_SETTINGS, ...context.services.settings.getSnapshot().value?.fileManagement }
      if (value.sessionChangedFiles && disposeSessionView === undefined) {
        disposeSessionView = registerSessionChangedFilesView(context.services.uiContext, context.services.rpc, context.services.remote)
      } else if (!value.sessionChangedFiles && disposeSessionView !== undefined) {
        disposeSessionView()
        disposeSessionView = undefined
      }
    }
    syncSessionView()
    const unsubscribe = context.services.settings.subscribe(() => {
      dom.setOptions(readOptions())
      syncSessionView()
    })
    context.resources.add(unsubscribe)
    context.resources.add(dom.dispose)
    context.resources.add(() => disposeSessionView?.())
  },
  settingsPanel: FileManagementPanel,
}
