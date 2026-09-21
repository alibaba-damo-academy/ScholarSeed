import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import {
  Alert,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Textarea
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
  screenshotCount: number
  stepCount: number
  onCancel: () => void
  onCapture: () => void
  onNoteChange: (text: string) => void
  onPauseChange: (paused: boolean) => void
  onStop: () => void
}

export function Capture({ elapsedSeconds, error, floating, hasStep, note, paused, screenshotCount, stepCount, onCancel, onCapture, onNoteChange, onPauseChange, onStop }: CaptureProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [noteOpen, setNoteOpen] = React.useState(false)
  const [confirmingCancel, setConfirmingCancel] = React.useState(false)
  const [resumeAfterCancel, setResumeAfterCancel] = React.useState(false)
  const beginCancel = (): void => {
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
      className="fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] grid w-[min(360px,calc(100vw-var(--vds-space-8)))] gap-[var(--vds-space-3)] !rounded-[var(--vds-radius-6)] border-[var(--vds-border-brand)] ![background:var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)] will-change-transform"
      data-feedback-recorder-root="controls"
      data-testid="feedback-recorder-controls"
    >
      <div
        className="flex touch-none cursor-move select-none items-center justify-between gap-[var(--vds-space-3)] rounded-[var(--vds-radius-3)] bg-[var(--vds-brand-light-bg-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]"
        aria-label={t('feedbackRecorder.drag')}
        {...floating.handleProps}
      >
        <span className="inline-flex items-center gap-[var(--vds-space-2)] text-xs font-semibold text-[var(--vds-error-text-primary)]">
          <span className="h-2 w-2 rounded-full bg-[var(--vds-error-bg-default)]" />
          {t(paused ? 'feedbackRecorder.paused' : 'feedbackRecorder.recording', { seconds: elapsedSeconds })}
        </span>
        <span className="inline-flex items-center gap-[var(--vds-space-1)] text-xs text-[var(--vds-text-secondary)]">
          <Icon name="hand" size={14} />
          {t('feedbackRecorder.drag')}
        </span>
      </div>
      <div className="flex items-center justify-between gap-[var(--vds-space-2)] text-xs text-[var(--vds-text-secondary)]" aria-live="polite">
        <span>{t('feedbackRecorder.progress', { screenshots: screenshotCount, steps: stepCount })}</span>
        {error ? <span className="max-w-48 truncate text-[var(--vds-error-text-primary)]" title={error}>{error}</span> : null}
      </div>
      <Button className="!w-full" size="sm" disabled={!hasStep} variant="ghost" onClick={() => setNoteOpen(true)}>
        {t('feedbackRecorder.note.action')}
      </Button>
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogPortal>
          <DialogContent
            className="!z-[var(--vds-z-feedback-recorder-dialog)]"
            overlayClassName="!z-[var(--vds-z-feedback-recorder-overlay)]"
            data-feedback-recorder-root="note"
          >
            <DialogHeader>
              <DialogTitle>{t('feedbackRecorder.note.title')}</DialogTitle>
              <DialogDescription>{t('feedbackRecorder.note.linked')}</DialogDescription>
            </DialogHeader>
            <Textarea
              autoFocus
              data-testid="feedback-recorder-note"
              label={t('feedbackRecorder.note.label')}
              maxLength={RECORDER_NOTE_MAX_LENGTH}
              rows={4}
              value={note}
              onChange={(event) => onNoteChange(event.currentTarget.value)}
            />
            <DialogFooter>
              <Button onClick={() => setNoteOpen(false)}>{t('feedbackRecorder.note.done')}</Button>
            </DialogFooter>
          </DialogContent>
        </DialogPortal>
      </Dialog>
      {confirmingCancel ? (
        <Alert
          data-testid="feedback-recorder-cancel-confirm"
          tone="error"
          title={t('feedbackRecorder.cancelConfirm.title')}
          description={t('feedbackRecorder.cancelConfirm.description')}
          action={(
            <div className="flex flex-wrap justify-end gap-[var(--vds-space-2)]">
              <Button size="xs" variant="secondary" onClick={keepRecording}>{t('feedbackRecorder.cancelConfirm.keep')}</Button>
              <Button size="xs" variant="danger" onClick={onCancel}>{t('feedbackRecorder.cancelConfirm.discard')}</Button>
            </div>
          )}
        />
      ) : (
        <div className="flex flex-wrap justify-end gap-[var(--vds-space-2)]">
          <Button size="sm" data-testid="feedback-recorder-pause" variant="secondary" onClick={() => onPauseChange(!paused)}>{t(paused ? 'feedbackRecorder.resume' : 'feedbackRecorder.pause')}</Button>
          <Button size="sm" data-testid="feedback-recorder-screenshot" variant="secondary" disabled={!hasStep} onClick={onCapture}>{t('feedbackRecorder.markProblem')}</Button>
          <Button size="sm" data-testid="feedback-recorder-cancel" variant="secondary" onClick={beginCancel}>{t('feedbackRecorder.cancel')}</Button>
          <Button size="sm" data-testid="feedback-recorder-stop" onClick={onStop}>{t('feedbackRecorder.stop')}</Button>
        </div>
      )}
    </Card>
  )
}
