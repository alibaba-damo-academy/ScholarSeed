import React from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Card, CardContent, CardHeader, CardTitle, ProgressBar, Spinner } from '../../../components/ui'
import {
  officeWarmupProgress,
  shouldShowOfficeWarmup,
  shouldShowOfficeWarmupProgress,
  type OfficeWarmupStatus
} from './progress'

const MEBIBYTE = 1024 * 1024

export function OfficeWarmup({
  onRetry,
  status,
  visible
}: {
  onRetry: () => void
  status: OfficeWarmupStatus
  visible: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  if (!shouldShowOfficeWarmup(status, visible)) return null
  const progress = officeWarmupProgress(status)
  const detail = status.stage === 'reading'
    ? t('officeWarmup.reading', { done: status.done, total: status.total, size: (status.loadedBytes / MEBIBYTE).toFixed(1) })
    : status.stage === 'permission'
      ? t('officeWarmup.permission')
      : status.stage === 'catalog'
        ? t('officeWarmup.catalog')
        : status.stage === 'runtime'
          ? t('officeWarmup.runtime')
          : status.stage === 'error'
            ? t('officeWarmup.error')
            : t('officeWarmup.title')

  return (
    <Card
      className="pointer-events-auto fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] z-[var(--vds-z-background-task)] w-[calc(var(--vds-popover-width-md)-var(--vds-space-10))]"
      data-testid="office-font-warmup"
      variant="elevated"
    >
      <CardHeader className="pb-[var(--vds-space-2)]">
        <CardTitle className="flex items-center gap-[var(--vds-space-2)]">
          {status.stage !== 'error' && <Spinner size="sm" />}
          {status.stage === 'error' ? t('officeWarmup.error') : t('officeWarmup.title')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {shouldShowOfficeWarmupProgress(status, visible) && (
          <ProgressBar indeterminate={progress === null} label={detail} value={progress ?? undefined} />
        )}
        {status.stage === 'error' && <Button className="mt-[var(--vds-space-3)]" onClick={onRetry} size="sm" variant="secondary">{t('officeWarmup.retry')}</Button>}
      </CardContent>
    </Card>
  )
}
