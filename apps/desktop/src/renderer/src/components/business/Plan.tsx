import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, CircleAlert, CircleDashed, Clock3, type LucideIcon } from 'lucide-react'
import type { ParseKeys } from 'i18next'
import aiThinking from '../../assets/ai-thinking.gif?inline'
import { streamingTextClassName } from '../../design/motion'
import { IconFont } from '../primitive/Iconfont'
import {
  todoProgress,
  todoProgressLabel,
  type TodoDisplayItem,
  type TodoDisplayStatus,
} from '../../todo'
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EllipsisText,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Spinner,
} from '../ui'
import { planElapsedLabel } from './duration'
import { TaskPausedIcon } from './TaskStatus'

const PLAN_DETAIL_MIN_WIDTH = 420
const PLAN_ESTIMATE_MIN_WIDTH = 560

export interface PlanItem extends Omit<TodoDisplayItem, 'children'> {
  elapsedMilliseconds?: number | null
  children?: PlanItem[]
}

export interface PlanProps {
  id: string
  items: PlanItem[]
  summary: {
    status: TodoDisplayStatus
    label: string
    paused?: boolean
    danger?: boolean
    issue?: 'error' | 'warning'
  }
  activeLabel?: string
  elapsedMilliseconds?: number | null
  estimateLabel?: string
  estimateTooltip?: string
  estimateOverrun?: boolean
  running?: boolean
  compact?: boolean
  canContinue?: boolean
  continueDisabled?: boolean
  onContinue?: () => Promise<boolean>
}

type TodoStatusMessageKey = Extract<ParseKeys<'components'>, `todo.status.${string}`>
type StatusPresentation = {
  mark?: string
  lucide?: LucideIcon
  messageKey: TodoStatusMessageKey
  className: string
}

const STATUS_PRESENTATION: Record<TodoDisplayStatus, StatusPresentation> = {
  done: {
    mark: 'a-line-status-success',
    messageKey: 'todo.status.done',
    className: 'text-[var(--vds-success-text-primary)]',
  },
  running: {
    mark: 'fill-status-loading',
    messageKey: 'todo.status.running',
    className: 'text-[var(--vds-brand-text-primary)]',
  },
  need: {
    mark: 'a-line-status-help',
    messageKey: 'todo.status.need',
    className: 'text-[var(--vds-warning-text-primary)]',
  },
  unrequested: {
    lucide: CircleDashed,
    messageKey: 'todo.status.unrequested',
    className: 'text-[var(--vds-text-tertiary)]',
  },
  // 未开始不用禁用(禁止)字形, 用 lucide 虚线圆; size-[1em] 随继承字号缩放, 与 iconfont 字形行为一致。
  todo: {
    lucide: CircleDashed,
    messageKey: 'todo.status.todo',
    className: 'text-[var(--vds-text-tertiary)]',
  },
  partial: {
    mark: 'a-line-status-help',
    messageKey: 'todo.status.partial',
    className: 'text-[var(--vds-warning-text-primary)]',
  },
  blocked: {
    mark: 'a-line-status-error',
    messageKey: 'todo.status.blocked',
    className: 'text-[var(--vds-error-text-primary)]',
  },
  failed: {
    lucide: CircleAlert,
    messageKey: 'todo.status.failed',
    className: 'text-[var(--vds-warning-text-primary)]',
  },
  stopped: {
    lucide: CircleAlert,
    messageKey: 'todo.status.stopped',
    className: 'text-[var(--vds-warning-text-primary)]',
  },
}

