import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import { IconButton } from '../ui'
import { cx } from '../ui/utils'

// 输入区引入标签的统一视觉基线(原技能 chip 样式): 资料/文件/选区/技能等所有
// 引入方式共用同一灰底 chip, 托盘内不允许并存第二套色系或第二套尺寸。
const REF_CHIP_CLASS_NAME =
  'relative inline-flex h-[var(--vds-control-height-sm)] max-w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-divider-default)] [background:linear-gradient(var(--vds-other-overlay-1),var(--vds-other-overlay-1)),var(--vds-surface-raised)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]'
const REF_CHIP_ICON_CLASS_NAME =
  'inline-flex size-[var(--vds-icon-6)] shrink-0 items-center justify-center text-[var(--vds-text-primary)]'
const REF_CHIP_LABEL_CLASS_NAME =
  'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-primary)]'
const REF_CHIP_SUFFIX_CLASS_NAME =
  'shrink-0 text-[length:var(--vds-font-caption)] uppercase leading-[var(--vds-ref-chip-suffix-line-height)] text-[var(--vds-text-tertiary)]'
const REF_CHIP_CLOSE_CLASS_NAME =
  '!size-[var(--vds-icon-6)] !min-h-[var(--vds-icon-6)] !min-w-[var(--vds-icon-6)] shrink-0 !p-0 text-[var(--vds-text-tertiary)]'

export function ComposerRefChip({
  icon,
  label,
  suffix,
  closeLabel,
  onClose,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  icon?: React.ReactNode
  label: React.ReactNode
  suffix?: React.ReactNode
  closeLabel?: string
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useTranslation('ui')
  return (
    <div className={cx(REF_CHIP_CLASS_NAME, className)} {...props}>
      {icon ? <span className={REF_CHIP_ICON_CLASS_NAME}>{icon}</span> : null}
      <span className={REF_CHIP_LABEL_CLASS_NAME}>{label}</span>
      {suffix ? <span className={REF_CHIP_SUFFIX_CLASS_NAME}>{suffix}</span> : null}
      {onClose ? (
        <IconButton
          type="button"
          size="sm"
          variant="ghost"
          className={REF_CHIP_CLOSE_CLASS_NAME}
          label={closeLabel ?? t('tag.close')}
          icon={<Icon name="close" size={12} />}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        />
      ) : null}
    </div>
  )
}
