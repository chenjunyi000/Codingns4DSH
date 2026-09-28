import { createElement } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_FILE_MANAGEMENT_FIELD,
  DEFAULT_FILE_MANAGEMENT_SETTINGS,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import {
  dshFormRootStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
  dshThemeColor,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/** 文件管理增强的独立能力开关面板。 */
export function FileManagementPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = { ...DEFAULT_FILE_MANAGEMENT_SETTINGS, ...snapshot.value?.fileManagement }
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable

  const updateSetting = (field: keyof typeof DEFAULT_FILE_MANAGEMENT_SETTINGS, nextValue: boolean): void => {
    void services.settings.mutate([{
      op: 'set',
      path: [CODINGNS_FILE_MANAGEMENT_FIELD, field],
      value: nextValue,
    }]).then((accepted) => {
      if (!accepted) {
        notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
        return
      }
      notify({ kind: 'success', message: t('fileManagement.saved') })
    }).catch((cause: unknown) => {
      notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  return createElement('div', {
    'aria-disabled': disabled,
    style: {
      ...dshFormRootStyle,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      opacity: disabled ? 0.5 : 1,
      pointerEvents: disabled ? 'none' : 'auto',
    },
  },
    createSwitchRow(
      t('fileManagement.menuEnhancement'),
      t('fileManagement.menuEnhancementDescription'),
      value.menuEnhancement,
      disabled,
      (next) => updateSetting('menuEnhancement', next),
    ),
    createSwitchRow(
      t('fileManagement.fileEditor'),
      t('fileManagement.fileEditorDescription'),
      value.fileEditor,
      disabled,
      (next) => updateSetting('fileEditor', next),
    ),
    createSwitchRow(
      t('fileManagement.sessionChangedFiles'),
      t('fileManagement.sessionChangedFilesDescription'),
      value.sessionChangedFiles,
      disabled,
      (next) => updateSetting('sessionChangedFiles', next),
    ),
  )
}

function createSwitchRow(
  label: string,
  description: string,
  checked: boolean,
  disabled: boolean,
  onChange: (next: boolean) => void,
): ReactElement {
  return createElement('label', { style: dshSettingsListRowStyle },
    createElement('span', { style: { minWidth: 0 } },
      createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, label),
      createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, description),
    ),
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked,
      disabled,
      onChange: (event: { currentTarget: { checked: boolean } }) => onChange(event.currentTarget.checked),
      style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
    }),
  )
}
