import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EllipsisText,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider
} from '../../components/ui'
import { isRecorderDragBlockedTarget, type FloatingSurfaceBinding } from './drag'
import { compactStepLabel } from './markdown'
import { RECORDER_NOTE_MAX_LENGTH, type RecordedStep, type StepKind } from './model'
import { scrollStepListToLatest } from './scroll'

const DRAG_TOOLTIP_DELAY_MS = 600
const STEP_ACTION_LABEL_KEYS = {
  click: 'feedbackRecorder.actions.click',
  input: 'feedbackRecorder.actions.input',
  change: 'feedbackRecorder.actions.change',
  navigation: 'feedbackRecorder.actions.navigation'
} as const satisfies Record<StepKind, string>

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
  steps: readonly RecordedStep[]
  onCancel: () => void
  onCapture: () => void
  onNoteChange: (text: string) => void
  onPauseChange: (paused: boolean) => void
  onStop: () => void
}

export function Capture({ elapsedSeconds, error, floating, hasStep, note, paused, requiresCancelConfirmation, screenshotCount, stepCount, steps, onCancel, onCapture, onNoteChange, onPauseChange, onStop }: CaptureProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [confirmingCancel, setConfirmingCancel] = React.useState(false)
  const [resumeAfterCancel, setResumeAfterCancel] = React.useState(false)
  const [dragTooltipOpen, setDragTooltipOpen] = React.useState(false)
  const [stepsExpanded, setStepsExpanded] = React.useState(false)
  const dragSurfaceRef = React.useRef<HTMLElement | null>(null)
  const stepListRef = React.useRef<HTMLDivElement | null>(null)
  const dragTooltipTimerRef = React.useRef<number | null>(null)
  const setDragSurface = React.useCallback((node: HTMLElement | null): void => {
    dragSurfaceRef.current = node
    floating.setSurface(node)
  }, [floating.setSurface])
  const closeDragTooltip = React.useCallback((): void => {
    if (dragTooltipTimerRef.current !== null) window.clearTimeout(dragTooltipTimerRef.current)
    dragTooltipTimerRef.current = null
    setDragTooltipOpen(false)
  }, [])
  const scheduleDragTooltip = React.useCallback((target: EventTarget | null): void => {
    if (isRecorderDragBlockedTarget(target)) {
      closeDragTooltip()
      return
    }
    if (dragTooltipOpen || dragTooltipTimerRef.current !== null) return
    dragTooltipTimerRef.current = window.setTimeout(() => {
      dragTooltipTimerRef.current = null
      setDragTooltipOpen(true)
    }, DRAG_TOOLTIP_DELAY_MS)
  }, [closeDragTooltip, dragTooltipOpen])
  React.useEffect(() => closeDragTooltip, [closeDragTooltip])
  React.useLayoutEffect(() => {
    scrollStepListToLatest(stepListRef.current, stepsExpanded)
  }, [steps.length, stepsExpanded])
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
    <TooltipProvider>
      <Card
      ref={setDragSurface}
      style={floating.style}
      className="pointer-events-auto fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] grid w-[min(360px,calc(100vw-var(--vds-space-8)))] touch-none cursor-move gap-[var(--vds-space-2)] !rounded-[var(--vds-radius-6)] border-[var(--vds-border-brand)] ![background:var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-lg)] will-change-transform"
      data-feedback-recorder-root="controls"
      data-testid="feedback-recorder-controls"
      onLostPointerCapture={floating.handleProps.onLostPointerCapture}
      onPointerCancel={floating.handleProps.onPointerCancel}
      onPointerDown={(event) => {
        closeDragTooltip()
        floating.handleProps.onPointerDown(event)
      }}
      onPointerEnter={(event) => scheduleDragTooltip(event.target)}
      onPointerLeave={closeDragTooltip}
      onPointerMove={(event) => {
        if (event.buttons) closeDragTooltip()
        else scheduleDragTooltip(event.target)
        floating.handleProps.onPointerMove(event)
      }}
      onPointerUp={floating.handleProps.onPointerUp}
    >
      <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
        <span aria-hidden className="inline-flex shrink-0 items-center text-[var(--vds-text-secondary)] opacity-70">
          <Icon name="hand" size={14} />
        </span>
        <div className="flex min-w-0 select-none items-center gap-[var(--vds-space-2)] rounded-full bg-[var(--vds-error-light-bg-default)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]">
          <span className="inline-flex min-w-0 items-center gap-[var(--vds-space-2)] whitespace-nowrap text-xs font-semibold text-[var(--vds-error-text-primary)]">
            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--vds-error-bg-default)]" />
            {t(paused ? 'feedbackRecorder.paused' : 'feedbackRecorder.recording', { seconds: elapsedSeconds })}
          </span>
        </div>
        {!confirmingCancel ? (
          <div className="ms-auto flex shrink-0 items-center gap-[var(--vds-space-1)]">
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
          className="cursor-text"
          size="sm"
          value={note}
          onChange={(event) => onNoteChange(event.currentTarget.value)}
        />
      </div>
      <Collapsible open={stepsExpanded} onOpenChange={setStepsExpanded}>
        <CollapsibleTrigger asChild>
          <Button
            className="!w-full justify-between"
            data-floating-drag-ignore
            data-testid="feedback-recorder-steps-toggle"
            size="xs"
            variant="ghost"
          >
            <span>{t('feedbackRecorder.stepsToggle', { count: steps.length })}</span>
            <Icon name={stepsExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent
          className="max-h-40 overflow-y-auto border-0 bg-transparent p-0 shadow-none"
          data-floating-drag-ignore
          data-testid="feedback-recorder-steps"
          ref={stepListRef}
        >
          <ol className="m-0 grid list-none gap-[var(--vds-space-1)] p-0">
            {steps.map((step, index) => {
              const text = compactStepLabel(step, index, {
                action: (kind) => t(STEP_ACTION_LABEL_KEYS[kind]),
                sourcePage: (page) => t('feedbackRecorder.review.sourcePage', { value: page }),
                sourceDialog: (page, dialog) => t('feedbackRecorder.review.sourceDialog', { page, dialog })
              })
              return (
                <li key={step.stepId} className="min-w-0 cursor-default rounded-[var(--vds-radius-2)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-xs text-[var(--vds-text-secondary)]">
                  <EllipsisText tooltipPortalled>{text}</EllipsisText>
                </li>
              )
            })}
          </ol>
        </CollapsibleContent>
      </Collapsible>
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
      <Tooltip anchorRef={dragSurfaceRef} open={dragTooltipOpen} portalled side="top">
        <TooltipContent>{t('feedbackRecorder.dragHint')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
