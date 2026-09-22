import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { Button, Card, CardContent, CardHeader, CardTitle, IconButton, ProgressBar, Spinner } from '../../../components/ui'
import { Icon } from '../../../icons'
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
  const [dismissedError, setDismissedError] = useState(false)
  useEffect(() => {
    if (status.stage !== 'error' && dismissedError) setDismissedError(false)
  }, [dismissedError, status.stage])
  if (!shouldShowOfficeWarmup(status, visible) || (status.stage === 'error' && dismissedError)) return null
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

  const content = (
    <Card
      className={`pointer-events-auto fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] ${status.stage === 'error' ? 'z-[var(--vds-z-toast)]' : 'z-[var(--vds-z-background-task)]'} w-[calc(var(--vds-popover-width-md)-var(--vds-space-10))]`}
      data-testid="office-font-warmup"
      variant="elevated"
    >
      <CardHeader className="pb-[var(--vds-space-2)]">
        <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
          <CardTitle className="flex items-center gap-[var(--vds-space-2)]">
            {status.stage !== 'error' && <Spinner size="sm" />}
            {status.stage === 'error' ? t('officeWarmup.error') : t('officeWarmup.title')}
          </CardTitle>
          {status.stage === 'error' && (
            <IconButton
              data-testid="office-font-warmup-close"
              icon={<Icon name="close" size={14} />}
              label={t('officeDocument.close')}
              onClick={() => setDismissedError(true)}
              size="sm"
              variant="ghost"
            />
          )}
        </div>
      </CardHeader>
      <CardContent>
        {shouldShowOfficeWarmupProgress(status, visible) && (
          <ProgressBar indeterminate={progress === null} label={detail} value={progress ?? undefined} />
        )}
        {status.stage === 'error' && <Button className="mt-[var(--vds-space-3)]" onClick={onRetry} size="sm" variant="secondary">{t('officeWarmup.retry')}</Button>}
      </CardContent>
    </Card>
  )
  return status.stage === 'error' ? createPortal(content, document.body) : content
}
