import type { HTMLAttributes, ImgHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'

import { emptyStateClassName } from './classes'
import { cx } from './utils'
import type { LocalizationMetadata } from './metadata'

export interface EmptyStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>,
    LocalizationMetadata {
  icon?: ReactNode
  image?: Pick<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'src'> & {
    className?: string
  }
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ action, className, description, icon, image, title, ...props }, ref) => {
    const titleSource = import.meta.env.DEV
      ? props['data-i18n-title']
      : undefined
    const descriptionSource = import.meta.env.DEV
      ? props['data-i18n-description']
      : undefined
    return (
      <div
        className={cx(
          emptyStateClassName({ className }),
          'grid justify-items-center gap-[var(--vds-space-2)] p-[var(--vds-empty-state-padding)] text-center text-[var(--vds-text-secondary)]'
        )}
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
            className="vds-empty-state__icon grid size-[var(--vds-empty-state-icon-size)] place-items-center rounded-[var(--vds-radius-circle)] bg-[var(--vds-surface-muted)] text-[length:var(--vds-font-title)] leading-[var(--vds-lh-title)] text-[var(--vds-text-tertiary)]"
          >
            {icon}
          </div>
        ) : null}
        <div className="vds-empty-state__content grid max-w-[var(--vds-empty-state-content-width)] gap-[var(--vds-space-1)]">
          <div
            className="vds-empty-state__title text-[length:var(--vds-font-subhead)] font-medium leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]"
            {...(titleSource ? { 'data-i18n-text': titleSource } : {})}
          >
            {title}
          </div>
          {description ? (
            <div
              className="vds-empty-state__description text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]"
              {...(descriptionSource
                ? { 'data-i18n-text': descriptionSource }
                : {})}
            >
              {description}
            </div>
          ) : null}
        </div>
        {action ? (
          <div className="vds-empty-state__action inline-flex justify-center">
            {action}
          </div>
        ) : null}
      </div>
    )
  }
)

EmptyState.displayName = 'EmptyState'
