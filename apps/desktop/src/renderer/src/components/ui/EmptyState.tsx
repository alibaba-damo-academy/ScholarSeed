import type { HTMLAttributes, ImgHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import { emptyStateClassName } from './classes'
import { cx } from './utils'
import type { LocalizationMetadata } from './metadata'

export interface EmptyStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>, LocalizationMetadata {
  icon?: ReactNode
  variant?: 'default' | 'compact' | 'panel'
  image?: Pick<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'src'> & {
    className?: string
  }
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ action, className, description, icon, image, title, variant = 'default', ...props }, ref) => {
    const compact = variant === 'compact'
    const panel = variant === 'panel'
    const titleSource = import.meta.env.DEV ? props['data-i18n-title'] : undefined
    const descriptionSource = import.meta.env.DEV ? props['data-i18n-description'] : undefined
    return (
      <div
        className={cx(
          emptyStateClassName({ className }),
          'grid justify-items-center p-[var(--vds-empty-state-padding)] text-center text-[var(--vds-text-secondary)]',
          compact ? 'content-center gap-[var(--vds-space-4)]' : 'gap-[var(--vds-space-2)]'
        )}
        data-variant={variant}
        ref={ref}
        {...props}
      >
        {image ? (
          <img
            alt={image.alt ?? ''}
            aria-hidden={image.alt ? undefined : true}
            className={cx(
              'vds-empty-state__image h-[var(--vds-empty-state-image-height)] w-[var(--vds-empty-state-image-width)] object-contain',
              image.className
            )}
            draggable={false}
            src={image.src}
          />
        ) : null}
        {icon ? (
          <div
            aria-hidden="true"
            className={cx(
              'vds-empty-state__icon grid place-items-center text-[var(--vds-text-tertiary)]',
              panel ? 'bg-[var(--vds-surface-active)]' : 'bg-[var(--vds-surface-muted)]',
              panel
                ? 'size-[var(--vds-space-9)] rounded-[var(--vds-radius-4)] text-[length:var(--vds-icon-7)] leading-none [&>*]:size-[var(--vds-icon-7)] [&>*]:!text-[length:var(--vds-icon-7)]'
                : compact
                  ? 'size-[var(--vds-space-9)] rounded-[var(--vds-radius-4)] text-[length:var(--vds-icon-8)] leading-none [&>*]:size-[var(--vds-icon-8)] [&>*]:!text-[length:var(--vds-icon-8)]'
                  : 'size-[var(--vds-empty-state-icon-size)] rounded-[var(--vds-radius-circle)] text-[length:var(--vds-font-title)] leading-[var(--vds-lh-title)]'
            )}
          >
            {icon}
          </div>
        ) : null}
        <div
          className={cx(
            'vds-empty-state__content grid max-w-[var(--vds-empty-state-content-width)]',
            panel ? 'gap-[var(--vds-space-2)]' : 'gap-[var(--vds-space-1)]'
          )}
        >
          <div
            className={cx(
              'vds-empty-state__title',
              panel
                ? 'text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]'
                : compact
                  ? 'text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]'
                  : 'text-[length:var(--vds-font-subhead)] font-medium leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]'
            )}
            {...(titleSource ? { 'data-i18n-text': titleSource } : {})}
          >
            {title}
          </div>
          {description ? (
            <div
              className={cx(
                'vds-empty-state__description text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]',
                compact || panel
                  ? 'font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]'
                  : 'text-[var(--vds-text-secondary)]'
              )}
              {...(descriptionSource ? { 'data-i18n-text': descriptionSource } : {})}
            >
              {description}
            </div>
          ) : null}
        </div>
        {action ? (
          <div className="vds-empty-state__action inline-flex justify-center">{action}</div>
        ) : null}
      </div>
    )
  }
)

EmptyState.displayName = 'EmptyState'
