import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle, Badge, Button, EmptyState, ResizableHandle, ResizablePanel, ResizablePanelGroup, ScrollArea, Spinner } from '../../components/ui'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { OfficeDocument } from '../workbench/OfficeDocument'
import { ReviewBar } from '../workbench/ReviewBar'
import { ReviewDiff } from '../workbench/ReviewDiff'
import { parseReviewTab } from '../workbench/tabs'
import { useDocumentWorkspace, useWorkspaceController } from '../workbench/workspace'
import {
  decideResourceReviewBatch,
  fetchResourceReviewBatch,
  fetchReviewMemberContent,
  fetchReviewMemberCurrent,
  type ResourceReviewAction,
  type ResourceReviewBatch as ReviewBatchState,
  type ResourceReviewBatchMember
} from './api'
import { reviewDraftStore } from './draft'
import { reviewProgress } from './status'

const TEXT_DECODER = new TextDecoder()

function choiceLabel(action: ResourceReviewAction | null) {
  if (action === 'accept') return 'reviewBatch.accepted'
  if (action === 'reject') return 'reviewBatch.rejected'
  if (action === 'revise') return 'reviewBatch.revised'
  return 'reviewBatch.undecided'
}

function originLabel(origin: ResourceReviewBatchMember['origin']) {
  return origin === 'agent' ? 'reviewBatch.agent' : 'reviewBatch.external'
}

