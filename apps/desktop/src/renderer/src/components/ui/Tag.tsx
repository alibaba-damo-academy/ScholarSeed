import { useTranslation } from 'react-i18next'
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, MouseEvent, ReactNode } from 'react'

import { semanticTagVariables, tagVariants, type SemanticTagColor, type TagClassOptions, type TagSize, type TagTone, type TagVariant } from './classes'
import { cx } from './utils'

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  color?: SemanticTagColor
  closeIcon?: ReactNode
  closeLabel?: string
  onClose?: () => void
  /**
   * 多选筛选里的选中态, 只负责视觉 (内阴影描边)。
   *
   * Tag 是 span 且内部还要放关闭按钮, 没法自己变成真正的 button, 因此 role 与
   * aria-pressed 由把它当 toggle 用的调用方声明; 纯展示的标签不传即可。
   */
  selected?: boolean
  size?: TagSize
  tone?: TagTone
  variant?: TagVariant
}

export type TagCloseProps = ButtonHTMLAttributes<HTMLButtonElement>
export { tagVariants, type TagClassOptions, type TagSize, type TagTone, type TagVariant }

const TAG_CLOSE_CLASS_NAME = [
  'vds-tag__close -me-[2px] inline-flex size-[14px] shrink-0 cursor-pointer items-center justify-center',
  'rounded-[var(--vds-radius-circle)] border-0 bg-transparent p-0 text-[var(--vds-tag-close-color)]',
  '[font:inherit] leading-none transition-[background-color,color]',
  'duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
  'hover:bg-transparent hover:text-[var(--vds-tag-close-hover-color)]',
  'focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-brand)]'
].join(' ')

export function Tag({ children, className, closeIcon = '×', closeLabel, color, onClose, selected = false, size, style, tone, variant, ...props }: TagProps): JSX.Element {
  const { t } = useTranslation('ui')
  const handleClose = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onClose?.()
  }

  return (
    <span className={tagVariants({ className, selected, size, tone, variant })} style={{ ...(color ? semanticTagVariables(color) : {}), ...style } as CSSProperties} {...props}>
      <span className="min-w-0 overflow-hidden text-ellipsis text-[var(--vds-tag-color)]">{children}</span>
      {onClose ? <TagClose aria-label={closeLabel ?? t('tag.close')} onClick={handleClose}>{closeIcon}</TagClose> : null}
    </span>
  )
}

export function TagClose({ children = '×', className, type = 'button', ...props }: TagCloseProps): JSX.Element {
  return (
    <button className={cx(TAG_CLOSE_CLASS_NAME, className)} type={type} {...props}>
      {children}
    </button>
  )
}
