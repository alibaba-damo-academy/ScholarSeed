import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Textarea
} from '../../components/ui'
import {
  RECORDER_NOTE_MAX_LENGTH,
  type RecordedScreenshot,
  type RecordingSession,
  type StepKind,
  type SummaryFields
} from './model'
import {
  composeReviewHtml,
  composeReviewMarkdown,
  formatClockTime,
  reviewTargetLabel,
  screenshotDataUrls,
  type ReviewMarkdownLabels
} from './markdown'
import { writeClipboardContent, writeClipboardImage } from '../../components/primitive/clipboard'
import { Icon } from '../../icons'

const STEP_NUMBER_OFFSET = 1
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
  hasSession: boolean
  warning: string
  session: RecordingSession
  submitting: boolean
  summary: SummaryFields
  onCancel: () => void
  onDeleteScreenshot: (screenshotId: string) => void
  onEditScreenshot: (screenshotId: string) => void
  onNoteChange: (stepId: string, text: string) => void
  onScreenshotNoteChange: (screenshotId: string, text: string) => void
  onSubmit: () => void
  onSummaryChange: (field: keyof SummaryFields, value: string) => void
}

interface ScreenshotEditorProps {
  screenshot: RecordedScreenshot
  onDelete: (screenshotId: string) => void
  onEdit: (screenshotId: string) => void
  onNoteChange: (screenshotId: string, text: string) => void
}

