import React from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import {
  Alert, AlertDescription, Button, AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction
} from '../ui'
import {
  fetchResourceReviewConflict, reconcileResourceReview, reviewConflictMatches,
  type ResourcePending, type ResourceReviewConflict, type ResourceReviewResolution
} from '../../contracts/resources'
import { resourceEditorHasChanges, reconcileResourceEditors } from '../../contracts/workbench'
import { useApp } from '../../store'

type Notice = { key: 'conflictNotice.saveFirst' | 'conflictNotice.unavailable' | 'conflictNotice.editorChanged' | 'conflictNotice.draftChanged' | 'conflictNotice.reviewChanged' | 'conflictNotice.editorWarning' | 'conflictNotice.resolved' | 'conflictNotice.refreshFailed' | 'conflictNotice.failed'; detail?: string }

interface Confirmation { preview: ResourceReviewConflict; action: ResourceReviewResolution; key: string }

/** Explicitly reconcile external bytes without closing review or creating a version. */
export function ReviewConflict({ project, path, pending, disabled = false, onResolved }: {
  project: string; path: string; pending: ResourcePending; disabled?: boolean
  onResolved: () => Promise<unknown>
}): React.JSX.Element | null {
  const { act } = useApp()
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [confirmation, setConfirmation] = React.useState<Confirmation | null>(null)
  const inFlight = React.useRef(false)
  const generation = React.useRef(0)
  React.useEffect(() => {
    generation.current += 1
    setConfirmation(null)
    return () => { generation.current += 1 }
  }, [project, path, pending.file_id, pending.revision, pending.review?.id])
  const review = pending.review
  if (!review) return null
  const editorBusy = (): boolean => resourceEditorHasChanges(project, pending.file_id,
    [path, review.base.path, review.candidate.path])

  const prepare = async (action: ResourceReviewResolution): Promise<void> => {
    if (inFlight.current || disabled) return
    if (editorBusy()) { setNotice({ key: 'conflictNotice.saveFirst' }); return }
    inFlight.current = true
    setBusy(true)
    setNotice(null)
    const epoch = generation.current
    try {
      const preview = await fetchResourceReviewConflict(project, pending.file_id)
      if (epoch !== generation.current) return
      if (!preview || !reviewConflictMatches(preview, pending)) {
        setNotice({ key: 'conflictNotice.unavailable' }); return
      }
      if (editorBusy()) { setNotice({ key: 'conflictNotice.editorChanged' }); return }
      setConfirmation({ preview, action, key: crypto.randomUUID() })
    } finally { inFlight.current = false; setBusy(false) }
  }

  const confirm = async (): Promise<void> => {
    if (!confirmation || inFlight.current || disabled) return
    if (editorBusy()) { setNotice({ key: 'conflictNotice.draftChanged' }); return }
    if (!reviewConflictMatches(confirmation.preview, pending)) {
      setNotice({ key: 'conflictNotice.reviewChanged' }); return
    }
    inFlight.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await reconcileResourceReview(project, pending.file_id,
        confirmation.action, confirmation.preview.token, confirmation.key)
      if (!result.ok) {
        setNotice({ key: 'conflictNotice.failed', detail: result.error ?? undefined })
        return
      }
      const target = confirmation.action === 'keep_current' ? confirmation.preview.disk : review.candidate
      setConfirmation(null)
      const editors = await reconcileResourceEditors(project, [{
        fileId: pending.file_id, previousPath: path, path: target.path, state: target.state
      }])
      setNotice(editors.conflicted.length || editors.failed.length
        ? { key: 'conflictNotice.editorWarning' }
        : { key: 'conflictNotice.resolved' })
      await act.reloadResourceTree()
      await onResolved()
    } catch { setNotice({ key: 'conflictNotice.refreshFailed' }) }
    finally { inFlight.current = false; setBusy(false) }
  }

  return <div data-testid="review-conflict">
    {notice && <Alert tone="warning" role="status"><AlertDescription truncate={false}>{t(notice.key)}{notice.detail && <pre>{notice.detail}</pre>}</AlertDescription></Alert>}
    <div className="vds-version-actions">
      <Button size="sm" variant="secondary" disabled={busy || disabled} onClick={() => void prepare('keep_current')}>{t('conflict.keep')}</Button>
      <Button size="sm" variant="secondary" disabled={busy || disabled} onClick={() => void prepare('restore_candidate')}>{t('conflict.restore')}</Button>
    </div>
    {confirmation && createPortal(<AlertDialog open onOpenChange={(open) => { if (!open && !busy) setConfirmation(null) }}>
      <AlertDialogContent><AlertDialogHeader>
        <AlertDialogTitle>{confirmation.action === 'keep_current' ? t('conflict.keepTitle') : t('conflict.restoreTitle')}</AlertDialogTitle>
        <AlertDialogDescription><span>{confirmation.preview.disk.path}</span>
          {confirmation.action === 'keep_current'
            ? t('conflict.keepDescription')
            : t('conflict.restoreDescription')}
          {confirmation.preview.disk.state === 'tombstone' && t('conflict.deleted')}{t('conflict.noVersion')}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {notice && <div role="status"><p>{t(notice.key)}</p>{notice.detail && <pre>{notice.detail}</pre>}</div>}
      <AlertDialogFooter>
        <AlertDialogCancel aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault() }}>{uiText('cancel')}</AlertDialogCancel>
        <AlertDialogAction aria-disabled={busy || disabled} onClick={(event) => { event.preventDefault(); void confirm() }}>
          {busy ? t('conflict.busy') : t('conflict.confirm')}
        </AlertDialogAction>
      </AlertDialogFooter></AlertDialogContent>
    </AlertDialog>, document.body)}
  </div>
}
