import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Textarea,
  IconButton,
  Tooltip,
} from '../../components/ui'
import {
  RECORDER_NOTE_MAX_LENGTH,
  type RecordingSession,
  type RecordedScreenshot,
  type StepKind,
  type SummaryFields,
} from './model'
import {
  composeReviewHtml,
  composeReviewMarkdown,
  compactStepDescription,
  reviewStepNote,
  screenshotDataUrls,
  type ReviewMarkdownLabels,
} from './markdown'
import { writeClipboardContent } from '../../components/primitive/clipboard'
import { ChevronLeft, ChevronRight, Pencil, Image, X, Copy } from 'lucide-react'

const STEPS_PER_PAGE = 5
const STEP_ACTION_LABEL_KEYS = {
  click: 'feedbackRecorder.actions.click',
  input: 'feedbackRecorder.actions.input',
  change: 'feedbackRecorder.actions.change',
  navigation: 'feedbackRecorder.actions.navigation',
} as const satisfies Record<StepKind, string>

interface ReviewProps {
  page: number
  onPageChange: (page: number) => void
  error: string
  hasSession: boolean
  warning: string
  session: RecordingSession
  submitting: boolean
  summary: SummaryFields
  onCancel: () => void
  onDeleteScreenshot: (screenshotId: string) => void
  onEditScreenshot: (screenshotId: string, note: string) => void
  onNoteChange: (stepId: string, text: string) => void
  onSubmit: () => void
  onSummaryChange: (field: keyof SummaryFields, value: string) => void
}

