import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import { IconButton } from '../ui'
import { cx } from '../ui/utils'

// 输入区引入标签的统一视觉基线(原技能 chip 样式): 资料/文件/选区/技能等所有
// 引入方式共用同一灰底 chip, 托盘内不允许并存第二套色系或第二套尺寸。
const REF_CHIP_CLASS_NAME =
  'relative inline-flex h-[28px] max-w-full items-center gap-[8px] rounded-[8px] border border-solid border-[var(--vds-divider-default)] [background:linear-gradient(var(--vds-other-overlay-1),var(--vds-other-overlay-1)),var(--vds-surface-raised)] px-[8px] py-[4px]'
const REF_CHIP_ICON_CLASS_NAME =
  'inline-flex size-3 shrink-0 items-center justify-center text-[var(--vds-text-8)]'
const REF_CHIP_LABEL_CLASS_NAME =
  'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[14px] font-[var(--vds-fw-medium)] leading-[20px] text-[var(--vds-text-8)]'
const REF_CHIP_SUFFIX_CLASS_NAME =
  'shrink-0 text-[10px] uppercase leading-[14px] text-[var(--vds-text-tertiary)]'
const REF_CHIP_CLOSE_CLASS_NAME =
  '!size-3 !min-h-3 !min-w-3 shrink-0 !p-0 text-[var(--vds-text-tertiary)]'

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
