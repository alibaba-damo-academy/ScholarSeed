import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
} from '../../components/ui'
import {
  listCreationRecoveries,
  preserveCreation,
  retryCreation,
  type CreationRecovery,
} from './api'

export function CreationRecoveryPanel({
  revision,
  onChanged,
}: {
  revision: number
  onChanged: () => Promise<void>
}): React.JSX.Element | null {
  const { t } = useTranslation('project')
  const [rows, setRows] = React.useState<CreationRecovery[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [confirm, setConfirm] = React.useState<CreationRecovery | null>(null)
  const [outcome, setOutcome] = React.useState<'preserved' | 'failed' | 'needsRecovery' | null>(
    null
  )
  const pending = React.useRef(false)
  const request = React.useRef(0)

  const reload = React.useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    const next = await listCreationRecoveries()
    if (current !== request.current) return
    setLoadFailed(next === null)
    if (next !== null) setRows(next)
    setLoading(false)
  }, [])

  React.useEffect(() => {
    void reload()
    return () => {
      request.current += 1
    }
  }, [reload, revision])

  const perform = async (row: CreationRecovery, preserve: boolean): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(row.operation)
    setOutcome(null)
    try {
      const result = await (preserve
        ? preserveCreation(row.operation)
        : retryCreation(row.operation))
      if (result.ok) {
        setConfirm(null)
        setOutcome(preserve ? 'preserved' : null)
        await onChanged()
      } else {
        setOutcome(
          result.error === 'project_creation_recovery_required' ? 'needsRecovery' : 'failed'
        )
      }
      await reload()
    } finally {
      pending.current = false
      setBusy(null)
    }
  }

  if (!loading && !loadFailed && rows.length === 0 && outcome === null) return null
  const message =
    outcome === 'preserved'
      ? t('recovery.preserved')
      : outcome === 'needsRecovery'
        ? t('recovery.needsRecovery')
        : t('recovery.failed')
  return (
    <section className="grid gap-[var(--vds-space-3)]" aria-label={t('recovery.title')}>
      {rows.length > 0 && (
        <Alert tone="info">
          <AlertTitle>{t('recovery.title')}</AlertTitle>
          <AlertDescription>{t('recovery.description')}</AlertDescription>
        </Alert>
      )}
      {loading && <p role="status">{t('recovery.loading')}</p>}
      {loadFailed && <p role="alert">{t('recovery.loadFailed')}</p>}
      {outcome && <p role="status">{message}</p>}
      <Button variant="secondary" disabled={busy !== null || loading} onClick={() => void reload()}>
        {t('recovery.refresh')}
      </Button>
      {rows.map((row) => (
        <Card
          key={row.operation}
          className="grid gap-[var(--vds-space-2)]"
          data-testid="creation-recovery"
        >
          <h3>{row.project.display_name}</h3>
          <p className="break-all">{row.project.dir_root}</p>
          <div className="flex flex-wrap gap-[var(--vds-space-2)]">
            <Button
              disabled={loading || busy !== null || row.outcome.state !== 'failed'}
              loading={busy === row.operation}
              onClick={() => void perform(row, false)}
            >
              {t('recovery.retry')}
            </Button>
            <Button
              variant="secondary"
              disabled={loading || busy !== null || row.outcome.state !== 'failed'}
              onClick={() => {
                setOutcome(null)
                setConfirm(row)
              }}
            >
              {t('recovery.preserve')}
            </Button>
          </div>
        </Card>
      ))}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !pending.current) setConfirm(null)
        }}
      >
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('recovery.confirmTitle', { name: confirm?.project.display_name ?? '' })}
              </AlertDialogTitle>
              <AlertDialogDescription>{t('recovery.confirmDescription')}</AlertDialogDescription>
            </AlertDialogHeader>
            <p className="break-all">{confirm?.project.dir_root}</p>
            {outcome && outcome !== 'preserved' && <p role="alert">{message}</p>}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy !== null}>{t('recovery.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy !== null}
                onClick={(event) => {
                  event.preventDefault()
                  if (confirm) void perform(confirm, true)
                }}
              >
                {t('recovery.preserve')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </section>
  )
}
