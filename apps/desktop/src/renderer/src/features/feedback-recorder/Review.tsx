import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea
} from '../../components/ui'
import {
  RECORDER_NOTE_MAX_LENGTH,
  type RecordedScreenshot,
  type RecordedStep,
  type RecordingSession,
  type StepKind,
  type SummaryFields
} from './model'
import { targetDisplayLabel } from './target'
import { writeClipboardImage } from '../../components/primitive/clipboard'

const CLOCK_PART_WIDTH = 2
const MILLISECOND_PART_WIDTH = 3
const STEP_NUMBER_OFFSET = 1
const MINIMUM_ELAPSED_MS = 0
const UNKNOWN_CLOCK_LABEL = '--:--:--.---'
const PAGE_LANDMARK_TAGS = new Set(['main', 'section', 'aside'])
const STEP_ACTION_TONES: Record<StepKind, 'brand' | 'neutral' | 'success' | 'warning'> = {
  click: 'brand',
  input: 'success',
  change: 'warning',
  navigation: 'neutral'
}
const STEP_ACTION_LABEL_KEYS = {
  click: 'feedbackRecorder.actions.click',
  input: 'feedbackRecorder.actions.input',
  change: 'feedbackRecorder.actions.change',
  navigation: 'feedbackRecorder.actions.navigation'
} as const satisfies Record<StepKind, string>

interface ReviewProps {
  error: string
  warning: string
  session: RecordingSession
  submitting: boolean
  summary: SummaryFields
  onCancel: () => void
  onDeleteScreenshot: (screenshotId: string) => void
  onNoteChange: (stepId: string, text: string) => void
  onScreenshotNoteChange: (screenshotId: string, text: string) => void
  onSubmit: () => void
  onSummaryChange: (field: keyof SummaryFields, value: string) => void
}

function requestTone(status?: number, error?: string): 'error' | 'success' | 'neutral' {
  if (error || (status !== undefined && status >= 400)) return 'error'
  if (status !== undefined) return 'success'
  return 'neutral'
}

function formatClockTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return UNKNOWN_CLOCK_LABEL
  const hours = String(date.getHours()).padStart(CLOCK_PART_WIDTH, '0')
  const minutes = String(date.getMinutes()).padStart(CLOCK_PART_WIDTH, '0')
  const seconds = String(date.getSeconds()).padStart(CLOCK_PART_WIDTH, '0')
  const milliseconds = String(date.getMilliseconds()).padStart(MILLISECOND_PART_WIDTH, '0')
  return `${hours}:${minutes}:${seconds}.${milliseconds}`
}

function elapsedFromStart(value: string, startedAtMs: number): number {
  const occurredAtMs = Date.parse(value)
  if (!Number.isFinite(occurredAtMs)) return MINIMUM_ELAPSED_MS
  return Math.max(MINIMUM_ELAPSED_MS, occurredAtMs - startedAtMs)
}

function reviewTargetLabel(step: RecordedStep): string {
  if (PAGE_LANDMARK_TAGS.has(step.target.tag) && step.page.label) return step.page.label
  return targetDisplayLabel(step.target)
}

interface ScreenshotEditorProps {
  screenshot: RecordedScreenshot
  onDelete: (screenshotId: string) => void
  onNoteChange: (screenshotId: string, text: string) => void
}

