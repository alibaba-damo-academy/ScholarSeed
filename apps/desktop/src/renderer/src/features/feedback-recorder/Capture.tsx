import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import {
  Button,
  Card,
  Collapsible,
  CollapsibleTrigger,
  EllipsisText,
  Textarea,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
} from '../../components/ui'
import { isRecorderDragBlockedTarget, type FloatingSurfaceBinding } from './drag'
import { compactStepLabel } from './markdown'
import {
  RECORDER_NOTE_MAX_LENGTH,
  type RecordedScreenshot,
  type RecordedStep,
  type StepKind,
} from './model'
import { Pause, Play, ChevronLeft, ChevronRight, MessageSquareText, ScanLine } from 'lucide-react'

const STEPS_PER_PAGE = 5

const DRAG_TOOLTIP_DELAY_MS = 600
const STEP_ACTION_LABEL_KEYS = {
  click: 'feedbackRecorder.actions.click',
  input: 'feedbackRecorder.actions.input',
  change: 'feedbackRecorder.actions.change',
  navigation: 'feedbackRecorder.actions.navigation',
} as const satisfies Record<StepKind, string>

interface CaptureProps {
  capturing?: boolean
  error: string
  floating: FloatingSurfaceBinding
  hasStep: boolean
  note: string
  paused: boolean
  stepCount: number
  steps: readonly RecordedStep[]
  screenshots?: readonly RecordedScreenshot[]
  notes: Readonly<Record<string, string>>
  onExit: () => void
  onCapture: () => void
  onNoteChange: (text: string) => void
  onPauseChange: (paused: boolean) => void
  onStop: () => void
}