function ScreenshotStrip({
  screenshots,
  note,
  disabled,
  onDelete,
  onEdit,
}: {
  screenshots: readonly RecordedScreenshot[]
  note: string
  disabled: boolean
  onDelete: (id: string) => void
  onEdit: (id: string, note: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [offset, setOffset] = React.useState(0)
  const lastOffset = Math.max(0, screenshots.length - 3)
  const activeOffset = Math.min(offset, lastOffset)
  return (
    <div
      className="flex shrink-0 items-center gap-[var(--vds-space-1)]"
      data-testid="feedback-review-image-strip"
    >
      {lastOffset > 0 && (
        <IconButton
          size="mini"
          variant="ghost"
          disabled={disabled || activeOffset === 0}
          label={t('feedbackRecorder.review.previousImages')}
          icon={<ChevronLeft />}
          onClick={() => setOffset(activeOffset - 1)}
        />
      )}
      {screenshots.slice(activeOffset, activeOffset + 3).map((screenshot) => (
        <div
          key={screenshot.screenshotId}
          data-testid="feedback-review-screenshot"
          className="group relative size-[calc(var(--vds-space-10)+var(--vds-space-2))] shrink-0 rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]"
        >
          <img
            src={screenshot.previewUrl}
            alt={t('feedbackRecorder.review.screenshotAlt')}
            className="h-full w-full rounded-[var(--vds-radius-2)] object-contain"
          />
          <div
            data-testid="feedback-review-screenshot-actions"
            className="pointer-events-none absolute inset-0 flex items-center justify-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-2)] bg-[var(--vds-bg-mask)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-[var(--vds-opacity-full)] group-focus-within:pointer-events-auto group-focus-within:opacity-[var(--vds-opacity-full)]"
          >
            <Tooltip
              content={t('feedbackRecorder.review.editScreenshot')}
              contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
            >
              <IconButton
                size="mini"
                variant="ghost"
                className="!text-[var(--vds-static-white)] enabled:hover:![background:var(--vds-other-overlay-1)] enabled:active:![background:var(--vds-other-overlay-2)]"
                disabled={disabled}
                label={t('feedbackRecorder.review.editScreenshot')}
                icon={<Pencil />}
                onClick={() => onEdit(screenshot.screenshotId, note)}
              />
            </Tooltip>
          </div>
          <Tooltip
            content={t('feedbackRecorder.review.deleteScreenshot')}
            className="pointer-events-none !absolute -right-[var(--vds-space-1)] -top-[var(--vds-space-1)] z-[var(--vds-z-local-control)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-[var(--vds-opacity-full)] group-focus-within:pointer-events-auto group-focus-within:opacity-[var(--vds-opacity-full)]"
            contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
          >
            <IconButton
              size="mini"
              variant="ghost"
              className="!size-[var(--vds-space-4)] !min-w-[var(--vds-space-4)] !rounded-[var(--vds-radius-circle)] !border-0 !bg-[var(--vds-tooltip-bg)] !p-0 !text-[var(--vds-static-white)]"
              disabled={disabled}
              label={t('feedbackRecorder.review.deleteScreenshot')}
              icon={<X />}
              onClick={() => onDelete(screenshot.screenshotId)}
            />
          </Tooltip>
        </div>
      ))}
      {lastOffset > 0 && (
        <IconButton
          size="mini"
          variant="ghost"
          disabled={disabled || activeOffset === lastOffset}
          label={t('feedbackRecorder.review.nextImages')}
          icon={<ChevronRight />}
          onClick={() => setOffset(activeOffset + 1)}
        />
      )}
    </div>
  )
}

export function Review({
  page,
  onPageChange,
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
  onSubmit,
  onSummaryChange,
}: ReviewProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [editingNoteStepId, setEditingNoteStepId] = React.useState<string | null>(null)
  const [noteDraft, setNoteDraft] = React.useState('')
  const clipboardHtmlRef = React.useRef('')
  const lastPage = Math.max(0, Math.ceil(session.steps.length / STEPS_PER_PAGE) - 1)
  const activePage = Math.min(page, lastPage)
  const visibleSteps = session.steps.slice(
    activePage * STEPS_PER_PAGE,
    (activePage + 1) * STEPS_PER_PAGE
  )
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
    time: t('feedbackRecorder.review.markdownTime'),
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel()
      }}
    >
      <DialogPortal>
        <DialogContent
          hideCloseButton
          className="!z-[var(--vds-z-feedback-recorder-dialog)] !flex max-h-[calc(100dvh-var(--vds-space-8))] !w-[var(--vds-feedback-dialog-width)] !max-w-none flex-col !gap-[var(--vds-space-4)] overflow-hidden !rounded-[var(--vds-radius-6)] !p-[var(--vds-space-5)]"
          overlayClassName="!z-[var(--vds-z-feedback-recorder-overlay)]"
          data-feedback-recorder-root="review"
          data-testid="feedback-recorder-review"
        >
          <DialogHeader
            className="!flex !flex-row items-center justify-between !space-y-0"
            data-testid="feedback-recorder-review-header"
          >
            <DialogTitle>{t('feedbackRecorder.review.title')}</DialogTitle>
            <IconButton
              variant="ghost"
              size="sm"
              label={t('feedbackRecorder.cancel')}
              icon={<X />}
              disabled={submitting}
              onClick={onCancel}
            />
          </DialogHeader>
          <div className="m-0 min-h-0 min-w-0 space-y-[var(--vds-space-4)] overflow-y-auto border-0 p-0">
            <Alert
              tone="info"
              data-testid="feedback-recorder-diagnostics-notice"
              className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
            >
              {hasSession
                ? t('feedbackRecorder.review.diagnosticsNotice')
                : t('feedbackRecorder.review.diagnosticsNoticeNoSession')}
            </Alert>
            <div className="grid gap-[var(--vds-space-2)]">
              <label
                htmlFor="feedback-review-summary"
                className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]"
              >
                {t('feedbackRecorder.review.final')}
              </label>
              <div className="overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-control-border)] bg-[var(--vds-bg-white-default)] focus-within:border-[var(--vds-border-brand)]">
                <Textarea
                  disabled={submitting}
                  id="feedback-review-summary"
                  aria-label={t('feedbackRecorder.review.final')}
                  rows={3}
                  maxLength={RECORDER_NOTE_MAX_LENGTH}
                  placeholder={t('feedbackRecorder.review.summaryPlaceholder')}
                  className="!min-h-0 !resize-none !overflow-y-auto !border-0 !bg-transparent !shadow-none"
                  value={summary.final}
                  onChange={(event) => onSummaryChange('final', event.currentTarget.value)}
                />
                <div className="px-[var(--vds-space-3)] pb-[var(--vds-space-2)] text-right text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                  {summary.final.length}/{RECORDER_NOTE_MAX_LENGTH}
                </div>
              </div>
            </div>
            {warning ? <Alert tone="warning" title={warning} /> : null}
            <section className="space-y-[var(--vds-space-2)]">
              <div className="flex items-center gap-[var(--vds-space-1)]">
                <h3 className="me-auto text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]">
                  {t('feedbackRecorder.review.steps')}
                </h3>
                <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                  {t('feedbackRecorder.recordedSteps', { count: session.steps.length })}
                </span>
                <IconButton
                  variant="ghost"
                  size="xs"
                  label={t('feedbackRecorder.previousSteps')}
                  icon={<ChevronLeft />}
                  disabled={submitting || activePage === 0}
                  onClick={() => {
                    onPageChange(activePage - 1)
                    setEditingNoteStepId(null)
                  }}
                />
                <IconButton
                  variant="ghost"
                  size="xs"
                  label={t('feedbackRecorder.nextSteps')}
                  icon={<ChevronRight />}
                  disabled={submitting || activePage === lastPage}
                  onClick={() => {
                    onPageChange(activePage + 1)
                    setEditingNoteStepId(null)
                  }}
                />
              </div>
              <ol
                className="m-0 grid list-none gap-[var(--vds-space-2)] p-0"
                data-testid="feedback-review-steps"
              >
                {visibleSteps.map((step, offset) => {
                  const screenshots = session.screenshots.filter(
                    (screenshot) => screenshot.stepId === step.stepId
                  )
                  const stepNote = reviewStepNote(session, step.stepId)
                  const isEditingNote = editingNoteStepId === step.stepId
                  const label = compactStepDescription(step, {
                    action: (kind) => t(STEP_ACTION_LABEL_KEYS[kind]),
                    sourcePage: (page) => t('feedbackRecorder.review.sourcePage', { value: page }),
                    sourceDialog: (page, dialog) =>
                      t('feedbackRecorder.review.sourceDialog', { page, dialog }),
                  })
                  return (
                    <li
                      key={step.stepId}
                      className="min-w-0 rounded-[var(--vds-radius-3)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-2)]"
                    >
                      <div className="flex min-w-0 items-start gap-[var(--vds-space-2)]">
                        {screenshots.length ? (
                          <ScreenshotStrip
                            screenshots={screenshots}
                            note={stepNote}
                            disabled={submitting}
                            onDelete={onDeleteScreenshot}
                            onEdit={onEditScreenshot}
                          />
                        ) : (
                          <span
                            className="flex h-[calc(var(--vds-space-10)+var(--vds-space-2))] w-[calc(var(--vds-space-10)+var(--vds-space-2))] shrink-0 items-center justify-center rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] text-[var(--vds-text-tertiary)]"
                            aria-label={t('feedbackRecorder.review.noScreenshot')}
                          >
                            <Image size={20} aria-hidden />
                          </span>
                        )}
                        <div className="grid min-h-[calc(var(--vds-space-10)+var(--vds-space-2))] min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] content-between items-center gap-x-[var(--vds-space-2)] gap-y-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]">
                          <span className="self-start" data-testid="feedback-review-step-number">
                            {activePage * STEPS_PER_PAGE + offset + 1}.
                          </span>
                          <Tooltip
                            content={label}
                            className="min-w-0"
                            contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
                          >
                            <p className="truncate" data-testid="feedback-review-step-title">
                              {label}
                            </p>
                          </Tooltip>
                          <div
                            className="col-start-2 flex min-w-0 items-end gap-[var(--vds-space-1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]"
                            data-testid="feedback-review-note-row"
                          >
                            <span className="shrink-0">
                              {t('feedbackRecorder.review.problemNote')}
                            </span>
                            <Tooltip
                              content={stepNote || t('feedbackRecorder.review.notFilled')}
                              className="min-w-0 flex-1"
                              contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)] max-w-[var(--vds-feedback-recorder-width)] whitespace-pre-wrap break-words"
                            >
                              <p
                                className={`truncate ${stepNote ? '' : 'text-[var(--vds-text-tertiary)]'}`}
                              >
                                {stepNote || t('feedbackRecorder.review.notFilled')}
                              </p>
                            </Tooltip>
                            {!isEditingNote && (
                              <Tooltip
                                content={t('feedbackRecorder.review.editStepNote')}
                                contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
                              >
                                <IconButton
                                  size="xs"
                                  variant="ghost"
                                  disabled={submitting}
                                  label={t('feedbackRecorder.review.editStepNote')}
                                  icon={<Pencil />}
                                  className="shrink-0 !text-[var(--vds-icon-outline-default)]"
                                  onClick={() => {
                                    setNoteDraft(stepNote)
                                    setEditingNoteStepId(step.stepId)
                                  }}
                                />
                              </Tooltip>
                            )}
                          </div>
                          {isEditingNote && (
                            <div
                              data-testid="feedback-review-note-editor"
                              className="col-start-2 min-w-0 overflow-hidden rounded-[var(--vds-radius-3)] border border-[var(--vds-control-border)] bg-[var(--vds-bg-white-default)] focus-within:border-[var(--vds-border-brand)]"
                            >
                              <Textarea
                                autoFocus
                                disabled={submitting}
                                aria-label={t('feedbackRecorder.review.editStepNote')}
                                rows={3}
                                maxLength={RECORDER_NOTE_MAX_LENGTH}
                                className="!min-h-0 !resize-none !overflow-y-auto !border-0 !bg-transparent !shadow-none !font-[var(--vds-fw-regular)]"
                                value={noteDraft}
                                onChange={(event) => setNoteDraft(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    setEditingNoteStepId(null)
                                  }
                                }}
                              />
                              <div
                                data-testid="feedback-review-note-actions"
                                className="flex items-center justify-end gap-[var(--vds-space-2)] px-[var(--vds-space-3)] pb-[var(--vds-space-2)]"
                              >
                                <span className="me-[var(--vds-space-1)] text-[var(--vds-text-tertiary)]">
                                  {noteDraft.length}/{RECORDER_NOTE_MAX_LENGTH}
                                </span>
                                <Button
                                  size="xs"
                                  variant="tertiary"
                                  disabled={submitting}
                                  onClick={() => setEditingNoteStepId(null)}
                                >
                                  {t('feedbackRecorder.review.cancelNoteEdit')}
                                </Button>
                                <Button
                                  size="xs"
                                  disabled={submitting}
                                  onClick={() => {
                                    onNoteChange(step.stepId, noteDraft)
                                    setEditingNoteStepId(null)
                                  }}
                                >
                                  {t('feedbackRecorder.review.confirmNoteEdit')}
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </section>
          </div>
          {error ? (
            <Alert tone="error" title={error} data-testid="feedback-recorder-submit-error" />
          ) : null}
          <DialogFooter
            data-testid="feedback-review-footer"
            className="shrink-0 !flex !flex-row flex-wrap items-center !justify-between gap-[var(--vds-space-2)]"
          >
            <CopyButton
              variant="tertiary"
              icon={<Copy size={16} />}
              copiedLabel={t('feedbackRecorder.review.copied')}
              disabled={submitting}
              getValue={async () => {
                const screenshotSources = await screenshotDataUrls(session.screenshots)
                clipboardHtmlRef.current = composeReviewHtml(
                  session,
                  summary,
                  markdownLabels,
                  screenshotSources
                )
                return composeReviewMarkdown(session, summary, markdownLabels)
              }}
              idleLabel={t('feedbackRecorder.review.copyMarkdown')}
              size="md"
              writeText={(text) => writeClipboardContent(text, clipboardHtmlRef.current)}
            />
            <div className="flex gap-[var(--vds-space-2)]">
              <Button disabled={submitting} variant="outline" onClick={onCancel}>
                {t('feedbackRecorder.cancel')}
              </Button>
              <Button
                data-testid="feedback-recorder-submit"
                disabled={submitting}
                loading={submitting}
                onClick={onSubmit}
              >
                {t('feedbackRecorder.review.submit')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
