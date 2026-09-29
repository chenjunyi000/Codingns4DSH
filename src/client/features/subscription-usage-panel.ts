import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_SUBSCRIPTION_USAGE_FIELD,
  SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS,
  SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS,
  normalizeSubscriptionUsageSettings,
} from '../../shared/contracts/config.js'
import type { FeaturePanelProps } from './types.js'
import {
  dshFieldStyle,
  dshFormRootStyle,
  dshSettingsHelpStyle,
  dshSettingsListRowStyle,
} from '../theme.js'
import { useCodingNsTranslator } from '../locale.js'

/**
 * 用量查询模块的设置面板：单次查询超时与自动查询间隔。
 *
 * 两项设置由 Host 统一下发给所有适配器读取器，Client 侧所有 Agent 共用同一个
 * 自动刷新定时器，不区分具体适配器。
 */
export function SubscriptionUsagePanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = normalizeSubscriptionUsageSettings(snapshot.value?.subscriptionUsage)
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const commit = (field: 'timeoutSecs' | 'refreshIntervalMins', nextValue: number): void => {
    void services.settings.mutate([{
      op: 'set',
      path: [CODINGNS_SUBSCRIPTION_USAGE_FIELD, field],
      value: nextValue,
    }]).then((accepted) => {
      if (!accepted) {
        notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
        return
      }
      notify({ kind: 'success', message: t('subscriptionUsage.saved') })
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
    createElement(UsageQueryNumberField, {
      label: t('subscriptionUsage.timeoutSecs'),
      value: value.timeoutSecs,
      min: SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.min,
      max: SUBSCRIPTION_USAGE_TIMEOUT_SECS_LIMITS.max,
      disabled,
      onCommit: (nextValue) => commit('timeoutSecs', nextValue),
    }),
    createElement(UsageQueryNumberField, {
      label: t('subscriptionUsage.refreshInterval'),
      help: t('subscriptionUsage.refreshIntervalHint'),
      value: value.refreshIntervalMins,
      min: SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.min,
      max: SUBSCRIPTION_USAGE_REFRESH_INTERVAL_MINS_LIMITS.max,
      disabled,
      onCommit: (nextValue) => commit('refreshIntervalMins', nextValue),
    }),
  )
}

/** 整数输入行：本地暂存文本，失焦或回车时夹取到合法区间后写回设置。 */
function UsageQueryNumberField({ label, help, value, min, max, disabled, onCommit }: {
  readonly label: string
  readonly help?: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly disabled: boolean
  readonly onCommit: (value: number) => void
}): ReactElement {
  const [text, setText] = useState(() => String(value))
  useEffect(() => { setText(String(value)) }, [value])
  const commit = (): void => {
    const parsed = Number.parseInt(text, 10)
    if (!Number.isFinite(parsed)) {
      setText(String(value))
      return
    }
    const clamped = Math.max(min, Math.min(max, parsed))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return createElement('div', { style: usageQueryNumberRowStyle },
    createElement('span', { style: { minWidth: 0 } },
      createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, label),
      help === undefined ? null : createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, help),
    ),
    createElement('input', {
      type: 'number',
      min,
      max,
      step: 1,
      'aria-label': label,
      value: text,
      disabled,
      onChange: (event: { currentTarget: { value: string } }) => setText(event.currentTarget.value),
      onBlur: commit,
      onKeyDown: (event: { key: string; currentTarget: HTMLInputElement }) => { if (event.key === 'Enter') event.currentTarget.blur() },
      style: usageQueryNumberInputStyle,
    }),
  )
}

const usageQueryNumberRowStyle = { ...dshSettingsListRowStyle, justifyContent: 'space-between' as const }
const usageQueryNumberInputStyle = { ...dshFieldStyle, flex: '0 0 auto', width: 110, minHeight: 32, boxSizing: 'border-box' as const, padding: '5px 8px', borderRadius: 6, fontSize: 13 }