export function Capture({
  capturing = false,
  error,
  floating,
  hasStep,
  note,
  paused,
  stepCount,
  steps,
  notes,
  screenshots = [],
  onExit,
  onCapture,
  onNoteChange,
  onPauseChange,
  onStop,
}: CaptureProps): React.JSX.Element {
  const { t, i18n } = useTranslation('components')
  const mac =
    (window.scholarseed?.platform ?? navigator.platform).toLowerCase().match(/darwin|mac/) !== null
  const screenshotShortcut = mac ? '⌘⇧S' : 'Ctrl+Shift+S'
  React.useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (!hasStep || capturing || event.defaultPrevented || event.repeat || event.isComposing)
        return
      if (event.code !== 'KeyS' || !event.shiftKey || event.altKey) return
      if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return
      event.preventDefault()
      onCapture()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [mac, hasStep, capturing, onCapture])

  const [dragTooltipOpen, setDragTooltipOpen] = React.useState(false)
  const [stepsExpanded, setStepsExpanded] = React.useState(false)
  const dragSurfaceRef = React.useRef<HTMLElement | null>(null)
  const [stepPage, setStepPage] = React.useState(0)
  const latestPage = Math.max(0, Math.ceil(steps.length / STEPS_PER_PAGE) - 1)
  const activePage = Math.min(stepPage, latestPage)
  const visibleSteps = stepsExpanded
    ? steps.slice(activePage * STEPS_PER_PAGE, (activePage + 1) * STEPS_PER_PAGE)
    : steps.slice(-1)
  const dragTooltipTimerRef = React.useRef<number | null>(null)
  const setDragSurface = React.useCallback(
    (node: HTMLElement | null): void => {
      dragSurfaceRef.current = node
      floating.setSurface(node)
    },
    [floating.setSurface]
  )
  const closeDragTooltip = React.useCallback((): void => {
    if (dragTooltipTimerRef.current !== null) window.clearTimeout(dragTooltipTimerRef.current)
    dragTooltipTimerRef.current = null
    setDragTooltipOpen(false)
  }, [])
  const scheduleDragTooltip = React.useCallback(
    (target: EventTarget | null): void => {
      if (isRecorderDragBlockedTarget(target)) {
        closeDragTooltip()
        return
      }
      if (dragTooltipOpen || dragTooltipTimerRef.current !== null) return
      dragTooltipTimerRef.current = window.setTimeout(() => {
        dragTooltipTimerRef.current = null
        setDragTooltipOpen(true)
      }, DRAG_TOOLTIP_DELAY_MS)
    },
    [closeDragTooltip, dragTooltipOpen]
  )
  React.useEffect(() => closeDragTooltip, [closeDragTooltip])
  React.useLayoutEffect(() => {
    setStepPage(latestPage)
  }, [steps.length, latestPage])
  return (
    <TooltipProvider>
      <Card
        ref={setDragSurface}
        style={{
          ...floating.style,
          width: `min(var(${i18n.resolvedLanguage === 'en' ? '--vds-feedback-recorder-width-expanded' : '--vds-feedback-recorder-width'}), calc(100vw - var(--vds-space-8)))`,
        }}
        className="pointer-events-auto fixed bottom-[var(--vds-space-4)] right-[var(--vds-space-4)] grid touch-none cursor-move gap-[var(--vds-space-2)] !rounded-[var(--vds-radius-6)] border-[var(--vds-border-brand)] ![background:var(--vds-surface-raised)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-3-center)] will-change-transform"
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
        <div
          data-testid="feedback-recorder-status-bar"
          className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]"
        >
          <span
            className="me-auto inline-flex items-center gap-[var(--vds-space-2)] whitespace-nowrap text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-secondary)]"
            aria-live="off"
          >
            <span data-testid="feedback-recorder-header-count">
              {t('feedbackRecorder.recordedSteps', { count: stepCount })}
            </span>
          </span>
          {
            <>
              <Tooltip
                content={t(paused ? 'feedbackRecorder.resume' : 'feedbackRecorder.pause')}
                contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
                side="top"
              >
                <IconButton
                  variant="tertiary"
                  size="sm"
                  label={t(paused ? 'feedbackRecorder.resume' : 'feedbackRecorder.pause')}
                  icon={paused ? <Play /> : <Pause />}
                  disabled={capturing}
                  onClick={() => onPauseChange(!paused)}
                />
              </Tooltip>
              <Tooltip
                content={t('feedbackRecorder.screenshotShortcutHint', {
                  shortcut: screenshotShortcut,
                })}
                contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
              >
                <Button
                  size="sm"
                  variant="tertiary"
                  icon={<ScanLine />}
                  data-testid="feedback-recorder-screenshot"
                  aria-keyshortcuts={mac ? 'Meta+Shift+S' : 'Control+Shift+S'}
                  disabled={!hasStep || capturing}
                  loading={capturing}
                  onClick={onCapture}
                >
                  {t('feedbackRecorder.markProblem')}
                </Button>
              </Tooltip>
            </>
          }
        </div>
        <Collapsible
          data-testid="feedback-recorder-step-section"
          open={stepsExpanded}
          onOpenChange={(expanded) => {
            if (expanded) setStepPage(0)
            setStepsExpanded(expanded)
          }}
        >
          <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
            <CollapsibleTrigger asChild>
              <Button
                className="!px-0 !gap-[calc(var(--vds-space-1)+var(--vds-space-half))] !text-[length:var(--vds-font-body-lv1)] !font-[var(--vds-fw-regular)]"
                data-floating-drag-ignore
                data-testid="feedback-recorder-steps-toggle"
                size="sm"
                variant="ghost"
              >
                {t('feedbackRecorder.stepsLabel')}
                <Icon name={stepsExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
              </Button>
            </CollapsibleTrigger>
            {stepsExpanded && steps.length > STEPS_PER_PAGE && (
              <div
                data-floating-drag-ignore
                data-testid="feedback-recorder-step-pager"
                className="flex items-center gap-[var(--vds-space-1)]"
              >
                <IconButton
                  label={t('feedbackRecorder.previousSteps')}
                  icon={<ChevronLeft />}
                  variant="ghost"
                  size="xs"
                  disabled={activePage === 0}
                  onClick={() => setStepPage(activePage - 1)}
                />
                <IconButton
                  label={t('feedbackRecorder.nextSteps')}
                  icon={<ChevronRight />}
                  variant="ghost"
                  size="xs"
                  disabled={activePage === latestPage}
                  onClick={() => setStepPage(activePage + 1)}
                />
              </div>
            )}
          </div>
          <div
            data-floating-drag-ignore
            data-testid="feedback-recorder-steps"
            aria-live="polite"
            className="overflow-hidden"
          >
            <ol className="m-0 grid list-none gap-[var(--vds-space-1)] p-0">
              {visibleSteps.map((step, offset) => {
                const index = stepsExpanded
                  ? activePage * STEPS_PER_PAGE + offset
                  : steps.length - 1
                const text = compactStepLabel(step, index, {
                  action: (kind) => t(STEP_ACTION_LABEL_KEYS[kind]),
                  sourcePage: (page) => t('feedbackRecorder.review.sourcePage', { value: page }),
                  sourceDialog: (page, dialog) =>
                    t('feedbackRecorder.review.sourceDialog', { page, dialog }),
                })
                const images = screenshots.filter(
                  (image) => image.stepId === step.stepId && !image.automatic
                )
                const details = [
                  notes[step.stepId],
                  ...(images.length
                    ? [t('feedbackRecorder.note.screenshotCount', { count: images.length })]
                    : []),
                  ...images.map((image) => image.note).filter(Boolean),
                ].filter(Boolean)
                return (
                  <li
                    key={stepsExpanded ? step.stepId : 'latest'}
                    className="flex min-w-0 cursor-default items-center gap-[var(--vds-space-2)] overflow-hidden rounded-[var(--vds-radius-3)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]"
                  >
                    <div
                      key={step.stepId}
                      className={
                        stepsExpanded
                          ? 'min-w-0 flex-1'
                          : 'min-w-0 flex-1 motion-safe:[animation:vds-carousel-slide-up_var(--vds-duration-normal)_var(--vds-ease-standard)]'
                      }
                    >
                      <EllipsisText
                        tooltipPortalled
                        tooltipContentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)] max-w-[var(--vds-feedback-recorder-width)] whitespace-pre-wrap break-words"
                      >
                        {text}
                      </EllipsisText>
                    </div>
                    {details.length ? (
                      <Tooltip
                        content={details.join('\n\n')}
                        contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)] max-w-[var(--vds-feedback-recorder-width)] whitespace-pre-wrap break-words"
                        side="top"
                      >
                        <IconButton
                          size="xs"
                          variant="ghost"
                          label={t('feedbackRecorder.note.viewSubmitted')}
                          icon={<MessageSquareText />}
                          data-testid="feedback-recorder-submitted-note"
                        />
                      </Tooltip>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          </div>
        </Collapsible>
        <div className="pt-[var(--vds-space-2)]" data-testid="feedback-recorder-note-section">
          <div className="cursor-text overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-control-border)] bg-[var(--vds-bg-white-default)] focus-within:border-[var(--vds-border-brand)]">
            <Textarea
              aria-label={t('feedbackRecorder.note.label')}
              data-testid="feedback-recorder-note"
              disabled={!hasStep || capturing}
              maxLength={RECORDER_NOTE_MAX_LENGTH}
              rows={3}
              placeholder={t('feedbackRecorder.note.placeholder')}
              className="!min-h-0 !resize-none !overflow-y-auto !border-0 !bg-transparent !shadow-none !font-[var(--vds-fw-regular)] placeholder:!font-[var(--vds-fw-regular)]"
              value={note}
              onChange={(event) => onNoteChange(event.currentTarget.value)}
            />
            <div className="flex items-center justify-end gap-[var(--vds-space-3)] px-[var(--vds-space-3)] pb-[var(--vds-space-2)]">
              <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                {note.length}/{RECORDER_NOTE_MAX_LENGTH}
              </span>
            </div>
          </div>
          {error && (
            <p
              role="alert"
              className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-error-text-primary)]"
            >
              {error}
            </p>
          )}
        </div>
        <div data-floating-drag-ignore className="flex justify-end gap-[var(--vds-space-3)]">
          <Button
            size="sm"
            variant="outline"
            data-testid="feedback-recorder-exit"
            disabled={capturing}
            onClick={onExit}
          >
            {t('feedbackRecorder.exit')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="feedback-recorder-stop"
            disabled={capturing}
            onClick={onStop}
          >
            {t('feedbackRecorder.stop')}
          </Button>
        </div>
      </Card>
      <Tooltip anchorRef={dragSurfaceRef} open={dragTooltipOpen} portalled side="top">
        <TooltipContent className="!z-[var(--vds-z-feedback-recorder-nested-dialog)]">
          {t('feedbackRecorder.dragHint')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
