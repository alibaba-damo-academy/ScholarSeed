import type { HTMLAttributes, ReactNode } from 'react'

import { Alert, Card, Page, PageBody, PageHeader, ScrollArea } from '../ui'
import { cx } from '../ui/utils'

interface SettingsPageProps {
  title: ReactNode
  description: ReactNode
  leading?: ReactNode
  children: ReactNode
  className?: string
  scroll?: 'content' | 'none'
  descriptionAsNotice?: boolean
  overlayScroll?: boolean
  'data-testid'?: string
}

export function SettingsPage({
  title,
  description,
  leading,
  children,
  className,
  scroll = 'content',
  descriptionAsNotice = false,
  overlayScroll = false,
  ...props
}: SettingsPageProps): React.JSX.Element {
  return (
    <Page
      {...props}
      padding="none"
      className={cx(
        'font-[var(--vds-fw-regular)] [&_[data-slot=page-section]>p]:text-[length:var(--vds-font-body-lv1)] [&_[data-slot=page-section]>p]:font-[var(--vds-fw-regular)] [&_[data-slot=page-section]>p]:text-[var(--vds-text-tertiary)]',
        'h-full overflow-hidden bg-[var(--vds-bg-gray-light-default)] pt-[var(--vds-space-3)] [&_[data-slot=page-section]>h2]:text-[length:var(--vds-font-body-lv2)] [&_[data-slot=page-section]>h2]:font-[var(--vds-fw-regular)] [&_[data-slot=page-section]>h2]:text-[var(--vds-text-tertiary)] [&_.vds-card]:bg-[var(--vds-bg-white-default)] [&_.vds-card__title]:text-[length:var(--vds-font-body-lv2)] [&_.vds-card__title]:font-[var(--vds-fw-regular)] [&_.vds-card__description]:text-[length:var(--vds-font-body-lv1)] [&_.vds-card__description]:font-[var(--vds-fw-regular)] [&_.vds-card__description]:text-[var(--vds-text-tertiary)]',
        className
      )}
    >
      <PageHeader
        actions={leading}
        className={cx(
          'shrink-0 [&>div>h1]:flex [&>div>h1]:min-h-[var(--vds-control-height-md)] [&>div>h1]:items-center [&>div>h1]:text-[length:var(--vds-font-subhead)] [&>div>h1]:leading-[var(--vds-lh-subhead)] [&>div>p]:text-[length:var(--vds-font-body-lv1)] [&>div>p]:font-[var(--vds-fw-regular)] [&>div>p]:text-[var(--vds-text-tertiary)]',
          '[&>div>h1>.vds-breadcrumb]:[font-size:inherit] [&>div>h1>.vds-breadcrumb]:[line-height:inherit]',
          Boolean(leading) && 'gap-[var(--vds-space-2)] [&>div:last-child]:order-first'
        )}
        title={title}
        description={descriptionAsNotice ? undefined : description}
      />
      {descriptionAsNotice && <Alert tone="info" className="shrink-0" description={description} />}
      <PageBody
        scroll={overlayScroll ? 'none' : scroll}
        className={cx(
          'min-h-0 flex-1 pb-[var(--vds-layout-page-padding)]',
          !overlayScroll && scroll === 'content' && 'auto-rows-max',
          (overlayScroll || scroll === 'none') && 'overflow-hidden grid-rows-[minmax(0,1fr)]'
        )}
      >
        {overlayScroll ? (
          <ScrollArea overlay className="min-h-0">
            <div className="grid auto-rows-max gap-[var(--vds-space-5)]">{children}</div>
          </ScrollArea>
        ) : (
          children
        )}
      </PageBody>
    </Page>
  )
}

export function SettingsGroup({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <Card
      {...props}
      padding="none"
      className={cx(
        'overflow-hidden rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-white-default)] shadow-none [&>*+*]:border-t [&>*+*]:border-[var(--vds-divider-default)]',
        className
      )}
    >
      {children}
    </Card>
  )
}

export function SettingsField({
  title,
  description,
  variant = 'default',
  children,
}: {
  title: ReactNode
  description?: ReactNode
  variant?: 'default' | 'panel'
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)] p-[var(--vds-space-3)]">
      <div
        className={cx(
          'grid min-w-0 flex-1',
          variant === 'panel' ? 'gap-[var(--vds-space-2)]' : 'gap-[var(--vds-space-1)]'
        )}
      >
        <div
          className={cx(
            'text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]',
            variant === 'panel'
              ? 'leading-[var(--vds-control-label-line-height)]'
              : 'leading-[var(--vds-lh-body-lv2)]'
          )}
        >
          {title}
        </div>
        {description && (
          <div className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
            {description}
          </div>
        )}
      </div>
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-[var(--vds-space-2)]">
        {children}
      </div>
    </div>
  )
}