function ScreenshotEditor({ screenshot, onDelete, onNoteChange }: ScreenshotEditorProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [zoomed, setZoomed] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const copy = async (): Promise<void> => {
    if (copying) return
    setCopying(true)
    setCopied(false)
    try {
      await writeClipboardImage(screenshot.file)
      setCopied(true)
    } finally {
      setCopying(false)
    }
  }
  return (
    <>
    <div
      className="space-y-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-3)]"
      data-testid={`feedback-recorder-step-screenshot-${screenshot.screenshotId}`}
    >
      <Button variant="ghost" className="!h-auto !w-full !p-0" aria-label={t('feedbackRecorder.review.zoomScreenshot')} onClick={() => setZoomed(true)}>
        <img className="max-h-64 w-full rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] object-contain" src={screenshot.previewUrl} alt={t('feedbackRecorder.review.screenshotAlt')} />
      </Button>
      <Textarea
        label={t('feedbackRecorder.review.screenshotNote')}
        maxLength={RECORDER_NOTE_MAX_LENGTH}
        value={screenshot.note}
        onChange={(event) => onNoteChange(screenshot.screenshotId, event.currentTarget.value)}
      />
      <div className="flex flex-wrap gap-[var(--vds-space-2)]">
        <Button variant="secondary" loading={copying} onClick={() => void copy()}>{copied ? t('feedbackRecorder.review.copied') : t('feedbackRecorder.review.copyScreenshot')}</Button>
        <Button variant="secondary" onClick={() => onDelete(screenshot.screenshotId)}>{t('feedbackRecorder.review.deleteScreenshot')}</Button>
      </div>
    </div>
    <Dialog open={zoomed} onOpenChange={setZoomed}>
      <DialogContent aria-label={t('feedbackRecorder.review.zoomScreenshot')} className="!top-0 !left-0 !h-screen !w-screen !max-w-none !translate-x-0 !translate-y-0 !transform-none !flex !flex-col !rounded-none !border-0 !p-[var(--vds-space-4)]">
        <DialogHeader><DialogTitle>{t('feedbackRecorder.review.zoomScreenshot')}</DialogTitle></DialogHeader>
        <img className="min-h-0 min-w-0 flex-1 rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] object-contain" src={screenshot.previewUrl} alt={t('feedbackRecorder.review.screenshotAlt')} />
        <DialogFooter><Button variant="secondary" loading={copying} onClick={() => void copy()}>{copied ? t('feedbackRecorder.review.copied') : t('feedbackRecorder.review.copyScreenshot')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}

export function Review({
  error,
  warning,
  session,
  submitting,
  summary,
  onCancel,
  onDeleteScreenshot,
  onNoteChange,
  onScreenshotNoteChange,
  onSubmit,
  onSummaryChange
}: ReviewProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const stepNumberById = new Map(
    session.steps.map((step, index) => [step.stepId, index + STEP_NUMBER_OFFSET])
  )
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onCancel() }}>
      <DialogContent
        hideCloseButton
        className="!z-[var(--vds-z-modal)] !flex !h-[calc(100vh-32px)] !w-[calc(100vw-32px)] !max-w-none flex-col gap-[var(--vds-space-3)] overflow-hidden !p-[var(--vds-space-4)]"
        overlayClassName="!z-[var(--vds-z-overlay)]"
        data-feedback-recorder-root="review"
      >
        <DialogHeader>
          <DialogTitle>{t('feedbackRecorder.review.title')}</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] gap-[var(--vds-space-4)] overflow-hidden">
          <div className="min-h-0 space-y-[var(--vds-space-3)] overflow-y-auto pr-[var(--vds-space-1)]">
            <Card className="space-y-[var(--vds-space-3)] p-[var(--vds-space-4)]">
              <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
                <h3 className="text-sm font-semibold text-[var(--vds-text-primary)]">{t('feedbackRecorder.review.steps')}</h3>
                <Badge tone="neutral">{session.steps.length}</Badge>
              </div>
              <ol className="space-y-[var(--vds-space-3)]">
                {session.steps.map((step, index) => {
                  const screenshots = session.screenshots.filter((screenshot) => screenshot.stepId === step.stepId)
                  return (
                    <li key={step.stepId} className="space-y-[var(--vds-space-3)] rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] p-[var(--vds-space-3)]">
                      <div className="space-y-[var(--vds-space-1)]">
                        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)] text-sm text-[var(--vds-text-primary)]">
                          <Badge tone="brand">{index + STEP_NUMBER_OFFSET}</Badge>
                          <span className="text-[var(--vds-text-secondary)]">
                            {step.page.dialogLabel
                              ? t('feedbackRecorder.review.sourceDialog', {
                                page: step.page.label || step.page.title,
                                dialog: step.page.dialogLabel
                              })
                              : t('feedbackRecorder.review.sourcePage', {
                                value: step.page.label || step.page.title
                              })}
                          </span>
                          <Badge tone={STEP_ACTION_TONES[step.kind]}>
                            {t(STEP_ACTION_LABEL_KEYS[step.kind])}
                          </Badge>
                          <span className="font-medium">{reviewTargetLabel(step)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)] text-xs text-[var(--vds-text-secondary)]">
                          <time dateTime={step.occurredAt}>{formatClockTime(step.occurredAt)}</time>
                          <span>{t('feedbackRecorder.elapsedMs', { value: step.elapsedMs })}</span>
                        </div>
                        {step.value !== undefined ? (
                          <div className="flex gap-[var(--vds-space-2)] text-xs text-[var(--vds-text-secondary)]">
                            <span className="shrink-0 font-medium">{t('feedbackRecorder.review.inputValue')}</span>
                            <span className="break-all text-[var(--vds-text-primary)]">
                              {step.value || t('feedbackRecorder.review.emptyValue')}
                            </span>
                          </div>
                        ) : null}
                      </div>
                      <Textarea
                        className="!min-h-[var(--vds-control-height-md)]"
                        maxLength={RECORDER_NOTE_MAX_LENGTH}
                        placeholder={t('feedbackRecorder.note.label')}
                        rows={1}
                        value={session.notes[step.stepId] || ''}
                        onChange={(event) => onNoteChange(step.stepId, event.currentTarget.value)}
                      />
                      {screenshots.length ? (
                        <div className="space-y-[var(--vds-space-2)]">
                          <div className="flex items-center gap-[var(--vds-space-2)] text-xs font-medium text-[var(--vds-text-secondary)]">
                            <span>{t('feedbackRecorder.review.linkedScreenshots')}</span>
                            <Badge tone="neutral">{screenshots.length}</Badge>
                          </div>
                          <div className="grid gap-[var(--vds-space-3)]">
                            {screenshots.map((screenshot) => (
                              <ScreenshotEditor
                                key={screenshot.screenshotId}
                                screenshot={screenshot}
                                onDelete={onDeleteScreenshot}
                                onNoteChange={onScreenshotNoteChange}
                              />
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ol>
            </Card>
            <Card className="space-y-[var(--vds-space-3)] p-[var(--vds-space-4)]">
              <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
                <h3 className="text-sm font-semibold text-[var(--vds-text-primary)]">{t('feedbackRecorder.review.requests')}</h3>
                <Badge tone="neutral">{session.requests.length}</Badge>
              </div>
              <div className="space-y-[var(--vds-space-2)]">
                {session.requests.map((request) => {
                  const linkedStep = request.stepId ? stepNumberById.get(request.stepId) : undefined
                  return (
                    <details key={request.requestId} className="rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] p-[var(--vds-space-3)] text-xs">
                      <summary className="flex cursor-pointer items-center gap-[var(--vds-space-2)] text-[var(--vds-text-primary)]">
                        <Badge tone={requestTone(request.status, request.error)}>{request.status || request.error || '...'}</Badge>
                        <span>{request.method}</span>
                        <span className="min-w-0 flex-1 truncate">{request.url}</span>
                        <time className="whitespace-nowrap text-[var(--vds-text-secondary)]" dateTime={request.startedAt}>{formatClockTime(request.startedAt)}</time>
                        <span className="whitespace-nowrap text-[var(--vds-text-secondary)]">{t('feedbackRecorder.elapsedMs', { value: elapsedFromStart(request.startedAt, session.startedAtMs) })}</span>
                        <span className="whitespace-nowrap">{t('feedbackRecorder.durationMs', { value: request.durationMs })}</span>
                      </summary>
                      <div className="mt-[var(--vds-space-2)] space-y-[var(--vds-space-2)] break-all whitespace-pre-wrap text-[var(--vds-text-secondary)]">
                        {linkedStep ? <div>{t('feedbackRecorder.review.linkedStep', { id: linkedStep })}</div> : null}
                        {request.requestBody ? <pre className="overflow-auto">{request.requestBody}</pre> : null}
                        {request.responseBody ? <pre className="overflow-auto">{request.responseBody}</pre> : null}
                        {request.error ? <div className="text-[var(--vds-error-text-primary)]">{request.error}</div> : null}
                      </div>
                    </details>
                  )
                })}
              </div>
            </Card>
          </div>
          <Card className="min-h-0 space-y-[var(--vds-space-3)] overflow-y-auto p-[var(--vds-space-4)]">
            <h3 className="text-sm font-semibold text-[var(--vds-text-primary)]">{t('feedbackRecorder.review.summary')}</h3>
            <Textarea
              label={t('feedbackRecorder.review.final')}
              value={summary.final}
              onChange={(event) => onSummaryChange('final', event.currentTarget.value)}
            />
            <Textarea
              label={t('feedbackRecorder.review.actual')}
              value={summary.actual}
              onChange={(event) => onSummaryChange('actual', event.currentTarget.value)}
            />
            <Textarea
              label={t('feedbackRecorder.review.expected')}
              value={summary.expected}
              onChange={(event) => onSummaryChange('expected', event.currentTarget.value)}
            />
            <Textarea
              label={t('feedbackRecorder.review.additional')}
              value={summary.additional}
              onChange={(event) => onSummaryChange('additional', event.currentTarget.value)}
            />
            {warning ? <Alert tone="warning" title={warning} /> : null}
            {error ? <div className="text-xs text-[var(--vds-error-text-primary)]">{error}</div> : null}
          </Card>
        </div>
        <DialogFooter>
          <Button disabled={submitting} variant="secondary" onClick={onCancel}>{t('feedbackRecorder.cancel')}</Button>
          <Button data-testid="feedback-recorder-submit" disabled={!summary.final.trim()} loading={submitting} onClick={onSubmit}>
            {t('feedbackRecorder.review.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
