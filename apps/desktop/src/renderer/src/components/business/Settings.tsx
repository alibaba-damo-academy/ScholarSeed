import type { ReactNode } from 'react'

import { Page, PageBody, PageHeader } from '../ui'
import { cx } from '../ui/utils'

interface SettingsPageProps {
  title: ReactNode
  description: ReactNode
  children: ReactNode
  className?: string
  scroll?: 'content' | 'none'
  'data-testid'?: string
}

export function SettingsPage({
  title, description, children, className, scroll = 'content', ...props
}: SettingsPageProps): React.JSX.Element {
  return (
    <Page
      {...props}
      padding="none"
      className={cx('h-full overflow-hidden pt-[var(--vds-layout-page-padding)]', className)}
    >
      <PageHeader className="shrink-0" title={title} description={description} />
      <PageBody
        scroll={scroll}
        className={cx(
          'min-h-0 flex-1 pb-[var(--vds-layout-page-padding)]',
          scroll === 'content' && 'auto-rows-max',
          scroll === 'none' && 'overflow-hidden grid-rows-[minmax(0,1fr)]'
        )}
      >
        {children}
      </PageBody>
    </Page>
  )
}