export function ReviewBatch({ tabId }: { tabId: string }): React.JSX.Element {
  const { t } = useTranslation('resources')
  const workspace = useWorkspaceController()
  const { act } = useApp()
  const identity = useMemo(() => parseReviewTab(tabId), [tabId])
  const documents = useDocumentWorkspace()
  useSyncExternalStore(reviewDraftStore.subscribe, reviewDraftStore.getSnapshot)
  const [batch, setBatch] = useState<ReviewBatchState | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [documentTabId, setDocumentTabId] = useState<string | null>(null)
  const [baseBytes, setBaseBytes] = useState<Uint8Array | null>(null)
  const [currentBytes, setCurrentBytes] = useState<Uint8Array | null>(null)
  const [currentRevisions, setCurrentRevisions] = useState<Record<string, string | null>>({})
  const [loadedCurrentFileId, setLoadedCurrentFileId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ key: 'reviewBatch.loadFailed' | 'reviewBatch.contentFailed' | 'reviewBatch.prepareFailed' | 'reviewBatch.refreshFailed' | 'reviewBatch.stale' | 'reviewBatch.submitFailed' | 'reviewBatch.undoFailed' | 'reviewBatch.diskFailed' | 'reviewBatch.saveFailed'; path?: string; detail?: string } | null>(null)
  const errorText = error ? `${t(error.key, { path: error.path ?? '' })}${error.detail ? ` (${error.detail})` : ''}` : null

  const refresh = async (): Promise<ReviewBatchState | null> => {
    if (!identity) return null
    const loaded = await fetchResourceReviewBatch(identity.projectId, identity.batchId)
    if (loaded) reviewDraftStore.hydrate(identity.projectId, loaded)
    setBatch(loaded)
    setLoading(false)
    if (!loaded) setError({ key: 'reviewBatch.loadFailed' })
    return loaded
  }

  useEffect(() => {
    setLoading(true)
    setError(null)
    setBatch(null)
    setSelectedFileId(null)
    setBaseBytes(null)
    setCurrentBytes(null)
    setCurrentRevisions({})
    setLoadedCurrentFileId(null)
    setDocumentTabId(null)
    void refresh()
  }, [identity?.batchId, identity?.projectId])

  const selected = batch?.members.find((member) => member.file_id === selectedFileId)
    ?? batch?.members.find((member) => member.state !== 'completed')
    ?? batch?.members[0]
    ?? null

  useEffect(() => {
    setBaseBytes(null)
    setCurrentBytes(null)
    setLoadedCurrentFileId(null)
    setDocumentTabId(null)
    if (!selected || !identity || selected.state === 'completed') return
    setSelectedFileId(selected.file_id)
    let cancelled = false
    void (async () => {
      try {
        const [base, current, openedTabId] = await Promise.all([
          selected.base.state === 'tombstone'
            ? Promise.resolve(new Uint8Array())
            : fetchReviewMemberContent(identity.projectId, identity.batchId, selected.file_id, 'base'),
          fetchReviewMemberCurrent(identity.projectId, identity.batchId, selected.file_id),
          selected.candidate.state === 'tombstone'
            ? Promise.resolve(null)
            : workspace.open(
                { kind: 'project', project: identity.projectId, path: selected.path },
                'edit',
                selected.path.split('/').at(-1) ?? selected.path
              )
        ])
        if (cancelled) return
        if (!base || !current) { setError({ key: 'reviewBatch.contentFailed' }); return }
        setBaseBytes(base)
        setCurrentBytes(current.content)
        setCurrentRevisions((revisions) => ({ ...revisions, [selected.file_id]: current.revision }))
        setLoadedCurrentFileId(selected.file_id)
        setDocumentTabId(openedTabId)
      } catch (cause) {
        if (!cancelled) setError({ key: 'reviewBatch.prepareFailed', detail: cause instanceof Error ? cause.message : undefined })
      }
    })()
    return () => { cancelled = true }
  }, [identity?.batchId, identity?.projectId, selected?.file_id, selected?.review_id, selected?.state])

  const documentTab = documentTabId ? documents.tabs[documentTabId] : null
  const session = documentTab ? documents.sessions[documentTab.sessionId] : null
  const selectedChoice = selected && identity
    ? reviewDraftStore.choice(identity.projectId, identity.batchId, selected.file_id)
    : null
  const decidedCount = identity && batch
    ? reviewDraftStore.decidedCount(identity.projectId, identity.batchId)
    : 0
  const progress = identity && batch
    ? reviewProgress(
        batch,
        (fileId) => reviewDraftStore.choice(identity.projectId, identity.batchId, fileId) !== null
      )
    : { reviewed: 0, pending: 0, failed: 0 }
  const selectedCurrentRevision = selected
    ? currentRevisions[selected.file_id]
    : undefined
  const externalModified = selected !== null
    && loadedCurrentFileId === selected.file_id
    && selectedCurrentRevision !== undefined
    && selectedCurrentRevision !== selected?.candidate_revision

  const sessionFor = (member: ResourceReviewBatchMember) => Object.values(
    workspace.getSnapshot().sessions
  ).find((candidate) => (
    candidate.source.kind === 'project'
    && candidate.source.project === identity?.projectId
    && candidate.source.path === member.path
  ))
  const hasDraftEdits = (batch?.members ?? []).some((member) => Boolean(sessionFor(member)?.dirty))

  const choose = async (action: ResourceReviewAction): Promise<void> => {
    if (!identity || !selected || selected.state === 'completed') return
    let revision = session?.revision ?? currentRevisions[selected.file_id] ?? selected.candidate_revision
    if (action !== 'revise' && session?.dirty) {
      if (!await workspace.discardMemory(session.id)) return
      revision = workspace.getSnapshot().sessions[session.id]?.revision ?? revision
    }
    reviewDraftStore.choose(identity.projectId, identity.batchId, selected, action, revision)
  }

  const undoAll = async (): Promise<void> => {
    if (!identity || !batch) return
    setBusy(true)
    setError(null)
    for (const member of batch.members) {
      const memberSession = sessionFor(member)
      if (memberSession?.dirty && !await workspace.discardMemory(memberSession.id)) {
        setBusy(false)
        setError({ key: 'reviewBatch.undoFailed', path: member.path })
        return
      }
    }
    reviewDraftStore.clearBatch(identity.projectId, identity.batchId)
    reviewDraftStore.hydrate(identity.projectId, batch)
    setBusy(false)
  }

  const bulk = async (action: 'accept' | 'reject', scope: 'remaining' | 'all'): Promise<void> => {
    if (!identity || !batch) return
    setBusy(true)
    setError(null)
    for (const member of batch.members) {
      if (member.state === 'completed') continue
      if (scope === 'remaining' && reviewDraftStore.choice(identity.projectId, batch.id, member.file_id)) continue
      const memberSession = sessionFor(member)
      if (memberSession?.dirty && !await workspace.discardMemory(memberSession.id)) {
        setBusy(false)
        setError({ key: 'reviewBatch.undoFailed', path: member.path })
        return
      }
      const current = await fetchReviewMemberCurrent(
        identity.projectId, identity.batchId, member.file_id
      )
      if (!current) {
        setBusy(false)
        setError({ key: 'reviewBatch.diskFailed', path: member.path })
        return
      }
      reviewDraftStore.choose(
        identity.projectId,
        batch.id,
        member,
        action,
        current.revision
      )
    }
    setBusy(false)
  }

  const submitBatch = async (): Promise<void> => {
    if (!identity || !batch) return
    setBusy(true)
    setError(null)
    for (const member of batch.members) {
      const choice = reviewDraftStore.choice(identity.projectId, batch.id, member.file_id)
      if (choice?.action !== 'revise') continue
      const memberSession = sessionFor(member)
      if (!memberSession?.dirty || !await workspace.save(memberSession.id)) {
        setBusy(false)
        setError({ key: 'reviewBatch.saveFailed', path: member.path })
        return
      }
    }
    const refreshed = await fetchResourceReviewBatch(identity.projectId, batch.id)
    if (!refreshed) {
      setBusy(false)
      setError({ key: 'reviewBatch.refreshFailed' })
      return
    }
    for (const member of refreshed.members) {
      const previous = reviewDraftStore.choice(identity.projectId, batch.id, member.file_id)
      if (!previous) continue
      const memberSession = sessionFor(member)
      reviewDraftStore.choose(
        identity.projectId,
        batch.id,
        member,
        previous.action,
        memberSession?.revision ?? currentRevisions[member.file_id] ?? previous.expectedDiskRevision
      )
    }
    const decisions = reviewDraftStore.decisions(identity.projectId, refreshed)
    if (!decisions) {
      setBusy(false)
      setError({ key: 'reviewBatch.stale' })
      setBatch(refreshed)
      return
    }
    const result = await decideResourceReviewBatch(
      identity.projectId, identity.batchId, decisions, crypto.randomUUID()
    )
    setBusy(false)
    if (!result.ok || result.batch?.state !== 'completed') {
      setError({ key: 'reviewBatch.submitFailed', detail: result.error || undefined })
      if (result.batch) setBatch(result.batch)
      return
    }
    reviewDraftStore.clearBatch(identity.projectId, identity.batchId)
    setBatch(result.batch)
    await workspace.reconcileProjectPaths(identity.projectId, batch.members.map((member) => member.path))
    act.invalidateResources()
    act.completeResourceReview(tabId, {
      projectId: identity.projectId,
      path: selected?.path ?? batch.members[0].path,
      documentTabId
    })
  }

  if (!identity) return <EmptyState title={t('reviewBatch.invalid')} description={t('reviewBatch.reopen')} />
  if (loading) return <div className="grid h-full place-items-center"><Spinner aria-label={t('reviewBatch.loading')} /></div>
  if (!batch) return <EmptyState title={t('reviewBatch.unavailable')} description={errorText ?? t('reviewBatch.missing')} />
  if (batch.members.length === 0) return <EmptyState title={t('reviewBatch.empty')} description={t('reviewBatch.noAction')} />

  return (
    <ResizablePanelGroup className="h-full min-h-0 bg-[var(--vds-bg-page)]" data-testid="review-batch" defaultSizes={[24, 76]}>
      <ResizablePanel aria-label={t('reviewBatch.files')} minSize={18} maxSize={38}>
        <aside className="flex h-full min-h-0 flex-col bg-[var(--vds-bg-white-default)]">
        <header className="border-b border-[var(--vds-divider-default)] px-[var(--vds-space-4)] py-[var(--vds-space-4)]">
          <h2 className="m-0 text-base font-semibold text-[var(--vds-text-primary)]">{t('reviewBatch.heading')}</h2>
          <p className="m-0 mt-[var(--vds-space-1)] text-xs text-[var(--vds-text-secondary)]">{t('reviewBatch.outcomeProgress', {
            reviewed: progress.reviewed,
            pending: progress.pending,
            failed: progress.failed
          })}</p>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-[var(--vds-space-1)] p-[var(--vds-space-2)]">
            {batch.members.map((member) => {
              const action = reviewDraftStore.choice(identity.projectId, batch.id, member.file_id)?.action ?? null
              return (
                <Button key={member.file_id} aria-current={selected?.file_id === member.file_id ? 'true' : undefined} className="group h-auto min-h-14 justify-start px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left" data-decided={action ? 'true' : 'false'} data-testid={`review-member-${member.file_id}`} unstyled onClick={() => setSelectedFileId(member.file_id)}>
                  <span className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-6)] border border-transparent p-[var(--vds-space-2)] text-[var(--vds-text-primary)] hover:bg-[var(--vds-surface-muted)] group-data-[decided=true]:bg-[var(--vds-brand-container)] aria-[current=true]:border-[var(--vds-brand-default)]">
                    <Icon name="doc" size={16} />
                    <span className="min-w-0">
                      <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium" title={member.path}>{member.path}</span>
                      <span className="mt-[var(--vds-space-1)] flex gap-[var(--vds-space-1)]">
                        <Badge size="sm" tone={member.origin === 'agent' ? 'brand' : 'neutral'}>{t(originLabel(member.origin))}</Badge>
                        <Badge size="sm" tone={action === 'reject' ? 'danger' : action ? 'success' : 'neutral'}>{t(choiceLabel(action))}</Badge>
                      </span>
                    </span>
                  </span>
                </Button>
              )
            })}
          </div>
        </ScrollArea>
        </aside>
      </ResizablePanel>
      <ResizableHandle aria-label={t('reviewBatch.resize')} />
      <ResizablePanel aria-label={t('reviewBatch.content')} minSize={50}>
        <main className="flex h-full min-h-0 min-w-0 flex-col">
        <ReviewBar busy={busy} decided={decidedCount} reviewed={progress.reviewed} pending={progress.pending} failed={progress.failed} total={batch.members.length} hasEdits={hasDraftEdits} selectedAction={selectedChoice?.action ?? null} reviseEnabled={Boolean(session?.dirty)} selectedEnabled={Boolean(selected && selected.state !== 'completed')} decisionsEnabled={batch.members.some((member) => member.state !== 'completed')} onChoose={(action) => { void choose(action) }} onUndoAll={() => { void undoAll() }} onBulk={(action, scope) => { void bulk(action, scope) }} onSubmit={() => { void submitBatch() }} />
        {error ? <Alert className="m-[var(--vds-space-3)]" tone="error"><AlertTitle>{t('reviewBatch.failed')}</AlertTitle><AlertDescription>{errorText}</AlertDescription></Alert> : null}
        {externalModified ? <Alert className="mx-[var(--vds-space-3)] mt-[var(--vds-space-3)]" tone="info"><AlertTitle>{t('reviewBatch.changed')}</AlertTitle><AlertDescription>{t('reviewBatch.changedDetail')}</AlertDescription></Alert> : null}
        {!selected ? <EmptyState title={t('reviewBatch.processed')} description={t('reviewBatch.decided')} />
          : selected.state === 'completed' ? <EmptyState title={t('reviewBatch.submitted')} description={t(choiceLabel(selected.action))} />
          : !session || session.loadState === 'loading' || !baseBytes || !currentBytes ? <div className="grid min-h-0 flex-1 place-items-center"><Spinner aria-label={t('reviewBatch.preparing')} /></div>
          : session.loadState === 'error' ? <EmptyState title={t('reviewBatch.openFailed')} description={selected.path} />
          : session.viewer === 'code' || session.viewer === 'markdown' ? <ReviewDiff baseText={TEXT_DECODER.decode(baseBytes)} candidateText={TEXT_DECODER.decode(currentBytes)} path={selected.path} sessionId={session.id} />
          : session.viewer === 'office' || session.viewer === 'spreadsheet' ? <div className="min-h-0 flex-1"><OfficeDocument kind={session.viewer} sessionId={session.id} tabId={documentTabId ?? ''} viewKind="edit" /></div>
          : <EmptyState title={t('reviewBatch.unsupported')} description={t('reviewBatch.wholeSnapshot')} />}
        </main>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
