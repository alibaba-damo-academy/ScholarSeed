import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { Button, Card, CardContent, CardHeader, CardTitle, IconButton, ProgressBar, Spinner } from '../../../components/ui'
import { Icon } from '../../../icons'
import {
  officeWarmupProgress,
  shouldShowOfficeWarmup,
  shouldShowOfficeWarmupProgress,
  type OfficeWarmupFailure,
  type OfficeWarmupStatus
} from './progress'

const MEBIBYTE = 1024 * 1024

export function OfficeWarmup({
  automaticRetryAttempt,
  onDismiss,
  onRetry,
  slow,
  status,
  visible
}: {
  automaticRetryAttempt: number | null
  onDismiss: () => void
  onRetry: () => void
  slow: boolean
  status: OfficeWarmupStatus
  visible: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const [dismissedError, setDismissedError] = useState(false)
  useEffect(() => {
    if (status.stage !== 'error' && dismissedError) setDismissedError(false)
  }, [dismissedError, status.stage])
  const recovering = status.stage === 'error' && automaticRetryAttempt !== null
  if (!shouldShowOfficeWarmup(status, visible, recovering) || (status.stage === 'error' && dismissedError)) return null
  const progress = officeWarmupProgress(status)
  const progressDetail = status.stage === 'reading'
    ? t('officeWarmup.reading', { done: status.done, total: status.total, size: (status.loadedBytes / MEBIBYTE).toFixed(1) })
    : status.stage === 'permission'
      ? t('officeWarmup.permission')
      : status.stage === 'catalog'
        ? t('officeWarmup.catalog')
        : status.stage === 'runtime'
          ? t('officeWarmup.runtime')
          : t('officeWarmup.title')
  const failureText = (failure: OfficeWarmupFailure | undefined): string => {
    if (failure === 'font-permission') return t('officeWarmup.failures.fontPermission')
    if (failure === 'font-catalog') return t('officeWarmup.failures.fontCatalog')
    if (failure === 'font-read') return t('officeWarmup.failures.fontRead')
    if (failure === 'runtime-assets') return t('officeWarmup.failures.runtimeAssets')
    if (failure === 'runtime-initialization') return t('officeWarmup.failures.runtimeInitialization')
    return t('officeWarmup.failures.runtimeExecution')
  }
  const message = recovering
    ? t('officeWarmup.recovering', { attempt: automaticRetryAttempt })
    : status.stage === 'error'
      ? failureText(status.error)
      : slow
        ? t('officeWarmup.slow')
        : null
  const title = recovering
    ? t('officeWarmup.recoveringTitle')
    : status.stage === 'error'
      ? t('officeWarmup.errorTitle')
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
            {(status.stage !== 'error' || recovering) && <Spinner size="sm" />}
            {title}
          </CardTitle>
          <IconButton
            data-testid="office-font-warmup-close"
            icon={<Icon name="close" size={14} />}
            label={t('officeDocument.close')}
            onClick={() => status.stage === 'error' && !recovering ? setDismissedError(true) : onDismiss()}
            size="sm"
            variant="ghost"
          />
        </div>
      </CardHeader>
      <CardContent>
        {shouldShowOfficeWarmupProgress(status, visible) && (
          <ProgressBar indeterminate={progress === null} label={progressDetail} value={progress ?? undefined} />
        )}
        {message && <p className="m-0 mt-[var(--vds-space-2)] text-xs text-[var(--vds-text-secondary)]">{message}</p>}
        {status.stage === 'error' && !recovering && <Button className="mt-[var(--vds-space-3)]" onClick={onRetry} size="sm" variant="secondary">{t('officeWarmup.retry')}</Button>}
      </CardContent>
    </Card>
  )
  return status.stage === 'error' ? createPortal(content, document.body) : content
}