function StatusMark({
  status,
  tone,
  paused = false,
}: {
  status: TodoDisplayStatus
  tone?: 'neutral' | 'danger'
  paused?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const presentation = STATUS_PRESENTATION[status]
  const LucideMark = presentation.lucide
  const color =
    tone === 'danger'
      ? 'text-[var(--vds-error-text-primary)]'
      : tone === 'neutral'
        ? 'text-[var(--vds-text-secondary)]'
        : presentation.className
  return (
    /* min-h-[1lh]: iconfont 字形靠行盒撑高(18/22px), svg 没有行盒会缩成图标自身高度,
       在 items-start 的行里顶边对齐显得偏高; 用自身行高兜底后与右侧文字首行居中对齐。 */
    <span
      className={`inline-grid min-h-[var(--vds-todo-status-mark-min-height)] shrink-0 place-items-center font-[var(--vds-fw-regular)] ${color}`}
      data-testid={`todo-mark-${status}`}
      aria-label={paused ? t('todo.summary.interrupted') : t(presentation.messageKey)}
    >
      {paused ? (
        <TaskPausedIcon className="!size-[var(--vds-icon-6)]" />
      ) : status === 'running' ? (
        <Spinner
          imageSrc={aiThinking}
          size="sm"
          className="!size-[var(--vds-icon-6)]"
          aria-hidden="true"
        />
      ) : LucideMark ? (
        /* All plan status marks share the compact icon size. */
        <LucideMark aria-hidden="true" className="size-[var(--vds-icon-6)]" />
      ) : presentation.mark ? (
        <IconFont
          type={presentation.mark}
          className="inline-flex size-[var(--vds-icon-6)] items-center justify-center !text-[length:var(--vds-icon-6)]"
        />
      ) : null}
    </span>
  )
}

function Row({
  item,
  items,
  isLast = false,
  showDetails = true,
}: {
  item: PlanItem
  items: PlanItem[]
  isLast?: boolean
  showDetails?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const emphasized = ['running', 'failed', 'blocked'].includes(item.status)
  const pending = item.status === 'todo' || item.status === 'unrequested'
  const textColor = pending
    ? 'text-[var(--vds-text-tertiary)]'
    : emphasized || item.status === 'done'
      ? 'text-[var(--vds-text-secondary)]'
      : 'text-[var(--vds-text-primary)]'
  const pendingDependencies =
    item.status === 'todo'
      ? items.filter(
          (dependency) =>
            dependency.id && item.dependsOn?.includes(dependency.id) && dependency.status !== 'done'
        )
      : []
  return (
    <li
      className="flex min-w-0 items-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] px-[var(--vds-space-1)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)]"
      data-testid="todo-step"
    >
      <span className="relative self-stretch">
        <StatusMark status={item.status} />
        {!isLast ? (
          <span
            aria-hidden="true"
            className="absolute left-[calc(50%_-_var(--vds-border-width-1))] top-[calc(1lh+var(--vds-space-1))] -bottom-[var(--vds-space-3)] border-l border-solid border-[var(--vds-border-default)]"
          />
        ) : null}
      </span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <div className="flex min-w-0 items-start justify-between gap-[var(--vds-space-2)]">
          <span className={`${textColor} ${emphasized ? 'font-[var(--vds-fw-medium)]' : ''}`}>
            {item.status === 'running' && item.activeForm ? item.activeForm : item.content}
          </span>
        </div>
        {showDetails && item.reason ? (
          <p
            data-testid="todo-step-reason"
            className="m-0 mt-[var(--vds-space-1)] whitespace-pre-wrap text-[var(--vds-error-text-primary)] [overflow-wrap:anywhere]"
          >
            {item.reason}
          </p>
        ) : null}
        {pendingDependencies.length > 0 && (
          <span className="block text-[var(--text-3)]">
            {t('todo.waitingFor', {
              dependencies: pendingDependencies.map((dependency) => dependency.content).join(', '),
            })}
          </span>
        )}
        {item.status === 'unrequested' && (
          <Badge
            size="sm"
            tone="neutral"
            className="mt-[var(--vds-space-1)] !font-[var(--vds-fw-regular)]"
          >
            {t('todo.status.unrequestedBadge')}
          </Badge>
        )}
        {showDetails && item.children?.length ? (
          <Collapsible
            className="mt-[var(--vds-space-1)] !gap-0 overflow-hidden rounded-[var(--vds-accordion-radius)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
            defaultOpen={item.status !== 'done'}
          >
            <CollapsibleTrigger
              className="group flex w-full !justify-start gap-[var(--vds-space-1)] !rounded-none !border-0 !bg-transparent ![padding:0_var(--vds-space-4)] text-left text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)] hover:![background:var(--vds-other-overlay-1)]"
              data-testid="todo-subplan-toggle"
            >
              <span className="shrink-0 transition-transform [[data-state=open]>&]:rotate-90">
                <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span>
                {t('todo.subplanProgress', {
                  done: todoProgress(item.children).done,
                  total: item.children.length,
                })}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="!rounded-none !border-x-0 !border-b-0 !bg-transparent !p-[var(--vds-space-2)]">
              <ol
                className="m-0 list-none p-0"
                aria-label={t('todo.subplanProgress', {
                  done: todoProgress(item.children).done,
                  total: item.children.length,
                })}
              >
                {item.children.map((child, index) => (
                  <Row
                    key={child.id || index}
                    item={child}
                    items={item.children!}
                    isLast={index === item.children!.length - 1}
                  />
                ))}
              </ol>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </li>
  )
}

export function Plan({
  id,
  items,
  summary,
  activeLabel: stepLabel,
  elapsedMilliseconds,
  estimateLabel,
  estimateTooltip,
  estimateOverrun = false,
  running: planRunning = false,
  compact = false,
  canContinue: continuationRequested = false,
  continueDisabled = false,
  onContinue,
}: PlanProps): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const { done, total } = todoProgress(items)
  const canContinue = Boolean(continuationRequested && onContinue)
  const allDone = done === total
  const elapsed = elapsedMilliseconds == null ? '' : planElapsedLabel(elapsedMilliseconds, t)
  const continuingRef = React.useRef(false)
  const [continuing, setContinuing] = React.useState(false)
  const toggleRef = React.useRef<HTMLButtonElement | null>(null)
  const [headerWidth, setHeaderWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    if (compact) return
    const button = toggleRef.current
    if (!button) return
    const update = (): void => setHeaderWidth(button.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(button)
    return () => observer.disconnect()
  })
  const compactPaused = canContinue && headerWidth < PLAN_DETAIL_MIN_WIDTH
  const continuePlan = async (): Promise<void> => {
    if (!canContinue || continueDisabled || continuingRef.current || !onContinue) return
    continuingRef.current = true
    setContinuing(true)
    try {
      await onContinue()
    } finally {
      continuingRef.current = false
      setContinuing(false)
    }
  }
  const incomplete = ['stopped', 'partial', 'failed', 'blocked'].includes(summary.status)
  const showCurrent =
    summary.status !== 'done' && Boolean(stepLabel) && headerWidth >= PLAN_DETAIL_MIN_WIDTH
  const resultTone =
    summary.danger || incomplete ? 'danger' : summary.status === 'done' ? undefined : 'neutral'
  const compactPanelRef = React.useRef<HTMLDivElement>(null)
  if (total === 0 && !estimateLabel) return null
  const progress = !allDone ? (
    <span
      className="shrink-0 font-[var(--vds-fw-medium)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
      data-testid="todo-progress"
    >
      {todoProgressLabel(items)}
    </span>
  ) : null
  const renderTimer = (testId: string): React.JSX.Element | null =>
    elapsed ? (
      <span
        className="inline-flex shrink-0 items-center gap-[var(--vds-space-1)] whitespace-nowrap text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]"
        data-testid={testId}
        aria-label={t('todo.totalElapsed', { duration: elapsed })}
        title={t('todo.totalElapsed', { duration: elapsed })}
      >
        <Clock3
          className={
            compact ? '!size-[var(--vds-icon-6)] shrink-0' : 'size-[var(--vds-icon-7)] shrink-0'
          }
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {elapsed}
      </span>
    ) : null
  const continuation = canContinue ? (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0 !font-[var(--vds-fw-regular)]"
      data-testid="todo-continue"
      disabled={continueDisabled || continuing}
      onClick={() => void continuePlan()}
    >
      {t('todo.continue')}
    </Button>
  ) : null
  const steps =
    total === 0 ? null : (
      <ol
        className={
          compact
            ? 'm-0 list-none px-[var(--vds-space-3)] pt-[var(--vds-space-1)]'
            : 'm-0 mt-[var(--vds-space-2)] max-h-[var(--vds-plan-list-max-height)] list-none overflow-y-auto border-t border-[var(--vds-divider-default)] p-0 pt-[var(--vds-space-1)]'
        }
      >
        {items.map((item, index) => (
          <Row
            key={item.id || index}
            item={item}
            items={items}
            isLast={index === items.length - 1}
            showDetails={!compact}
          />
        ))}
      </ol>
    )

  if (compact) {
    const issue = summary.issue
    return (
      <div
        ref={compactPanelRef}
        className="-mb-[var(--vds-space-1)] min-w-0"
        data-testid="todo-panel"
      >
        <Popover key={id}>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className="!inline-flex !h-auto min-h-[var(--vds-control-height-md)] max-w-full flex-wrap !justify-start !gap-x-[var(--vds-space-2)] !gap-y-0 !rounded-[var(--vds-radius-4)] !border-[var(--border)] !bg-[var(--vds-bg-white-default)] ![font-family:inherit] !font-[var(--vds-fw-regular)] !text-[length:var(--vds-font-body-lv1)] transition-shadow duration-[var(--vds-duration-fast)] motion-reduce:transition-none hover:!shadow-[var(--vds-shadow-1-center)] data-[state=open]:!bg-[var(--vds-surface-hover)]"
              data-testid="todo-toggle"
              aria-description={summary.label}
            >
              <StatusMark
                status={
                  issue === 'error' ? 'blocked' : issue === 'warning' ? 'failed' : summary.status
                }
                tone={issue ? undefined : resultTone}
                paused={!issue && summary.paused}
              />
              <span className="font-[var(--vds-fw-medium)] text-[var(--vds-text-secondary)]">
                {t('todo.steps')}
              </span>
              {progress}
              {estimateLabel && !estimateOverrun ? (
                <span
                  className="shrink-0 whitespace-nowrap text-[var(--vds-text-tertiary)]"
                  data-testid="todo-summary-estimate"
                  title={estimateTooltip}
                >
                  {estimateLabel}
                </span>
              ) : (
                renderTimer('todo-elapsed')
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            aria-label={t('todo.title')}
            side="top"
            horizontalAnchorRef={compactPanelRef}
            className="!block !w-max !max-w-[min(var(--floating-anchor-width,var(--vds-popover-available-width)),var(--vds-popover-available-width))] max-h-[calc(100dvh_-_var(--vds-space-8))] overflow-y-auto border border-[var(--vds-divider-default)] !px-0 !py-[var(--vds-space-3)] !shadow-[var(--vds-shadow-2-center)]"
            data-testid="todo-body"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-[var(--vds-space-2)] px-[var(--vds-space-3)]">
              <div className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)]">
                {t('todo.title')}
              </div>
              {renderTimer('todo-detail-elapsed')}
            </div>
            {steps ? (
              <>
                <div className="mx-[var(--vds-space-3)] mt-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)]" />
                <ScrollArea
                  overlay
                  viewportClassName="max-h-[var(--vds-plan-list-max-height)]"
                  viewportProps={{ 'aria-label': t('todo.steps') }}
                >
                  {steps}
                </ScrollArea>
              </>
            ) : null}
            {continuation ? (
              <div className="mt-[var(--vds-space-2)] flex justify-end px-[var(--vds-space-3)]">
                {continuation}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  return (
    <Card
      padding="sm"
      className="font-[var(--vds-fw-regular)] !rounded-[var(--vds-radius-6)] !border-[length:var(--vds-border-width-1)] !border-[var(--vds-divider-default)] !shadow-none transition-shadow duration-[var(--vds-duration-fast)] motion-reduce:transition-none has-[[data-testid=todo-toggle][data-state=closed]]:hover:!shadow-[var(--vds-shadow-1-center)]"
      data-testid="todo-panel"
      aria-label={t('todo.title')}
    >
      <Collapsible
        className="!gap-[var(--vds-space-1)]"
        key={`${id}:${allDone}`}
        defaultOpen={!allDone}
      >
        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
          <CollapsibleTrigger asChild>
            <Button
              ref={toggleRef}
              variant="ghost"
              size="content"
              className="!font-[var(--vds-fw-regular)] group !flex flex-1 !shrink min-w-0 flex-wrap !items-center !justify-start !gap-[var(--vds-space-2)] !border-0 !px-[var(--vds-space-1)] !py-[var(--vds-space-1)] text-left data-[state=closed]:hover:!bg-transparent"
              data-testid="todo-toggle"
            >
              <span className="flex shrink-0 items-center gap-[var(--vds-space-2)]">
                <span className="shrink-0 transition-transform group-data-[state=open]:rotate-90">
                  <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className={`shrink-0 ${planRunning ? streamingTextClassName : ''}`}>
                  {t('todo.title')}
                </span>
                {!compactPaused ? progress : null}
              </span>
              {showCurrent ? (
                <EllipsisText
                  className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
                  role="status"
                  data-testid="todo-current"
                  tooltipPortalled
                  tooltipSide="bottom"
                  wrapperClassName="inline-flex items-center min-w-0 shrink"
                >
                  {stepLabel}
                </EllipsisText>
              ) : null}
              <span
                className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-2)]"
                title={summary.label}
              >
                <StatusMark status={summary.status} tone={resultTone} paused={summary.paused} />
                {incomplete ? (
                  <span
                    className="inline-flex items-center whitespace-nowrap text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-error-text-primary)]"
                    data-testid="todo-incomplete"
                  >
                    {t('todo.status.stopped')}
                  </span>
                ) : (
                  renderTimer('todo-elapsed')
                )}
              </span>
              {estimateLabel && headerWidth >= PLAN_ESTIMATE_MIN_WIDTH ? (
                <EllipsisText
                  className="max-w-[var(--vds-layout-inline-metadata-max-width)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
                  data-testid="todo-estimate"
                  tooltip={estimateTooltip}
                  tooltipPortalled
                  tooltipSide="bottom"
                  wrapperClassName="shrink min-w-0"
                >
                  {estimateLabel}
                </EllipsisText>
              ) : null}
            </Button>
          </CollapsibleTrigger>
          {continuation}
        </div>
        <CollapsibleContent
          className="!rounded-none !border-0 !bg-transparent !p-0"
          data-testid="todo-body"
        >
          {steps}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
