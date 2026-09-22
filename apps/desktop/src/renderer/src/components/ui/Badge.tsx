import { useTranslation } from 'react-i18next'
import type { HTMLAttributes, MouseEvent } from 'react'

import { badgeClassName, badgeStyleClassName, type BadgeSize, type BadgeTone } from './classes'
import { cx } from './utils'

export type { BadgeSize, BadgeTone }

export type BadgeVariant = 'default' | 'destructive' | 'outline' | 'secondary' | BadgeTone

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  onRemove?: () => void
  size?: BadgeSize
  tone?: BadgeTone
  variant?: BadgeVariant
}

export interface BadgeVariantsOptions {
  className?: string
  size?: BadgeSize
  tone?: BadgeTone
  variant?: BadgeVariant
}

export function badgeVariants({ className, size = 'md', tone, variant }: BadgeVariantsOptions = {}): string {
  const resolvedTone =
    tone
    ?? (variant === 'default' ? 'brand' : variant === 'outline' ? 'neutral' : variant)
    ?? 'neutral'
  return cx(badgeClassName({ size, tone: resolvedTone }), badgeStyleClassName({ size, tone: resolvedTone }), className)
}

export function Badge({ children, className, onRemove, size = 'md', tone, variant, ...props }: BadgeProps): JSX.Element {
  const { t } = useTranslation('ui')
  const handleRemove = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    onRemove?.()
  }

  return (
    <span className={badgeVariants({ className, size, tone, variant })} {...props}>
      {children}
      {onRemove ? (
        <button
          aria-label={t('badge.remove')}
          className="vds-badge__remove ms-[var(--vds-space-1)] -me-[var(--vds-space-1)] inline-flex size-4 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none text-current [font:inherit] hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]"
          type="button"
          onClick={handleRemove}
        >
          ×
        </button>
      ) : null}
    </span>
  )
}

/** Compact decoration shared by document tabs and file/status indicators. */
export function BadgeDot({ className, tone = 'danger', ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: 'danger' | 'neutral' }): JSX.Element {
  return <i className={cx('block size-[6px] shrink-0 rounded-full', tone === 'danger' ? 'bg-[var(--vds-error-bg-default)]' : 'bg-current', className)} {...props} />
}
