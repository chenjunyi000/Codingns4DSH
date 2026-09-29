import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

type IconComponent = ComponentType<{ readonly size?: number; readonly className?: string }>
type PrimitiveExports = typeof primitives & {
  readonly IconPlusOutlineRegular?: IconComponent
  readonly IconPlusOutlineMedium?: IconComponent
  readonly IconChevronDownOutlineRegular?: IconComponent
  readonly IconChevronDownOutlineMedium?: IconComponent
  readonly IconPlusOutline16?: IconComponent
  readonly IconChevronDownOutline14?: IconComponent
}

const unavailableIcon: IconComponent = () => null

/**
 * 图标导出兼容层。0.1.7 可能改名为 Regular/Medium，运行时优先使用新导出，
 * 旧导出仍作为回退；业务组件不再直接判断 DSH 版本。
 */
export function resolvePlusIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconPlusOutlineRegular ?? value.IconPlusOutlineMedium ?? value.IconPlusOutline16 ?? unavailableIcon
}

export function resolveChevronDownIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconChevronDownOutlineRegular ?? value.IconChevronDownOutlineMedium ?? value.IconChevronDownOutline14 ?? unavailableIcon
}
