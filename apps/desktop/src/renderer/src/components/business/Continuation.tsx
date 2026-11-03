import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { getSessionContinuation, type SessionContinuationPreview } from '../../api'
import type { ConvItem } from '../../model'
import { activeThread, useApp, type AppState, type ComposerReference } from '../../store'
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Textarea,
} from '../ui'

type FailureItem = Extract<ConvItem, { kind: 'error' }>
type ContinuationFailure = 'previewFailed' | 'modelUnavailable' | 'projectUnavailable'

interface ContinuationRequest {
  controller: AbortController
  scope: string
  sessionId: string
  turnId: string
  modelId: string
  draftRevision: number
  draftText: string
  references: ComposerReference[]
}

const CONTINUATION_PREVIEW_ROWS = 8
const CONTINUATION_FAILURE_KEYS = {
  previewFailed: 'continuation.previewFailed',
  modelUnavailable: 'continuation.modelUnavailable',
  projectUnavailable: 'continuation.projectUnavailable',
} as const

function continuationScope(state: AppState, item: FailureItem): string | null {
  const thread = activeThread(state)
  const latestTurnId = [...thread.conversation].reverse().find((entry) => entry.turnId)?.turnId
  if (
    item.failure?.kind !== 'capability' ||
    !item.turnId ||
    latestTurnId !== item.turnId ||
    !thread.sessionId ||
    !state.activeSession ||
    !state.backendReady ||
    !state.serviceInstanceId ||
    state.modelCatalogInstanceId !== state.serviceInstanceId ||
    state.modelSelectionPending > 0 ||
    thread.readOnly ||
    thread.terminated ||
    thread.running ||
    thread.interrupting ||
    thread.activeTurnId ||
    thread.recoveryPending ||
    thread.resumeState === 'pending' ||
    thread.status === 'running' ||
    thread.status === 'waiting' ||
    (thread.turnOutcomes?.[item.turnId] ?? thread.status) !== 'failed' ||
    thread.queuedMessages?.some((message) => message.state !== 'failed')
  )
    return null
  return JSON.stringify([
    state.serviceInstanceId,
    state.activeSession,
    thread.sessionId,
    item.turnId,
    thread.lastSeq,
    state.model,
    thread.runtime?.model_id,
    state.modelSelectionGeneration,
    state.draftGeneration,
    state.navigationObservation?.generation,
    state.mainView,
    state.activeTab,
    state.homeSelectedProjectId,
    state.aiPanel.revision,
    state.aiPanel.sessionId,
  ])
}

function previewFailure(
  state: AppState,
  preview: SessionContinuationPreview,
  request: ContinuationRequest
): ContinuationFailure | null {
  if (preview.source_session_id !== request.sessionId) return 'previewFailed'
  if (
    preview.model_id !== request.modelId ||
    !state.catalog.models.some((model) => model.key === preview.model_id && !model.disabled)
  )
    return 'modelUnavailable'
  if (
    preview.project_path !== null &&
    !state.projects.some(
      (project) =>
        project.path === preview.project_path && project.available !== false && !project.archived_at
    )
  )
    return 'projectUnavailable'
  return null
}

