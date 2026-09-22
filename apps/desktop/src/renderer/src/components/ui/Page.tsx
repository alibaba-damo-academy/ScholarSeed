import { forwardRef, useId } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'

import { cx } from './utils'

export interface PageProps extends HTMLAttributes<HTMLDivElement> {
  /** Reading constrains prose/forms; full leaves width to the hosting pane. */
  width?: 'full' | 'reading'
  /** none is for a host that already owns its gutters (for example settings). */
  padding?: 'default' | 'none'
}

export const Page = forwardRef<HTMLDivElement, PageProps>(
  ({ width = 'full', padding = 'default', className, ...props }, ref) => (
    <div
      {...props}
      ref={ref}
      data-slot="page"
      className={cx(
        'mx-auto flex min-h-0 w-full min-w-0 flex-col gap-[var(--vds-layout-section-gap)] font-[family-name:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]',
        width === 'reading' && 'max-w-[var(--vds-layout-reading-width)]',
        padding === 'default' && 'p-[var(--vds-layout-page-padding)]',
        className
      )}
    />
  )
)
Page.displayName = 'Page'

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** A nested page can use h2 instead of introducing another top-level heading. */
  headingLevel?: 1 | 2
}

export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(
  ({ title, description, actions, headingLevel = 1, className, ...props }, ref) => {
    const Heading = headingLevel === 1 ? 'h1' : 'h2'
    return (
      <header {...props} ref={ref} data-slot="page-header" className={cx('flex min-w-0 flex-wrap items-start justify-between gap-[var(--vds-layout-section-gap)]', className)}>
        <div className="grid min-w-0 flex-1 gap-[var(--vds-layout-control-gap)]">
          <Heading className="m-0 break-words text-[length:var(--vds-font-title)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-title)]">{title}</Heading>
          {description && <p className="m-0 break-words text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">{description}</p>}
        </div>
        {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-[var(--vds-layout-control-gap)]">{actions}</div>}
      </header>
    )
  }
)
PageHeader.displayName = 'PageHeader'

export interface PageBodyProps extends HTMLAttributes<HTMLDivElement> {
  /** content needs a height-constrained flex host; default inherits the host scroll. */
  scroll?: 'none' | 'content'
}
export const PageBody = forwardRef<HTMLDivElement, PageBodyProps>(
  ({ scroll = 'none', className, ...props }, ref) => (
    <div {...props} ref={ref} data-slot="page-body" className={cx(
      'grid min-h-0 min-w-0 content-start gap-[var(--vds-layout-section-gap)]',
      scroll === 'content' && 'flex-1 overflow-auto [scrollbar-gutter:stable]',
      className
    )} />
  )
)
PageBody.displayName = 'PageBody'

export interface PageSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode
  description?: ReactNode
}
export const PageSection = forwardRef<HTMLElement, PageSectionProps>(
  ({ title, description, children, className, ...props }, ref) => {
    const titleId = useId()
    return (
      <section aria-labelledby={title ? titleId : undefined} {...props} ref={ref} data-slot="page-section" className={cx('grid min-w-0 gap-[var(--vds-layout-control-gap)]', className)}>
        {title && <h2 id={titleId} className="m-0 break-words text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)]">{title}</h2>}
        {description && <p className="m-0 break-words text-[var(--vds-text-secondary)]">{description}</p>}
        {children}
      </section>
    )
  }
)
PageSection.displayName = 'PageSection'
