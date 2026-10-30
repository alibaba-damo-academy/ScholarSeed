import { useState, useSyncExternalStore, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ProgressBar,
  ScrollArea,
  useToast,
} from '../../components/ui'
import {
  METADATA_BATCH_STATUS,
  METADATA_RETRY_STATUSES,
  type MetadataEntry,
  type MetadataStatus,
} from './batch'
import { metadataBatch } from './synchronization'

const PROGRESS_PERCENT = 100
const STATUS_KEYS = {
  pending: 'batchSync.pending',
  running: 'batchSync.running',
  success: 'batchSync.success',
  missing: 'batchSync.missing',
  failed: 'batchSync.failed',
  quota: 'batchSync.quota',
  skipped: 'batchSync.skipped',
  deferred: 'batchSync.deferred',
  cancelled: 'batchSync.cancelled',
} as const satisfies Record<MetadataStatus, string>
const RESULT_STATUSES = [
  METADATA_BATCH_STATUS.success,
  METADATA_BATCH_STATUS.missing,
  METADATA_BATCH_STATUS.failed,
  METADATA_BATCH_STATUS.quota,
  METADATA_BATCH_STATUS.skipped,
  METADATA_BATCH_STATUS.deferred,
  METADATA_BATCH_STATUS.cancelled,
]

interface MetadataBatchProps {
  entries: readonly Pick<MetadataEntry, 'id' | 'title'>[]
  projectId?: string
  triggerVariant?: ComponentProps<typeof Button>['variant']
}

export function MetadataBatch(props: MetadataBatchProps): React.JSX.Element {
  return <MetadataBatchView key={props.projectId} {...props} />
}

function MetadataBatchView({
  entries,
  projectId,
  triggerVariant = 'secondary',
}: MetadataBatchProps): React.JSX.Element | null {
  const { t } = useTranslation('literature')
  const { toast } = useToast()
  const snapshot = useSyncExternalStore(metadataBatch.subscribe, metadataBatch.getSnapshot)
  const hasBatch = snapshot.projectId === projectId && snapshot.entries.length > 0
  const [open, setOpen] = useState(false)
  const completed = snapshot.entries.filter(
    (entry) =>
      entry.status !== METADATA_BATCH_STATUS.pending &&
      entry.status !== METADATA_BATCH_STATUS.running
  ).length
  const retryable = snapshot.entries.some((entry) => METADATA_RETRY_STATUSES.has(entry.status))
  const start = (): void => {
    const current = metadataBatch.getSnapshot()
    if (current.running && current.projectId !== projectId) {
      toast({ tone: 'info', description: <MetadataBatchConflict /> })
      return
    }
    void metadataBatch.start(entries, projectId)
    setOpen(true)
  }
  if (!entries.length && !hasBatch) return null
  return (
    <>
      <Button
        size="md"
        variant={triggerVariant}
        icon={<RefreshCw />}
        onClick={() => {
          if (!hasBatch) start()
          else setOpen(true)
        }}
      >
        {t(
          hasBatch && snapshot.running
            ? 'batchSync.progressTitle'
            : hasBatch
              ? 'batchSync.resultTitle'
              : 'batchSync.title'
        )}
      </Button>
      <Dialog open={open && hasBatch} onOpenChange={setOpen}>
        <DialogContent className="!flex max-h-[calc(100dvh-var(--vds-space-8))] !flex-col !gap-[var(--vds-space-4)] !overflow-hidden whitespace-normal">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t('batchSync.title')}</DialogTitle>
            <DialogDescription>{t('batchSync.description')}</DialogDescription>
          </DialogHeader>
          <div className="min-w-0 shrink-0" aria-live="polite">
            <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]">
              {t(
                snapshot.cancelling && snapshot.running
                  ? 'batchSync.cancelling'
                  : snapshot.running
                    ? 'batchSync.progress'
                    : 'batchSync.completed',
                { completed, total: snapshot.entries.length }
              )}
            </p>
            <ProgressBar
              value={
                snapshot.entries.length
                  ? (completed / snapshot.entries.length) * PROGRESS_PERCENT
                  : 0
              }
              label={t('batchSync.progressTitle')}
            />
            <div className="mt-[var(--vds-space-3)] flex flex-wrap gap-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              {RESULT_STATUSES.map((status) => (
                <span key={status}>
                  {t(STATUS_KEYS[status])}:{' '}
                  {snapshot.entries.filter((entry) => entry.status === status).length}
                </span>
              ))}
            </div>
          </div>
          <ScrollArea
            className="flex min-h-0 min-w-0 max-h-[var(--vds-dialog-list-max-height)] flex-1 flex-col overflow-hidden"
            viewportClassName="min-h-0 min-w-0 w-full flex-1"
          >
            <div className="grid gap-[var(--vds-space-2)]">
              {snapshot.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex min-w-0 items-center gap-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)]"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[var(--vds-text-primary)]"
                    title={entry.title}
                  >
                    {entry.title}
                  </span>
                  <span className="shrink-0 text-[var(--vds-text-secondary)]">
                    {t(STATUS_KEYS[entry.status])}
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter className="shrink-0 !flex-wrap">
            {snapshot.running ? (
              <Button
                variant="secondary"
                disabled={snapshot.cancelling}
                onClick={() => metadataBatch.cancel()}
              >
                {t('batchSync.cancel')}
              </Button>
            ) : (
              <>
                {retryable ? (
                  <Button variant="secondary" onClick={() => void metadataBatch.retry()}>
                    {t('batchSync.retry')}
                  </Button>
                ) : null}
                {entries.length ? (
                  <Button variant="secondary" onClick={start}>
                    {t('batchSync.startSelected', { count: entries.length })}
                  </Button>
                ) : null}
              </>
            )}
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('batchSync.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function MetadataBatchConflict(): React.JSX.Element {
  const { t } = useTranslation('literature')
  return <>{t('batchSync.otherScopeRunning')}</>
}