function ScreenshotEditor({ screenshot, onDelete, onEdit, onNoteChange }: ScreenshotEditorProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [copying, setCopying] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const copy = async (): Promise<void> => {
    if (copying) return
    setCopying(true)
    setCopied(false)
    try {
      await writeClipboardImage(screenshot.renderedFile)
      setCopied(true)
    } finally {
      setCopying(false)
    }
  }
  return (
    <div
      className="space-y-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-3)]"
      data-testid={`feedback-recorder-step-screenshot-${screenshot.screenshotId}`}
    >
      <Button
        variant="ghost"
        className="group relative !h-auto !w-full overflow-hidden !p-0"
        aria-label={t('feedbackRecorder.review.editScreenshot')}
        onClick={() => onEdit(screenshot.screenshotId)}
      >
        <img className="max-h-64 w-full rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] object-contain" src={screenshot.previewUrl} alt={t('feedbackRecorder.review.screenshotAlt')} />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-[var(--vds-space-2)] bg-[var(--vds-other-overlay-1)] text-sm font-medium text-[var(--vds-text-primary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Icon name="edit-square" size={16} />
          {t('feedbackRecorder.review.editScreenshot')}
        </span>
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
  )
}

export function Review({
  error,
  hasSession,
  warning,
  session,
  submitting,
  summary,
  onCancel,
  onDeleteScreenshot,
  onEditScreenshot,
  onNoteChange,
  onScreenshotNoteChange,
  onSubmit,
  onSummaryChange
}: ReviewProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [editingNoteStepId, setEditingNoteStepId] = React.useState<string | null>(null)
  const clipboardHtmlRef = React.useRef('')
  const markdownLabels: ReviewMarkdownLabels = {
    summary: t('feedbackRecorder.review.summary'),
    title: t('feedbackRecorder.review.title'),
    steps: t('feedbackRecorder.review.steps'),
    action: (kind) => t(STEP_ACTION_LABEL_KEYS[kind]),
    sourcePage: (page) => t('feedbackRecorder.review.sourcePage', { value: page }),
    sourceDialog: (page, dialog) => t('feedbackRecorder.review.sourceDialog', { page, dialog }),
    elapsed: (value) => t('feedbackRecorder.elapsedMs', { value }),
    note: (value) => t('feedbackRecorder.review.stepNote', { value }),
    input: t('feedbackRecorder.review.inputValue'),
    emptyValue: t('feedbackRecorder.review.emptyValue'),
    screenshots: t('feedbackRecorder.review.linkedScreenshots'),
    screenshotNote: t('feedbackRecorder.review.screenshotNote'),
    operation: t('feedbackRecorder.review.markdownOperation'),
    target: t('feedbackRecorder.review.markdownTarget'),
    time: t('feedbackRecorder.review.markdownTime')
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onCancel() }}>
      <DialogPortal>
        <DialogContent
          hideCloseButton
          className="![inset:0] !z-[var(--vds-z-feedback-recorder-dialog)] !m-0 !flex !h-auto !w-auto !max-w-none !translate-x-0 !translate-y-0 !transform-none flex-col overflow-hidden !rounded-none !border-0 !p-0 ![box-shadow:none]"
          overlayClassName="!z-[var(--vds-z-feedback-recorder-overlay)]"
          data-feedback-recorder-root="review"
          data-testid="feedback-recorder-review"
        >
        <DialogHeader
          className="shrink-0 px-[calc(var(--vds-space-10)+var(--vds-space-3))] pt-[var(--vds-space-10)]"
          data-testid="feedback-recorder-review-header"
        >
          <DialogTitle>{t('feedbackRecorder.review.title')}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-[var(--vds-space-4)] overflow-y-auto px-[calc(var(--vds-space-10)+var(--vds-space-3))] py-[var(--vds-space-3)]">
          <Card className="space-y-[var(--vds-space-3)] p-[var(--vds-space-4)]">
            <h3 className="text-sm font-semibold text-[var(--vds-text-primary)]">{t('feedbackRecorder.review.summary')}</h3>
            <p className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
              {t('feedbackRecorder.review.summaryHint')}
            </p>
            <Textarea
              aria-label={t('feedbackRecorder.review.final')}
              placeholder={t('feedbackRecorder.review.summaryPlaceholder')}
              rows={3}
              value={summary.final}
              onChange={(event) => onSummaryChange('final', event.currentTarget.value)}
            />
            {warning ? <Alert tone="warning" title={warning} /> : null}
            {error ? <div className="text-xs text-[var(--vds-error-text-primary)]">{error}</div> : null}
          </Card>
          <Card className="space-y-[var(--vds-space-3)] p-[var(--vds-space-4)]">
            <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
              <h3 className="text-sm font-semibold text-[var(--vds-text-primary)]">{t('feedbackRecorder.review.steps')}</h3>
              <Badge tone="neutral">{session.steps.length}</Badge>
            </div>
            <ol className="space-y-[var(--vds-space-3)]">
              {session.steps.map((step, index) => {
                const screenshots = session.screenshots.filter((screenshot) => screenshot.stepId === step.stepId)
                const isEditingNote = editingNoteStepId === step.stepId
                const stepNote = session.notes[step.stepId] || ''
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
                        {stepNote ? (
                          <span className="break-words text-[var(--vds-text-primary)]">
                            {t('feedbackRecorder.review.stepNote', { value: stepNote })}
                          </span>
                        ) : null}
                        {!isEditingNote ? (
                          <Button size="content" variant="link" onClick={() => setEditingNoteStepId(step.stepId)}>
                            {stepNote
                              ? t('feedbackRecorder.review.editStepNote')
                              : t('feedbackRecorder.review.addStepNote')}
                          </Button>
                        ) : null}
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
                    {isEditingNote ? (
                      <div className="flex items-start gap-[var(--vds-space-2)]">
                        <Textarea
                          autoFocus
                          className="!min-h-[var(--vds-control-height-md)] flex-1"
                          maxLength={RECORDER_NOTE_MAX_LENGTH}
                          placeholder={t('feedbackRecorder.note.label')}
                          rows={1}
                          value={stepNote}
                          onChange={(event) => onNoteChange(step.stepId, event.currentTarget.value)}
                        />
                        <Button size="sm" variant="ghost" onClick={() => setEditingNoteStepId(null)}>
                          {t('feedback.done')}
                        </Button>
                      </div>
                    ) : null}
                    {screenshots.length ? (
                      <div className="space-y-[var(--vds-space-2)]">
                        <div className="flex items-center gap-[var(--vds-space-2)] text-xs font-medium text-[var(--vds-text-secondary)]">
                          <span>{t('feedbackRecorder.review.linkedScreenshots')}</span>
                          <Badge tone="neutral">{screenshots.length}</Badge>
                        </div>
                        <div className="grid gap-[var(--vds-space-3)] lg:grid-cols-2">
                          {screenshots.map((screenshot) => (
                            <ScreenshotEditor
                              key={screenshot.screenshotId}
                              screenshot={screenshot}
                              onDelete={onDeleteScreenshot}
                              onEdit={onEditScreenshot}
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
        </div>
        <div className="shrink-0 space-y-[var(--vds-space-3)] border-t border-[var(--vds-border-default)] px-[calc(var(--vds-space-10)+var(--vds-space-3))] pb-[var(--vds-space-5)] pt-[var(--vds-space-3)]">
          <p
            data-testid="feedback-recorder-diagnostics-notice"
            className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
          >
            {hasSession
              ? t('feedbackRecorder.review.diagnosticsNotice')
              : t('feedbackRecorder.review.diagnosticsNoticeNoSession')}
          </p>
          <DialogFooter>
            <Button disabled={submitting} variant="secondary" onClick={onCancel}>{t('feedbackRecorder.cancel')}</Button>
            <CopyButton
              copiedLabel={t('feedbackRecorder.review.copied')}
              disabled={submitting}
              getValue={async () => {
                const screenshotSources = await screenshotDataUrls(session.screenshots)
                clipboardHtmlRef.current = composeReviewHtml(session, summary, markdownLabels, screenshotSources)
                return composeReviewMarkdown(session, summary, markdownLabels)
              }}
              idleLabel={t('feedbackRecorder.review.copyMarkdown')}
              size="md"
              writeText={(text) => writeClipboardContent(text, clipboardHtmlRef.current)}
            />
            <Button data-testid="feedback-recorder-submit" disabled={!summary.final.trim()} loading={submitting} onClick={onSubmit}>
              {t('feedbackRecorder.review.submit')}
            </Button>
          </DialogFooter>
        </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
