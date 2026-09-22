import React from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import { submitFeedback } from '../../api'
import {
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../../components/ui'
import { CAPTURE_SETTLE_FRAMES, waitForFrames } from '../../frames'
import { useApp } from '../../store'
import { Annotator, type AnnotatorResult } from './Annotator'
import { Capture } from './Capture'
import { useFloatingSurface } from './drag'
import {
  RECORDER_MAX_REQUESTS,
  RECORDER_MAX_STEPS,
  RECORDER_DESCRIPTION_MAX_LENGTH,
  RECORDER_ROOT_ATTRIBUTE,
  createRecordingSession,
  normalizeNote,
  requiresDiscardConfirmation,
  type RecorderPhase,
  type RecordingSession,
  type SummaryFields
} from './model'
import { createInitialPageStep, installRecorderProbe, type RecorderLease } from './probe'
import {
  buildRecordingReport,
  composeFinalDescription,
  generateSummary,
  prepareDescriptionForSubmission,
  reportFile
} from './report'
import { Review } from './Review'
import type { FeedbackCaptureError } from '../../../../feedback'

const SCREENSHOT_LIMIT = 5

function blankSummary(): SummaryFields {
  return { generated: '', final: '', actual: '', expected: '', additional: '' }
}

function captureErrorText(t: TFunction<'components'>, error: FeedbackCaptureError): string {
  if (error === 'capture_empty') return t('feedbackRecorder.errors.capture_empty')
  if (error === 'capture_too_large') return t('feedbackRecorder.errors.capture_too_large')
  if (error === 'invalid_sender') return t('feedbackRecorder.errors.invalid_sender')
  return t('feedbackRecorder.errors.capture_failed')
}

export function Recorder(): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state } = useApp()
  const rootRef = React.useRef<HTMLDivElement>(null)
  const leaseRef = React.useRef<RecorderLease | null>(null)
  const sessionRef = React.useRef<RecordingSession | null>(null)
  const latestStepRef = React.useRef<RecordingSession['steps'][number]>()
  const stepCountRef = React.useRef(0)
  const entryRef = React.useRef<HTMLButtonElement | null>(null)
  const [phase, setPhase] = React.useState<RecorderPhase>('idle')
  const floating = useFloatingSurface(phase)
  const setEntrySurface = React.useCallback((node: HTMLButtonElement | null): void => {
    entryRef.current = node
    floating.setSurface(node)
  }, [floating.setSurface])
  const [session, setSession] = React.useState<RecordingSession | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0)
  const [captureSource, setCaptureSource] = React.useState<File | null>(null)
  const [summary, setSummary] = React.useState<SummaryFields>(blankSummary)
  const [error, setError] = React.useState('')
  const [ticket, setTicket] = React.useState('')
  const [descriptionTruncated, setDescriptionTruncated] = React.useState(false)

  const dispose = React.useCallback((): void => {
    leaseRef.current?.dispose()
    leaseRef.current = null
  }, [])

  const clearSession = React.useCallback((): void => {
    dispose()
    sessionRef.current?.screenshots.forEach((screenshot) => URL.revokeObjectURL(screenshot.previewUrl))
    sessionRef.current = null
    setSession(null)
    latestStepRef.current = undefined
    stepCountRef.current = 0
    setElapsedSeconds(0)
    setCaptureSource(null)
    setSummary(blankSummary())
    setError('')
    setTicket('')
    setDescriptionTruncated(false)
    setPhase('idle')
  }, [dispose])

  React.useEffect(() => {
    sessionRef.current = session
  }, [session])

  React.useEffect(() => () => {
    leaseRef.current?.dispose()
    sessionRef.current?.screenshots.forEach((screenshot) => URL.revokeObjectURL(screenshot.previewUrl))
  }, [])

  const updateSession = React.useCallback((update: (current: RecordingSession) => RecordingSession): void => {
    const current = sessionRef.current
    if (!current) return
    const next = update(current)
    sessionRef.current = next
    setSession(next)
  }, [])

  React.useEffect(() => {
    if (phase !== 'recording' || !session) return
    const update = (): void => setElapsedSeconds(Math.floor((Date.now() - session.startedAtMs) / 1000))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [phase, session?.sessionId])

  const installProbe = React.useCallback((startedAtMs: number): void => {
    leaseRef.current = installRecorderProbe({
      startedAtMs,
      latestStep: () => latestStepRef.current,
      onStep: (step) => {
        if (stepCountRef.current >= RECORDER_MAX_STEPS) {
          updateSession((current) => ({ ...current, truncated: { ...current.truncated, steps: true } }))
          return
        }
        stepCountRef.current += 1
        latestStepRef.current = step
        updateSession((current) => ({ ...current, steps: [...current.steps, step] }))
      },
      onRequest: (request) => {
        updateSession((current) => {
          if (current.requests.length >= RECORDER_MAX_REQUESTS) {
            return { ...current, truncated: { ...current.truncated, requests: true } }
          }
          return { ...current, requests: [...current.requests, request] }
        })
      }
    })
  }, [updateSession])

  const start = (): void => {
    dispose()
    const created = createRecordingSession()
    const initialStep = createInitialPageStep(created.startedAtMs)
    const next = { ...created, steps: [initialStep] }
    sessionRef.current = next
    latestStepRef.current = initialStep
    stepCountRef.current = next.steps.length
    installProbe(next.startedAtMs)
    setSession(next)
    setPhase('recording')
  }

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
      finalPage: window.location.href
    }
    sessionRef.current = stopped
    const generated = generateSummary(stopped, {
      step: (index, kind, target, note) => t('feedbackRecorder.summary.step', { index, kind, target, note }),
      screenshots: (count) => t('feedbackRecorder.summary.screenshots', { count }),
      screenshotNote: (index, note) => t('feedbackRecorder.summary.screenshotNote', { index, note }),
      empty: t('feedbackRecorder.summary.empty')
    })
    setSession(stopped)
    setSummary({ ...blankSummary(), generated })
    setPhase('review')
  }

  const capture = async (): Promise<void> => {
    if (!session || session.screenshots.length >= SCREENSHOT_LIMIT) {
      setError(t('feedbackRecorder.errors.screenshotLimit'))
      return
    }
    setError('')
    const root = rootRef.current
    if (root) root.style.visibility = 'hidden'
    let result
    try {
      await waitForFrames(CAPTURE_SETTLE_FRAMES)
      result = await window.scholarseed.captureFeedbackScreenshot()
    } catch {
      setError(t('feedbackRecorder.errors.capture_failed'))
      return
    } finally {
      if (root) root.style.visibility = ''
    }
    if (!result.ok) {
      setError(captureErrorText(t, result.error))
      return
    }
    const bytes = new Uint8Array(result.bytes.byteLength)
    bytes.set(result.bytes)
    setCaptureSource(new File([bytes.buffer], `feedback-source-${Date.now()}.png`, { type: 'image/png' }))
    setPhase('annotating')
  }

  const saveScreenshot = (result: AnnotatorResult): void => {
    const step = latestStepRef.current
    if (!step) {
      setError(t('feedbackRecorder.errors.screenshotRequiresStep'))
      setCaptureSource(null)
      setPhase('recording')
      return
    }
    updateSession((current) => ({
      ...current,
      screenshots: [...current.screenshots, {
        screenshotId: crypto.randomUUID(),
        stepId: step.stepId,
        ...result,
        note: normalizeNote(result.note)
      }]
    }))
    setCaptureSource(null)
    setPhase('recording')
  }

  const submit = async (): Promise<void> => {
    if (!session) return
    setPhase('submitting')
    setError('')
    try {
      if (!session.endedAt) throw new Error('recording_not_stopped')
      const report = buildRecordingReport(session, session.endedAt, summary)
      const description = composeFinalDescription(summary, {
        actual: t('feedbackRecorder.description.actual'),
        expected: t('feedbackRecorder.description.expected'),
        additional: t('feedbackRecorder.description.additional'),
        operations: t('feedbackRecorder.description.operations'),
        requests: t('feedbackRecorder.description.requests'),
        empty: t('feedbackRecorder.description.empty'),
        moreInReport: t('feedbackRecorder.description.moreInReport'),
        page: (value) => t('feedbackRecorder.description.page', { value }),
        dialog: (value) => t('feedbackRecorder.description.dialog', { value }),
        locator: (value) => t('feedbackRecorder.description.locator', { value }),
        containers: (value) => t('feedbackRecorder.description.containers', { value }),
        pointer: (x, y) => t('feedbackRecorder.description.pointer', { x, y }),
        bounds: (x, y, width, height) => t('feedbackRecorder.description.bounds', {
          x, y, width, height
        }),
        operation: (index, occurredAt, elapsedMs, kind, target, value, note, diagnostics) => t(
          'feedbackRecorder.description.operation',
          {
            index,
            occurredAt,
            elapsedMs,
            kind,
            target,
            value: value ? t('feedbackRecorder.description.operationValue', { value }) : '',
            note: note ? t('feedbackRecorder.description.operationNote', { note }) : '',
            diagnostics
          }
        ),
        request: (index, startedAt, elapsedMs, method, url, status, durationMs, linkedStep) => t(
          'feedbackRecorder.description.request',
          {
            index,
            startedAt,
            elapsedMs,
            method,
            url,
            status,
            durationMs,
            linkedStep: linkedStep === undefined
              ? ''
              : t('feedbackRecorder.description.requestStep', { index: linkedStep })
          }
        )
      }, session)
      const preparedDescription = prepareDescriptionForSubmission(
        description,
        t('feedbackRecorder.notices.descriptionTruncated', {
          limit: RECORDER_DESCRIPTION_MAX_LENGTH
        })
      )
      setDescriptionTruncated(preparedDescription.truncated)
      const result = await submitFeedback({
        description: preparedDescription.description,
        // 省略即 include_logs=false，serve 会整段跳过诊断收集，反馈包就只剩 recording report。
        includeLogs: true,
        includeTrace: true,
        sessionId: state.activeSession,
        images: session.screenshots
          .filter((screenshot) => session.steps.some((step) => step.stepId === screenshot.stepId))
          .map((screenshot) => screenshot.file),
        recordingReport: reportFile(report)
      })
      if (!result.ok) {
        setError(result.rateLimited ? t('feedback.rateLimited') : result.error || t('feedback.failed'))
        setPhase('review')
        return
      }
      setTicket(result.id || '')
      setPhase('done')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('feedback.failed'))
      setPhase('review')
    }
  }

  return createPortal((
    <div
      ref={rootRef}
      className="pointer-events-none fixed inset-0 z-[var(--vds-z-feedback-recorder)]"
      {...{
        [FOCUS_SCOPE_EXTENSION_ATTRIBUTE]: '',
        [RECORDER_ROOT_ATTRIBUTE]: 'root'
      }}
    >
      {phase === 'idle' ? (
        <TooltipProvider>
          <Tooltip anchorRef={entryRef} portalled>
            <TooltipTrigger asChild>
              <IconButton
                ref={setEntrySurface}
                style={floating.style}
                size="xs"
                className="pointer-events-auto fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] touch-none cursor-move !rounded-full !border-[var(--vds-error-light-border)] ![background:var(--vds-surface-raised)] shadow-[var(--vds-shadow-md)] transition-[background-color,border-color,box-shadow,transform] hover:!border-[var(--vds-error-bg-default)] hover:![background:var(--vds-error-light-bg-default)] hover:shadow-[var(--vds-shadow-focus)] will-change-transform"
                icon={(
                  <span className="block h-1.5 w-1.5 rounded-full bg-[var(--vds-error-bg-default)]" />
                )}
                label={t('feedbackRecorder.entry')}
                title={undefined}
                data-testid="feedback-recorder-entry"
                {...floating.handleProps}
                onClick={() => {
                  if (!floating.consumeSuppressedClick()) start()
                }}
              />
            </TooltipTrigger>
            <TooltipContent>{t('feedbackRecorder.entry')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {(phase === 'recording' || phase === 'paused') && session ? (
        <Capture
          elapsedSeconds={elapsedSeconds}
          error={error}
          floating={floating}
          hasStep={Boolean(latestStepRef.current)}
          note={latestStepRef.current ? session.notes[latestStepRef.current.stepId] || '' : ''}
          paused={phase === 'paused'}
          requiresCancelConfirmation={requiresDiscardConfirmation(session)}
          screenshotCount={session.screenshots.length}
          stepCount={session.steps.length}
          onCancel={clearSession}
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
          onPauseChange={setPaused}
          onStop={stop}
        />
      ) : null}
      {phase === 'annotating' && captureSource ? (
        <Annotator
          source={captureSource}
          onCancel={() => { setCaptureSource(null); setPhase('recording') }}
          onSave={saveScreenshot}
        />
      ) : null}
      {(phase === 'review' || phase === 'submitting') && session ? (
        <Review
          error={error}
          hasSession={Boolean(state.activeSession)}
          warning={descriptionTruncated
            ? t('feedbackRecorder.notices.descriptionTruncated', {
              limit: RECORDER_DESCRIPTION_MAX_LENGTH
            })
            : ''}
          session={session}
          submitting={phase === 'submitting'}
          summary={summary}
          onCancel={clearSession}
          onDeleteScreenshot={(screenshotId) => updateSession((current) => {
            const target = current.screenshots.find((entry) => entry.screenshotId === screenshotId)
            if (target) URL.revokeObjectURL(target.previewUrl)
            return { ...current, screenshots: current.screenshots.filter((entry) => entry.screenshotId !== screenshotId) }
          })}
          onNoteChange={(stepId, text) => updateSession((current) => {
            const notes = { ...current.notes }
            const normalized = normalizeNote(text)
            if (normalized) notes[stepId] = normalized
            else delete notes[stepId]
            return { ...current, notes }
          })}
          onScreenshotNoteChange={(screenshotId, text) => updateSession((current) => ({
            ...current,
            screenshots: current.screenshots.map((entry) => entry.screenshotId === screenshotId ? { ...entry, note: normalizeNote(text) } : entry)
          }))}
          onSubmit={() => void submit()}
          onSummaryChange={(field, value) => setSummary((current) => ({ ...current, [field]: value }))}
        />
      ) : null}
      {phase === 'done' ? (
        <Dialog open onOpenChange={(open) => { if (!open) clearSession() }}>
          <DialogPortal>
            <DialogContent
              className="!z-[var(--vds-z-feedback-recorder-dialog)]"
              overlayClassName="!z-[var(--vds-z-feedback-recorder-overlay)]"
              data-feedback-recorder-root="done"
            >
              <DialogHeader>
                <DialogTitle>{t('feedback.received')}</DialogTitle>
                <DialogDescription>
                  {[
                    ticket ? t('feedbackRecorder.done.ticket', { ticket }) : '',
                    descriptionTruncated
                      ? t('feedbackRecorder.notices.descriptionTruncated', {
                        limit: RECORDER_DESCRIPTION_MAX_LENGTH
                      })
                      : ''
                  ].filter(Boolean).join(' ')}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter><Button onClick={clearSession}>{t('feedback.done')}</Button></DialogFooter>
            </DialogContent>
          </DialogPortal>
        </Dialog>
      ) : null}
    </div>
  ), document.body)
}
