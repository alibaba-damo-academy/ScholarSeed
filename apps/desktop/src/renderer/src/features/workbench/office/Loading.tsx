import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, ProgressBar, Spinner } from '../../../components/ui'
import { isOfficeWarmupSlow, officeWarmupProgress } from './progress'
import { OFFICE_PROGRESS_TICK_MS, officeRetrySeconds, type OfficeRecovery } from './recovery'

const FAILURE_LABELS = {
  'font-permission': 'officeWarmup.failures.fontPermission',
  'font-catalog': 'officeWarmup.failures.fontCatalog',
  'font-read': 'officeWarmup.failures.fontRead',
  'runtime-assets': 'officeWarmup.failures.runtimeAssets',
  'runtime-initialization': 'officeWarmup.failures.runtimeInitialization',
  'runtime-execution': 'officeWarmup.failures.runtimeExecution',
  'warmup-timeout': 'officeWarmup.failures.warmupTimeout',
  'document-load': 'officeError.document_unavailable'
} as const
const BYTES_PER_MIB = 1024 * 1024

export function OfficeLoading({ recovery, startedAt, onRetry }: {
  recovery: OfficeRecovery
  startedAt: number
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const [now, setNow] = useState(performance.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), OFFICE_PROGRESS_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  const { status, attempt, retryAt } = recovery
  const failed = status.stage === 'error'
  const waiting = retryAt !== null
  const progress = officeWarmupProgress(status)
  const stages = {
    permission: t('officeWarmup.permission'),
    catalog: t('officeWarmup.catalog'),
    reading: t('officeWarmup.reading', { done: status.done, total: status.total, size: (status.loadedBytes / BYTES_PER_MIB).toFixed(1) }),
    runtime: t('officeWarmup.runtime'),
    ready: t('officeDocument.allocating'),
    error: status.error ? t(FAILURE_LABELS[status.error]) : t('officeWarmup.errorTitle')
  }
  return <div
    className="absolute inset-0 flex flex-col items-center justify-center gap-[var(--vds-space-3)] bg-[var(--vds-bg-page)] p-[var(--vds-space-5)] text-center text-[var(--vds-text-secondary)]"
    data-testid="office-loading"
    data-stage={status.stage}
    data-attempt={attempt}
    data-retry-pending={waiting}
  >
    {(!failed || waiting) && <Spinner />}
    <div className="flex max-w-full flex-col gap-[var(--vds-space-2)]" role="status" aria-live="polite">
      <strong>{failed && !waiting ? t('officeWarmup.errorTitle') : attempt > 0 || waiting ? t('officeWarmup.recoveringTitle') : t('officeWarmup.title')}</strong>
      {(status.stage !== 'reading' || progress === null) && <span>{stages[status.stage]}</span>}
      {waiting ? <span>{t('officeWarmup.retryCountdown', { attempt: attempt + 1, seconds: officeRetrySeconds(recovery, performance.now()) })}</span>
        : attempt > 0 && !failed ? <span>{t('officeWarmup.recovering', { attempt })}</span> : null}
      {progress !== null && status.stage === 'reading' && <ProgressBar value={progress} label={stages.reading} />}
      {isOfficeWarmupSlow(status, now - startedAt) && <span>{t('officeWarmup.slow')}</span>}
    </div>
    {failed && <Button onClick={onRetry} data-testid="office-loading-retry">{t('officeWarmup.retry')}</Button>}
  </div>
}
