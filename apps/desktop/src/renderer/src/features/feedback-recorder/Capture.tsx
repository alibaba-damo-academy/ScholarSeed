import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import { Button, Card, Textarea } from '../../components/ui'
import type { FloatingSurfaceBinding } from './drag'
import { RECORDER_NOTE_MAX_LENGTH } from './model'

interface CaptureProps {
  elapsedSeconds: number
  error: string
  floating: FloatingSurfaceBinding
  hasStep: boolean
  note: string
  onCancel: () => void
  onCapture: () => void
  onNoteChange: (text: string) => void
  onStop: () => void
}

export function Capture({ elapsedSeconds, error, floating, hasStep, note, onCancel, onCapture, onNoteChange, onStop }: CaptureProps): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <Card
      ref={floating.setSurface}
      style={floating.style}
      className="fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] z-[var(--vds-z-feedback-recorder)] grid w-[min(420px,calc(100vw-var(--vds-space-8)))] gap-[var(--vds-space-3)] !rounded-[var(--vds-radius-6)] border-[var(--vds-border-brand)] ![background:var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)] will-change-transform"
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
          {t('feedbackRecorder.recording', { seconds: elapsedSeconds })}
        </span>
        <span className="inline-flex items-center gap-[var(--vds-space-1)] text-xs text-[var(--vds-text-secondary)]">
          <Icon name="hand" size={14} />
          {t('feedbackRecorder.drag')}
        </span>
      </div>
      {error ? <span className="max-w-48 truncate text-xs text-[var(--vds-error-text-primary)]" title={error}>{error}</span> : null}
      <Textarea
        data-testid="feedback-recorder-note"
        disabled={!hasStep}
        label={t('feedbackRecorder.note.label')}
        helperText={hasStep ? t('feedbackRecorder.note.linked') : t('feedbackRecorder.note.waiting')}
        maxLength={RECORDER_NOTE_MAX_LENGTH}
        rows={3}
        value={note}
        onChange={(event) => onNoteChange(event.currentTarget.value)}
      />
      <div className="flex flex-wrap justify-end gap-[var(--vds-space-2)]">
        <Button data-testid="feedback-recorder-screenshot" variant="secondary" onClick={onCapture}>{t('feedbackRecorder.screenshot')}</Button>
        <Button data-testid="feedback-recorder-cancel" variant="secondary" onClick={onCancel}>{t('feedbackRecorder.cancel')}</Button>
        <Button data-testid="feedback-recorder-stop" onClick={onStop}>{t('feedbackRecorder.stop')}</Button>
      </div>
    </Card>
  )
}
