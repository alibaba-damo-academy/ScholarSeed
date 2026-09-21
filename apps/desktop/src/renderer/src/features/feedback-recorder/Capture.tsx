import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  Input
} from '../../components/ui'
import type { FloatingSurfaceBinding } from './drag'
import { RECORDER_NOTE_MAX_LENGTH } from './model'

interface CaptureProps {
  elapsedSeconds: number
  error: string
  floating: FloatingSurfaceBinding
  hasStep: boolean
  note: string
  paused: boolean
  requiresCancelConfirmation: boolean
  screenshotCount: number
  stepCount: number
  onCancel: () => void
  onCapture: () => void
  onNoteChange: (text: string) => void
  onPauseChange: (paused: boolean) => void
  onStop: () => void
}

export function Capture({ elapsedSeconds, error, floating, hasStep, note, paused, requiresCancelConfirmation, screenshotCount, stepCount, onCancel, onCapture, onNoteChange, onPauseChange, onStop }: CaptureProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [confirmingCancel, setConfirmingCancel] = React.useState(false)
  const [resumeAfterCancel, setResumeAfterCancel] = React.useState(false)
  const beginCancel = (): void => {
    if (!requiresCancelConfirmation) {
      onCancel()
      return
    }
    setResumeAfterCancel(!paused)
    if (!paused) onPauseChange(true)
    setConfirmingCancel(true)
  }
  const keepRecording = (): void => {
    setConfirmingCancel(false)
    if (resumeAfterCancel) onPauseChange(false)
  }
  return (
    <Card
      ref={floating.setSurface}
      style={floating.style}
      className="pointer-events-auto fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] grid w-[min(360px,calc(100vw-var(--vds-space-8)))] gap-[var(--vds-space-2)] !rounded-[var(--vds-radius-6)] border-[var(--vds-border-brand)] ![background:var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)] will-change-transform"
      data-feedback-recorder-root="controls"
      data-testid="feedback-recorder-controls"
    >
      <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
        <div
          className="flex min-w-0 touch-none cursor-move select-none items-center gap-[var(--vds-space-2)] rounded-full bg-[var(--vds-error-light-bg-default)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]"
          aria-label={t('feedbackRecorder.drag')}
          {...floating.handleProps}
        >
          <span className="inline-flex min-w-0 items-center gap-[var(--vds-space-2)] whitespace-nowrap text-xs font-semibold text-[var(--vds-error-text-primary)]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--vds-error-bg-default)]" />
            {t(paused ? 'feedbackRecorder.paused' : 'feedbackRecorder.recording', { seconds: elapsedSeconds })}
          </span>
          <span aria-hidden className="inline-flex shrink-0 items-center text-[var(--vds-text-secondary)] opacity-70">
            <Icon name="hand" size={14} />
          </span>
        </div>
        {!confirmingCancel ? (
          <div className="flex shrink-0 items-center gap-[var(--vds-space-1)]">
            <Button size="xs" data-testid="feedback-recorder-screenshot" variant="secondary" disabled={!hasStep} onClick={onCapture}>{t('feedbackRecorder.markProblem')}</Button>
            <Button size="xs" data-testid="feedback-recorder-cancel" variant="secondary" onClick={beginCancel}>{t('feedbackRecorder.cancel')}</Button>
            <Button size="xs" data-testid="feedback-recorder-stop" onClick={onStop}>{t('feedbackRecorder.stop')}</Button>
          </div>
        ) : null}
      </div>
      <p className="m-0 rounded-[var(--vds-radius-3)] bg-[var(--vds-bg-gray-default)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-xs leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
        {t('feedbackRecorder.guidance')}
      </p>
      <div className="space-y-[var(--vds-space-1)]">
        <div className="flex items-center justify-between gap-[var(--vds-space-2)] px-[var(--vds-space-1)] text-xs text-[var(--vds-text-secondary)]" aria-live="polite">
          <span className="font-medium text-[var(--vds-text-primary)]">{t('feedbackRecorder.progress', { screenshots: screenshotCount, steps: stepCount })}</span>
          {error ? <span className="max-w-48 truncate text-[var(--vds-error-text-primary)]" title={error}>{error}</span> : null}
        </div>
        <Input
          aria-label={t('feedbackRecorder.note.label')}
          data-testid="feedback-recorder-note"
          disabled={!hasStep}
          maxLength={RECORDER_NOTE_MAX_LENGTH}
          placeholder={t(hasStep ? 'feedbackRecorder.note.label' : 'feedbackRecorder.note.waiting')}
          size="sm"
          value={note}
          onChange={(event) => onNoteChange(event.currentTarget.value)}
        />
      </div>
      {confirmingCancel ? (
        <Alert
          data-testid="feedback-recorder-cancel-confirm"
          tone="error"
        >
          <AlertTitle>{t('feedbackRecorder.cancelConfirm.title')}</AlertTitle>
          <AlertDescription truncate={false}>{t('feedbackRecorder.cancelConfirm.description')}</AlertDescription>
          <div className="flex flex-wrap justify-end gap-[var(--vds-space-2)] pt-[var(--vds-space-2)]">
            <Button size="xs" variant="secondary" onClick={keepRecording}>{t('feedbackRecorder.cancelConfirm.keep')}</Button>
            <Button size="xs" variant="danger" onClick={onCancel}>{t('feedbackRecorder.cancelConfirm.discard')}</Button>
          </div>
        </Alert>
      ) : null}
    </Card>
  )
}
