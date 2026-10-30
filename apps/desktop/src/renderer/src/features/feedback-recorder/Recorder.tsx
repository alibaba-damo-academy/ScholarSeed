import React from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { MessageCircleQuestion } from 'lucide-react'

import { submitFeedback } from '../../api'
import { useAccountAccess } from '../../components/business/access'
import { FeedbackReceipt } from '../../components/business/Receipt'
import {
  useToast,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  FOCUS_SCOPE_EXTENSION_ATTRIBUTE,
  IconButton,
  navigationRailButtonClassName,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui'
import { CAPTURE_SETTLE_FRAMES, waitForFrames } from '../../frames'
import { useApp } from '../../store'
import { feedbackShortcutAction } from './access'
import { Annotator, type AnnotatorResult } from './Annotator'
import { ScreenshotShutter, useScreenshotShutter } from './Shutter'
import { Capture } from './Capture'
import { FLOATING_EDGE_MARGIN_PX, FLOATING_PANEL_MARGIN_PX, useFloatingSurface } from './drag'
import {
  RECORDER_MAX_REQUESTS,
  RECORDER_MAX_STEPS,
  RECORDER_DESCRIPTION_MAX_LENGTH,
  RECORDER_ROOT_ATTRIBUTE,
  RECORDING_REPORT_TOO_LARGE,
  appendInitialScreenshot,
  createRecordingSession,
  normalizeNote,
  replaceRecordedScreenshot,
  selectFeedbackImages,
  type Annotation,
  type RecorderPhase,
  type RecordingSession,
  type SummaryFields,
} from './model'
import { createInitialPageStep, installRecorderProbe, type RecorderLease } from './probe'
import {
  buildRecordingReport,
  composeFinalDescription,
  generateSummary,
  prepareDescriptionForSubmission,
  reportFile,
} from './report'
import { Review } from './Review'
import {
  FEEDBACK_CAPTURE_ERROR,
  FEEDBACK_RECORDER_START_EVENT,
  FEEDBACK_SHORTCUT,
  type FeedbackCaptureError,
} from '../../../../feedback'
import { compositeFeedbackScreenshot } from './utils'

const SCREENSHOT_LIMIT = 5
const EMPTY_ANNOTATIONS: readonly Annotation[] = []

type AnnotationContext =
  | { mode: 'create'; sourceFile: File; stepId: string }
  | { mode: 'edit'; screenshotId: string; sourceFile: File; initialNote: string }

function blankSummary(): SummaryFields {
  return { generated: '', final: '', actual: '', expected: '', additional: '' }
}

function captureErrorText(t: TFunction<'components'>, error: FeedbackCaptureError): string {
  if (error === 'capture_empty') return t('feedbackRecorder.errors.capture_empty')
  if (error === 'capture_too_large') return t('feedbackRecorder.errors.capture_too_large')
  if (error === 'invalid_sender') return t('feedbackRecorder.errors.invalid_sender')
  return t('feedbackRecorder.errors.capture_failed')
}

function ScreenshotSubmitted(): React.JSX.Element {
  const { t } = useTranslation('components')
  return <>{t('feedbackRecorder.screenshotSubmitted')}</>
}

export function Recorder(): React.JSX.Element {
  const { toast } = useToast()
  const { t } = useTranslation('components')
  const { state, act, set } = useApp()
  const internalEnabled = window.scholarseed.feedbackRecorderEnabled
  const { authenticated } = useAccountAccess(state.backendReady && internalEnabled)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const leaseRef = React.useRef<RecorderLease | null>(null)
  const sessionRef = React.useRef<RecordingSession | null>(null)
  const latestStepRef = React.useRef<RecordingSession['steps'][number]>()
  const stepCountRef = React.useRef(0)
  const entryRef = React.useRef<HTMLButtonElement | null>(null)
  const [entryHost, setEntryHost] = React.useState<Element | null>(null)
  React.useLayoutEffect(() => {
    const update = (): void => {
      setEntryHost(document.querySelector('[data-feedback-entry-host]'))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  const [phase, setPhase] = React.useState<RecorderPhase>('idle')
  const shutter = useScreenshotShutter()
  const floating = useFloatingSurface(
    phase,
    phase === 'idle' ? FLOATING_EDGE_MARGIN_PX : FLOATING_PANEL_MARGIN_PX
  )
  const setEntrySurface = React.useCallback(
    (node: HTMLButtonElement | null): void => {
      entryRef.current = node
      floating.setSurface(entryHost ? null : node)
    },
    [entryHost, floating.setSurface]
  )
  const [session, setSession] = React.useState<RecordingSession | null>(null)
  const [annotationContext, setAnnotationContext] = React.useState<AnnotationContext | null>(null)
  const [reviewPage, setReviewPage] = React.useState(0)
  const [summary, setSummary] = React.useState<SummaryFields>(blankSummary)
  const [error, setError] = React.useState('')
  const shortcutBusy = React.useRef(false)
  const [ticket, setTicket] = React.useState('')
  const [partialDiagnostics, setPartialDiagnostics] = React.useState(false)
  const [descriptionTruncated, setDescriptionTruncated] = React.useState(false)

  const dispose = React.useCallback((): void => {
    leaseRef.current?.dispose()
    leaseRef.current = null
  }, [])

  const clearSession = React.useCallback((): void => {
    dispose()
    sessionRef.current?.screenshots.forEach((screenshot) =>
      URL.revokeObjectURL(screenshot.previewUrl)
    )
    sessionRef.current = null
    setSession(null)
    latestStepRef.current = undefined
    stepCountRef.current = 0
    setAnnotationContext(null)
    setReviewPage(0)
    setSummary(blankSummary())
    setError('')
    setTicket('')
    setPartialDiagnostics(false)
    setDescriptionTruncated(false)
    setPhase('idle')
  }, [dispose])

  React.useEffect(() => {
    sessionRef.current = session
  }, [session])

  React.useEffect(
    () => () => {
      leaseRef.current?.dispose()
      sessionRef.current?.screenshots.forEach((screenshot) =>
        URL.revokeObjectURL(screenshot.previewUrl)
      )
    },
    []
  )

  const updateSession = React.useCallback(
    (update: (current: RecordingSession) => RecordingSession): void => {
      const current = sessionRef.current
      if (!current) return
      const next = update(current)
      sessionRef.current = next
      setSession(next)
    },
    []
  )

  const installProbe = React.useCallback(
    (startedAtMs: number): void => {
      leaseRef.current = installRecorderProbe({
        startedAtMs,
        latestStep: () => latestStepRef.current,
        onStep: (step) => {
          if (stepCountRef.current >= RECORDER_MAX_STEPS) {
            updateSession((current) => ({
              ...current,
              truncated: { ...current.truncated, steps: true },
            }))
            return
          }
          stepCountRef.current += 1
          latestStepRef.current = step
          updateSession((current) => ({ ...current, steps: [...current.steps, step] }))
        },
        onRequest: (request) => {
          updateSession((current) => {
            const existing = current.requests.findIndex(
              (entry) => entry.requestId === request.requestId
            )
            if (existing !== -1) {
              const requests = [...current.requests]
              requests[existing] = request
              return { ...current, requests }
            }
            if (current.requests.length >= RECORDER_MAX_REQUESTS) {
              return { ...current, truncated: { ...current.truncated, requests: true } }
            }
            return { ...current, requests: [...current.requests, request] }
          })
        },
      })
    },
    [updateSession]
  )

  const captureSourceFile = React.useCallback(async (): Promise<File | null> => {
    setError('')
    const root = rootRef.current
    const entry = entryRef.current
    if (root) root.style.visibility = 'hidden'
    if (entry) entry.style.visibility = 'hidden'
    let result
    try {
      await waitForFrames(CAPTURE_SETTLE_FRAMES)
      result = await window.scholarseed.captureFeedbackScreenshot()
    } catch {
      setError(t('feedbackRecorder.errors.capture_failed'))
      return null
    } finally {
      if (root) root.style.visibility = ''
      if (entry) entry.style.visibility = ''
    }
    if (!result.ok) {
      setError(captureErrorText(t, result.error))
      return null
    }
    try {
      const screenshot = await compositeFeedbackScreenshot(result)
      return new File([screenshot], `feedback-source-${Date.now()}.png`, { type: screenshot.type })
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === FEEDBACK_CAPTURE_ERROR.tooLarge
          ? t('feedbackRecorder.errors.capture_too_large')
          : t('feedbackRecorder.errors.capture_failed')
      )
      return null
    }
  }, [t])

  const start = React.useCallback(async (): Promise<void> => {
    dispose()
    const created = createRecordingSession()
    const initialStep = createInitialPageStep(created.startedAtMs)
    const next = { ...created, steps: [initialStep] }
    sessionRef.current = next
    latestStepRef.current = initialStep
    stepCountRef.current = next.steps.length
    installProbe(next.startedAtMs)
    setSession(next)
    const sourceFile = await captureSourceFile()
    setPhase('recording')
    if (!sourceFile) return
    const renderedFile = new File([sourceFile], `feedback-${Date.now()}.png`, { type: 'image/png' })
    const withScreenshot = appendInitialScreenshot(sessionRef.current || next, {
      previewUrl: URL.createObjectURL(renderedFile),
      renderedFile,
      screenshotId: crypto.randomUUID(),
      sourceFile,
    })
    sessionRef.current = withScreenshot
    setSession(withScreenshot)
  }, [dispose, installProbe, captureSourceFile])

  const setPaused = (paused: boolean): void => {
    const current = sessionRef.current
    if (!current) return
    if (paused) {
      dispose()
      setPhase('paused')
      return
    }
    installProbe(current.startedAtMs)
    setPhase('recording')
  }

  const stop = (): void => {
    dispose()
    const current = sessionRef.current
    if (!current) return
    const stopped = {
      ...current,
      endedAt: new Date().toISOString(),
      finalPage: window.location.href,
    }
    sessionRef.current = stopped
    const generated = generateSummary(stopped, {
      step: (index, kind, target, note) =>
        t('feedbackRecorder.summary.step', { index, kind, target, note }),
      screenshots: (count) => t('feedbackRecorder.summary.screenshots', { count }),
      screenshotNote: (index, note) =>
        t('feedbackRecorder.summary.screenshotNote', { index, note }),
      empty: t('feedbackRecorder.summary.empty'),
    })
    setSession(stopped)
    setSummary({ ...blankSummary(), generated })
    setPhase('review')
  }

  const capture = React.useCallback(async (): Promise<void> => {
    if (!session || session.screenshots.length >= SCREENSHOT_LIMIT) {
      setError(t('feedbackRecorder.errors.screenshotLimit'))
      return
    }
    const stepId = latestStepRef.current?.stepId
    if (!stepId) {
      setError(t('feedbackRecorder.errors.screenshotRequiresStep'))
      return
    }
    await shutter.run(async () => {
      if (sessionRef.current?.sessionId !== session.sessionId) return
      const sourceFile = await captureSourceFile()
      if (!sourceFile || sessionRef.current?.sessionId !== session.sessionId) return
      setAnnotationContext({ mode: 'create', sourceFile, stepId })
      setPhase('annotating')
    })
  }, [session, t, captureSourceFile, shutter.run])

  const saveScreenshot = async (result: AnnotatorResult): Promise<void> => {
    const context = annotationContext
    if (!context) return
    const previewUrl = URL.createObjectURL(result.renderedFile)
    if (context.mode === 'edit') {
      const target = sessionRef.current?.screenshots.find(
        (entry) => entry.screenshotId === context.screenshotId
      )
      if (!target) {
        URL.revokeObjectURL(previewUrl)
        setError(t('feedbackRecorder.errors.screenshotMissing'))
        setAnnotationContext(null)
        setPhase('review')
        return
      }
      updateSession((current) => ({
        ...current,
        notes: target.stepId
          ? { ...current.notes, [target.stepId]: normalizeNote(result.note) }
          : current.notes,
        screenshots: current.screenshots.map((entry) =>
          entry.screenshotId === context.screenshotId
            ? {
                ...replaceRecordedScreenshot(entry, {
                  ...result,
                  note: normalizeNote(result.note),
                  previewUrl,
                }),
                automatic: false,
              }
            : entry
        ),
      }))
      URL.revokeObjectURL(target.previewUrl)
      setAnnotationContext(null)
      setPhase('review')
      return
    }
    const step = sessionRef.current?.steps.find((entry) => entry.stepId === context.stepId)
    if (!step) {
      URL.revokeObjectURL(previewUrl)
      setError(t('feedbackRecorder.errors.screenshotRequiresStep'))
      setAnnotationContext(null)
      setPhase('recording')
      return
    }
    updateSession((current) => ({
      ...current,
      screenshots: [
        ...current.screenshots,
        {
          automatic: false,
          screenshotId: crypto.randomUUID(),
          stepId: step.stepId,
          sourceFile: context.sourceFile,
          ...result,
          previewUrl,
          note: normalizeNote(result.note),
        },
      ],
    }))
    setAnnotationContext(null)
    setPhase('recording')
    toast({ tone: 'success', description: <ScreenshotSubmitted /> })
  }

  const editScreenshot = (screenshotId: string, initialNote: string): void => {
    const screenshot = sessionRef.current?.screenshots.find(
      (entry) => entry.screenshotId === screenshotId
    )
    if (!screenshot) return
    setAnnotationContext({
      mode: 'edit',
      screenshotId,
      sourceFile: screenshot.sourceFile,
      initialNote,
    })
    setPhase('annotating')
  }

  const submit = async (): Promise<void> => {
    if (!session) return
    setPhase('submitting')
    setError('')
    try {
      if (!session.endedAt) throw new Error('recording_not_stopped')
      const report = buildRecordingReport(session, session.endedAt, summary)
      const description = composeFinalDescription(
        summary,
        {
          actual: t('feedbackRecorder.description.actual'),
          expected: t('feedbackRecorder.description.expected'),
          additional: t('feedbackRecorder.description.additional'),
          operations: t('feedbackRecorder.description.operations'),
          requests: t('feedbackRecorder.description.requests'),
          empty: t('feedbackRecorder.description.empty'),
          cancelled: t('feedbackRecorder.description.cancelled'),
          moreInReport: t('feedbackRecorder.description.moreInReport'),
          page: (value) => t('feedbackRecorder.description.page', { value }),
          dialog: (value) => t('feedbackRecorder.description.dialog', { value }),
          locator: (value) => t('feedbackRecorder.description.locator', { value }),
          containers: (value) => t('feedbackRecorder.description.containers', { value }),
          pointer: (x, y) => t('feedbackRecorder.description.pointer', { x, y }),
          bounds: (x, y, width, height) =>
            t('feedbackRecorder.description.bounds', {
              x,
              y,
              width,
              height,
            }),
          operation: (index, occurredAt, elapsedMs, kind, target, value, note, diagnostics) =>
            t('feedbackRecorder.description.operation', {
              index,
              occurredAt,
              elapsedMs,
              kind,
              target,
              value: value ? t('feedbackRecorder.description.operationValue', { value }) : '',
              note: note ? t('feedbackRecorder.description.operationNote', { note }) : '',
              diagnostics,
            }),
          request: (index, startedAt, elapsedMs, method, url, status, durationMs, linkedStep) =>
            t('feedbackRecorder.description.request', {
              index,
              startedAt,
              elapsedMs,
              method,
              url,
              status,
              durationMs,
              linkedStep:
                linkedStep === undefined
                  ? ''
                  : t('feedbackRecorder.description.requestStep', { index: linkedStep }),
            }),
        },
        session
      )
      const preparedDescription = prepareDescriptionForSubmission(
        description,
        t('feedbackRecorder.notices.descriptionTruncated', {
          limit: RECORDER_DESCRIPTION_MAX_LENGTH,
        })
      )
      setDescriptionTruncated(preparedDescription.truncated)
      const result = await submitFeedback({
        description: preparedDescription.description,
        // 省略即 include_logs=false，serve 会整段跳过诊断收集，反馈包就只剩 recording report。
        includeLogs: true,
        includeTrace: true,
        sessionId: state.activeSession,
        images: selectFeedbackImages(session),
        recordingReport: reportFile(report),
      })
      if (!result.ok) {
        setError(
          result.rateLimited ? t('feedback.rateLimited') : result.error || t('feedback.failed')
        )
        setPhase('review')
        return
      }
      setTicket(result.id || '')
      setPartialDiagnostics(result.diagnostics === 'partial')
      setPhase('done')
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === RECORDING_REPORT_TOO_LARGE
          ? t('feedbackRecorder.errors.reportTooLarge')
          : t('feedback.failed')
      )
      setPhase('review')
    }
  }

  React.useEffect(() => {
    if (phase !== 'idle') return
    const controller = new AbortController()
    const onStart = (): void => {
      if (shortcutBusy.current) return
      shortcutBusy.current = true
      void waitForFrames(CAPTURE_SETTLE_FRAMES)
        .then(() => {
          if (!controller.signal.aborted) return start()
        })
        .catch(() => setError(t('feedbackRecorder.errors.capture_failed')))
        .finally(() => {
          shortcutBusy.current = false
        })
    }
    window.addEventListener(FEEDBACK_RECORDER_START_EVENT, onStart)
    return () => {
      controller.abort()
      window.removeEventListener(FEEDBACK_RECORDER_START_EVENT, onStart)
    }
  }, [phase, start, t])

  const activateFeedback = React.useCallback(() => {
    if (shortcutBusy.current) return
    const action = feedbackShortcutAction(phase, internalEnabled, authenticated)
    if (!action) return
    if (action === 'record') {
      set({ feedbackOpen: false, feedbackScreenshot: null })
      window.dispatchEvent(new Event(FEEDBACK_RECORDER_START_EVENT))
      return
    }
    if (action === 'feedback' && state.feedbackOpen) return
    shortcutBusy.current = true
    void (action === 'feedback' ? act.openFeedback() : capture())
      .catch(() => setError(t('feedbackRecorder.errors.capture_failed')))
      .finally(() => {
        shortcutBusy.current = false
      })
  }, [internalEnabled, authenticated, phase, capture, t, act, set, state.feedbackOpen])

  React.useEffect(
    () => window.scholarseed.onFeedbackShortcut?.(activateFeedback),
    [activateFeedback]
  )

  const shortcut =
    window.scholarseed.platform === 'darwin'
      ? FEEDBACK_SHORTCUT.macLabel
      : FEEDBACK_SHORTCUT.otherLabel

  const openFeedbackForm = (): void => {
    if (shortcutBusy.current || state.feedbackOpen || phase !== 'idle') return
    shortcutBusy.current = true
    void act
      .openFeedback()
      .catch(() => setError(t('feedbackRecorder.errors.capture_failed')))
      .finally(() => {
        shortcutBusy.current = false
      })
  }

  const entry =
    entryHost || (phase === 'idle' && !state.feedbackOpen) ? (
      <TooltipProvider>
        <Tooltip anchorRef={entryRef} portalled side={entryHost ? 'right' : 'left'}>
          <TooltipTrigger asChild>
            {entryHost ? (
              <Button
                unstyled
                ref={setEntrySurface}
                className={navigationRailButtonClassName}
                aria-label={t('feedbackRecorder.entry')}
                data-testid="feedback-recorder-entry"
                {...{ [RECORDER_ROOT_ATTRIBUTE]: 'entry' }}
                disabled={phase !== 'idle'}
                onClick={openFeedbackForm}
              >
                <MessageCircleQuestion strokeWidth={1.45} />
              </Button>
            ) : (
              <IconButton
                ref={setEntrySurface}
                style={floating.style}
                size="md"
                variant="primary"
                className="pointer-events-auto fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] touch-none cursor-pointer !rounded-full !border-[var(--vds-tooltip-bg)] ![background:var(--vds-tooltip-bg)] !text-[var(--vds-tooltip-color)] shadow-[var(--vds-shadow-sm)] hover:shadow-[var(--vds-shadow-focus)] will-change-transform"
                icon={
                  <span className="text-[length:var(--vds-font-headline)] leading-none">?</span>
                }
                label={t('feedbackRecorder.entry')}
                title={undefined}
                data-testid="feedback-recorder-entry"
                {...{ [RECORDER_ROOT_ATTRIBUTE]: 'entry' }}
                {...floating.handleProps}
                onClick={() => {
                  if (!floating.consumeSuppressedClick()) activateFeedback()
                }}
              />
            )}
          </TooltipTrigger>
          <TooltipContent>
            <span className="flex items-center gap-[var(--vds-space-3)]">
              <span>{t('feedbackRecorder.entry')}</span>
              <span className="opacity-[var(--vds-feedback-capture-preview-opacity)]">
                {shortcut}
              </span>
            </span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : null

  return createPortal(
    <div
      ref={rootRef}
      className="pointer-events-none fixed inset-0 z-[var(--vds-z-feedback-recorder)]"
      {...{
        [FOCUS_SCOPE_EXTENSION_ATTRIBUTE]: '',
        [RECORDER_ROOT_ATTRIBUTE]: 'root',
      }}
    >
      {entryHost ? createPortal(entry, entryHost) : entry}
      {(phase === 'recording' || phase === 'paused') && session ? (
        <Capture
          capturing={shutter.busy}
          error={error}
          floating={floating}
          hasStep={Boolean(latestStepRef.current)}
          note={latestStepRef.current ? session.notes[latestStepRef.current.stepId] || '' : ''}
          paused={phase === 'paused'}
          stepCount={session.steps.length}
          steps={session.steps}
          notes={session.notes}
          screenshots={session.screenshots}
          onCapture={() => void capture()}
          onNoteChange={(text) => {
            const step = latestStepRef.current
            if (!step) return
            updateSession((current) => {
              const notes = { ...current.notes }
              if (text) notes[step.stepId] = text
              else delete notes[step.stepId]
              return { ...current, notes }
            })
          }}
          onExit={clearSession}
          onPauseChange={setPaused}
          onStop={stop}
        />
      ) : null}
      {shutter.active ? <ScreenshotShutter /> : null}
      {phase === 'annotating' && annotationContext ? (
        <Annotator
          initialAnnotations={
            annotationContext.mode === 'edit'
              ? session?.screenshots.find(
                  (entry) => entry.screenshotId === annotationContext.screenshotId
                )?.annotations || EMPTY_ANNOTATIONS
              : EMPTY_ANNOTATIONS
          }
          initialNote={annotationContext.mode === 'edit' ? annotationContext.initialNote : ''}
          source={annotationContext.sourceFile}
          onCancel={() => {
            const returnPhase = annotationContext.mode === 'edit' ? 'review' : 'recording'
            setAnnotationContext(null)
            setPhase(returnPhase)
          }}
          onSave={saveScreenshot}
        />
      ) : null}
      {(phase === 'review' || phase === 'submitting') && session ? (
        <Review
          page={reviewPage}
          onPageChange={setReviewPage}
          error={error}
          hasSession={Boolean(state.activeSession)}
          warning={
            descriptionTruncated
              ? t('feedbackRecorder.notices.descriptionTruncated', {
                  limit: RECORDER_DESCRIPTION_MAX_LENGTH,
                })
              : ''
          }
          session={session}
          submitting={phase === 'submitting'}
          summary={summary}
          onCancel={clearSession}
          onEditScreenshot={editScreenshot}
          onDeleteScreenshot={(screenshotId) =>
            updateSession((current) => {
              const target = current.screenshots.find(
                (entry) => entry.screenshotId === screenshotId
              )
              if (target) URL.revokeObjectURL(target.previewUrl)
              return {
                ...current,
                screenshots: current.screenshots.filter(
                  (entry) => entry.screenshotId !== screenshotId
                ),
              }
            })
          }
          onNoteChange={(stepId, text) =>
            updateSession((current) => {
              const notes = { ...current.notes }
              const normalized = normalizeNote(text)
              notes[stepId] = normalized
              return { ...current, notes }
            })
          }
          onSubmit={() => void submit()}
          onSummaryChange={(field, value) =>
            setSummary((current) => ({ ...current, [field]: value }))
          }
        />
      ) : null}
      {phase === 'done' ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) clearSession()
          }}
        >
          <DialogPortal>
            <DialogContent
              className="!z-[var(--vds-z-feedback-recorder-dialog)]"
              overlayClassName="!z-[var(--vds-z-feedback-recorder-overlay)]"
              data-feedback-recorder-root="done"
            >
              <DialogHeader>
                <DialogTitle>{t('feedback.received')}</DialogTitle>
                <DialogDescription>
                  {ticket ? <FeedbackReceipt ticket={ticket} /> : null}
                  {partialDiagnostics ? (
                    <span role="status" data-testid="feedback-partial-diagnostics">
                      {t('feedback.partialDiagnostics')}
                    </span>
                  ) : null}
                  {descriptionTruncated
                    ? t('feedbackRecorder.notices.descriptionTruncated', {
                        limit: RECORDER_DESCRIPTION_MAX_LENGTH,
                      })
                    : null}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button onClick={clearSession}>{t('feedback.done')}</Button>
              </DialogFooter>
            </DialogContent>
          </DialogPortal>
        </Dialog>
      ) : null}
    </div>,
    document.body
  )
}
