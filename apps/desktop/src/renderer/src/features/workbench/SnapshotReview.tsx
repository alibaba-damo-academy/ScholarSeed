import React from 'react'
import { useTranslation } from 'react-i18next'
import { ReviewConflict } from '../../components/business/ReviewConflict'

import {
  Alert,
  AlertDescription,
  Button,
  AlertDialog,
  AlertDialogPortal,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '../../components/ui'
import {
  decideResourceReview,
  fetchReviewBaseline,
  fetchVersionCapability,
  sealResourceSnapshot,
  snapshotSaveMessage,
  type ResourceCapability,
  type ResourceReviewAction,
} from '../../contracts/resources'
import type { ResourceHistoryTarget } from '../../contracts/workbench'
import { useApp } from '../../store'
import {
  resourceEditorHasChanges,
  reconcileResourceEditors,
  useWorkspaceController,
  type DocumentSession,
} from './workspace'

type Notice = {
  key:
    | 'snapshotNotice.saveFailed'
    | 'snapshotNotice.saveFirst'
    | 'snapshotNotice.changed'
    | 'snapshotNotice.draftChanged'
    | 'snapshotNotice.restored'
    | 'snapshotNotice.failed'
    | 'snapshotNotice.unreadable'
    | 'snapshotNotice.exportFailed'
    | 'snapshotNotice.operationFailed'
  detail?: string
}

export function SnapshotReview({
  session,
  file,
  onResolved,
}: {
  session?: DocumentSession
  file?: ResourceHistoryTarget
  onResolved: () => Promise<unknown>
}): React.JSX.Element | null {
  const { act } = useApp()
  const { t } = useTranslation('workbench')
  const { t: uiText } = useTranslation('ui')
  const { t: resourceText } = useTranslation('resources')
  const workspace = useWorkspaceController()
  const [capability, setCapability] = React.useState<ResourceCapability | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [confirmReject, setConfirmReject] = React.useState(false)
  const request = React.useRef<{ signature: string; key: string } | null>(null)
  const project =
    file?.project ??
    (session?.source.kind === 'project' ? (session.source.project ?? 'current') : null)
  const path = file?.path ?? session?.source.path ?? ''
  React.useEffect(() => {
    let active = true
    if (project)
      void fetchVersionCapability(project, path).then((value) => {
        if (active) setCapability(value)
      })
    return () => {
      active = false
    }
  }, [project, path, session?.id, session?.revision, session?.versioning])
  const pending = capability?.pending
  const review = pending?.review
  if (!project || !capability || !pending) return null

  const refresh = async (): Promise<void> => {
    setCapability(await fetchVersionCapability(project, path))
    await act.refreshResourceVersioning(project)
  }

  const decide = async (action: ResourceReviewAction): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      if (!review) return
      if (session && action === 'revise' && !(await workspace.save(session.id))) {
        setNotice({ key: 'snapshotNotice.saveFailed' })
        return
      }
      if (session) {
        const latest = workspace.getSnapshot().sessions[session.id]
        if (!latest || latest.documentId !== session.documentId || latest.dirty) {
          setNotice({ key: 'snapshotNotice.saveFirst' })
          return
        }
      }
      const current = await fetchVersionCapability(project, path)
      if (
        !current?.pending?.review ||
        current.pending.review.id !== review.id ||
        (action !== 'revise' && current.pending.revision !== pending.revision) ||
        JSON.stringify(current.pending.review.candidate) !== JSON.stringify(review.candidate)
      ) {
        setNotice({ key: 'snapshotNotice.changed' })
        await refresh()
        return
      }
      const signature = JSON.stringify([
        project,
        current.pending.review.id,
        current.pending.revision,
        action,
        current.disk_revision,
      ])
      if (
        resourceEditorHasChanges(project, pending.file_id, [
          path,
          review.base.path,
          review.candidate.path,
        ])
      ) {
        setNotice({ key: 'snapshotNotice.draftChanged' })
        return
      }
      if (request.current?.signature !== signature)
        request.current = { signature, key: crypto.randomUUID() }
      const result = await decideResourceReview(
        project,
        path,
        current.pending,
        action,
        current.disk_revision,
        request.current.key
      )
      if (!result.ok) {
        setNotice({ key: 'snapshotNotice.operationFailed', detail: result.error ?? undefined })
        await refresh()
        return
      }
      if (action === 'reject') {
        const editors = await reconcileResourceEditors(project, [
          {
            fileId: pending.file_id,
            previousPath: path,
            path: review.base.path,
            state: review.base.state,
          },
        ])
        if (editors.conflicted.length || editors.failed.length) {
          setNotice({ key: 'snapshotNotice.restored' })
        }
      }
      await refresh()
      await act.reloadResourceTree()
      await onResolved()
    } catch {
      setNotice({ key: 'snapshotNotice.failed' })
    } finally {
      setBusy(false)
    }
  }

  const downloadBase = async (): Promise<void> => {
    if (!review) return
    try {
      const bytes = await fetchReviewBaseline(project, pending)
      if (!bytes) {
        setNotice({ key: 'snapshotNotice.unreadable' })
        return
      }
      const result = await window.scholarseed.saveFileCopy({
        suggestedName: `${t('snapshot.baselineFilenamePrefix')}${review.base.path.split('/').pop() ?? 'document'}`,
        bytes: new Uint8Array(bytes),
      })
      if (!result.ok && !result.canceled) setNotice({ key: 'snapshotNotice.exportFailed' })
    } catch {
      setNotice({ key: 'snapshotNotice.exportFailed' })
    }
  }

  if (!review) {
    const save = async (): Promise<void> => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      try {
        if (resourceEditorHasChanges(project, pending.file_id, [path])) {
          setNotice({ key: 'snapshotNotice.draftChanged' })
          return
        }
        const signature = JSON.stringify([
          project,
          pending.file_id,
          pending.revision,
          capability.disk_revision,
        ])
        if (request.current?.signature !== signature)
          request.current = { signature, key: crypto.randomUUID() }
        const result = await sealResourceSnapshot(
          project,
          path,
          capability,
          request.current.key,
          pending.origin === 'external' ? 'external_confirmed' : 'user'
        )
        if (!result.ok) setNotice({ key: 'snapshotNotice.operationFailed', detail: result.error })
        await refresh()
        await act.reloadResourceTree()
        await onResolved()
      } catch {
        setNotice({ key: 'snapshotNotice.failed' })
      } finally {
        setBusy(false)
      }
    }
    return (
      <Alert
        action={
          <div className="vds-version-actions flex flex-wrap items-center gap-[var(--vds-space-2)]">
            <Button
              size="sm"
              disabled={
                busy || !capability.can_version || capability.drifted || Boolean(session?.dirty)
              }
              data-testid="snapshot-save-pending"
              onClick={() => void save()}
            >
              {resourceText(snapshotSaveMessage(capability, false))}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>
              {t('snapshot.refresh')}
            </Button>
          </div>
        }
        data-testid="snapshot-pending"
        layout="stacked"
        title={t('snapshot.pendingTitle')}
        tone="info"
      >
        <AlertDescription truncate={false}>{t('snapshot.pendingDescription')}</AlertDescription>
        {notice && (
          <div role="status">
            <p>{t(notice.key)}</p>
            {notice.detail && <pre>{notice.detail}</pre>}
          </div>
        )}
      </Alert>
    )
  }

  return (
    <Alert
      action={
        <div className="vds-version-actions flex flex-wrap items-center gap-[var(--vds-space-2)]">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !review.base.object_id || !capability.can_preview_history}
            onClick={() => {
              if (review.base.object_id)
                act.openSnapshot(
                  {
                    kind: 'review-base',
                    project,
                    fileId: pending.file_id,
                    reviewId: review.id,
                    path: review.base.path,
                    revision: review.base.object_id,
                  },
                  `修改前 · ${review.base.path.split('/').pop()}`,
                  { kind: 'reviewBaseline', filename: review.base.path.split('/').pop() ?? '' }
                )
            }}
          >
            {t('snapshot.viewBase')}
          </Button>
          <Button
            size="sm"
            disabled={busy || session?.dirty || review.edited_by_user || capability.drifted}
            onClick={() => void decide('accept')}
          >
            {t('review.accept')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy || session?.dirty || review.edited_by_user || capability.drifted}
            onClick={() => setConfirmReject(true)}
          >
            {t('review.reject')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || (!session?.dirty && !review.edited_by_user)}
            onClick={() => void decide('revise')}
          >
            {t('snapshot.saveAccept')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || review.base.state === 'tombstone'}
            onClick={() => void downloadBase()}
          >
            {t('snapshot.download')}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>
            {t('snapshot.refresh')}
          </Button>
        </div>
      }
      data-testid="snapshot-review"
      layout="stacked"
      title={t('snapshot.title')}
      tone="info"
    >
      <AlertDescription truncate={false}>{t('snapshot.description')}</AlertDescription>
      {notice && (
        <div role="status">
          <p>{t(notice.key)}</p>
          {notice.detail && <pre>{notice.detail}</pre>}
        </div>
      )}
      {capability.drifted && (
        <ReviewConflict
          project={project}
          path={path}
          pending={pending}
          disabled={busy}
          onResolved={async () => {
            await refresh()
            await onResolved()
          }}
        />
      )}
      <AlertDialog open={confirmReject} onOpenChange={setConfirmReject}>
        <AlertDialogPortal>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('snapshot.rejectTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('snapshot.rejectDescription')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{uiText('cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void decide('reject')}>
                {t('snapshot.rejectRestore')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </Alert>
  )
}