export function Continuation({ item }: { item: FailureItem }): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  const { state, getSnapshot, composerDraft, act } = useApp()
  const draftText = useSyncExternalStore(
    composerDraft.subscribe,
    composerDraft.getSnapshot,
    composerDraft.getSnapshot
  )
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [preview, setPreview] = useState<SessionContinuationPreview | null>(null)
  const [failureCode, setFailureCode] = useState<ContinuationFailure | null>(null)
  const requestRef = useRef<ContinuationRequest | null>(null)
  const pendingRef = useRef(false)
  const titleId = React.useId()
  const descriptionId = React.useId()
  const scope = continuationScope(state, item)
  const request = requestRef.current
  const draftConflict = Boolean(
    request &&
    (request.draftText.length > 0 ||
      request.references.length > 0 ||
      composerDraft.getRevision() !== request.draftRevision ||
      draftText !== request.draftText ||
      state.composerRefs !== request.references)
  )
  const availabilityError = preview && request ? previewFailure(state, preview, request) : null
  const visibleError = failureCode ?? availabilityError
  const composerText = preview
    ? `${t('continuation.draftIntro')}\n\n${JSON.stringify(preview.messages, null, 2)}\n\n${t('continuation.draftWarning')}`
    : ''

  const closePreview = (): void => {
    requestRef.current?.controller.abort()
    requestRef.current = null
    pendingRef.current = false
    setOpen(false)
    setPending(false)
    setPreview(null)
    setFailureCode(null)
  }

  useLayoutEffect(() => {
    if (requestRef.current && requestRef.current.scope !== scope) closePreview()
  }, [scope])

  useEffect(
    () => () => {
      requestRef.current?.controller.abort()
      requestRef.current = null
      pendingRef.current = false
    },
    []
  )

  const loadPreview = async (): Promise<void> => {
    if (pendingRef.current) return
    const current = getSnapshot()
    const currentScope = continuationScope(current, item)
    if (!currentScope) return
    const thread = activeThread(current)
    const next: ContinuationRequest = {
      controller: new AbortController(),
      scope: currentScope,
      sessionId: thread.sessionId!,
      turnId: item.turnId!,
      modelId: thread.runtime?.model_id || current.model,
      draftRevision: composerDraft.getRevision(),
      draftText: composerDraft.getSnapshot(),
      references: current.composerRefs,
    }
    requestRef.current?.controller.abort()
    requestRef.current = next
    setOpen(true)
    setPreview(null)
    setFailureCode(null)
    if (next.draftText.length > 0 || next.references.length > 0) return
    pendingRef.current = true
    setPending(true)
    try {
      const result = await getSessionContinuation(
        next.sessionId,
        next.turnId,
        next.controller.signal
      )
      if (
        requestRef.current !== next ||
        next.controller.signal.aborted ||
        continuationScope(getSnapshot(), item) !== next.scope
      )
        return
      const failure = previewFailure(getSnapshot(), result, next)
      if (failure) setFailureCode(failure)
      else setPreview(result)
    } catch {
      if (
        requestRef.current === next &&
        !next.controller.signal.aborted &&
        continuationScope(getSnapshot(), item) === next.scope
      )
        setFailureCode('previewFailed')
    } finally {
      if (requestRef.current === next) {
        pendingRef.current = false
        setPending(false)
      }
    }
  }

  const confirm = (): void => {
    const latestRequest = requestRef.current
    const current = getSnapshot()
    if (!latestRequest || !preview || pendingRef.current) return
    if (continuationScope(current, item) !== latestRequest.scope) {
      closePreview()
      return
    }
    if (
      latestRequest.draftText.length > 0 ||
      latestRequest.references.length > 0 ||
      composerDraft.getRevision() !== latestRequest.draftRevision ||
      composerDraft.getSnapshot() !== latestRequest.draftText ||
      current.composerRefs !== latestRequest.references
    )
      return
    const failure = previewFailure(current, preview, latestRequest)
    if (failure) {
      setFailureCode(failure)
      return
    }
    const projectId =
      preview.project_path === null
        ? null
        : current.projects.find((project) => project.path === preview.project_path)!.id
    pendingRef.current = true
    try {
      act.startDraft({ composerText, projectId, modelId: preview.model_id, submit: false })
      closePreview()
    } catch {
      setFailureCode('modelUnavailable')
      pendingRef.current = false
    }
  }

  if (!scope) return null
  return (
    <div className="col-span-2 min-w-0">
      <Button
        data-testid="turn-compatible-continuation"
        disabled={pending}
        onClick={loadPreview}
        size="sm"
        variant="outline"
      >
        {t('continuation.action')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closePreview()
        }}
      >
        <DialogPortal>
          <DialogContent
            aria-describedby={descriptionId}
            aria-labelledby={titleId}
            className="max-h-[calc(100dvh-var(--vds-space-8))] overflow-y-auto"
            data-testid="continuation-dialog"
            headerLayout="aligned"
          >
            <DialogHeader>
              <DialogTitle id={titleId}>{t('continuation.title')}</DialogTitle>
              <DialogDescription id={descriptionId}>
                {t('continuation.description')}
              </DialogDescription>
            </DialogHeader>
            <Alert tone="warning" layout="stacked">
              <AlertDescription truncate={false}>{t('continuation.warning')}</AlertDescription>
            </Alert>
            {draftConflict ? (
              <Alert tone="warning" data-testid="continuation-draft-conflict">
                <AlertDescription truncate={false}>
                  {t('continuation.draftConflict')}
                </AlertDescription>
              </Alert>
            ) : null}
            {pending ? <p role="status">{t('continuation.loading')}</p> : null}
            {visibleError ? (
              <Alert tone="error" data-testid="continuation-error">
                <AlertDescription truncate={false}>
                  {t(CONTINUATION_FAILURE_KEYS[visibleError])}
                </AlertDescription>
              </Alert>
            ) : null}
            {preview ? (
              <>
                <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
                  {t('continuation.summary', {
                    included: preview.included_messages,
                    omitted: preview.omitted_messages,
                    characters: preview.omitted_characters,
                  })}
                  {preview.truncated ? ` ${t('continuation.truncated')}` : ''}
                </p>
                <Textarea
                  data-testid="continuation-preview"
                  label={t('continuation.previewLabel')}
                  readOnly
                  rows={CONTINUATION_PREVIEW_ROWS}
                  value={composerText}
                />
              </>
            ) : null}
            <DialogFooter>
              <Button data-testid="continuation-cancel" onClick={closePreview} variant="outline">
                {t('continuation.cancel')}
              </Button>
              {failureCode === 'previewFailed' && !draftConflict ? (
                <Button
                  data-testid="continuation-retry"
                  disabled={pending}
                  onClick={loadPreview}
                  variant="outline"
                >
                  {t('continuation.retry')}
                </Button>
              ) : null}
              <Button
                data-testid="continuation-confirm"
                disabled={pending || !preview || draftConflict || Boolean(visibleError)}
                onClick={confirm}
              >
                {t('continuation.confirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </div>
  )
}
