import React from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, CircleDashed, Pause, type LucideIcon } from 'lucide-react'
import type { ParseKeys } from 'i18next'

import aiThinking from '../../assets/ai-thinking.gif'
import { streamingTextClassName } from '../../design/motion'
import { Icon } from '../../icons'
import { IconFont } from '../primitive/Iconfont'
import { activeThread, useApp } from '../../store'
import type { Thread } from '../../model'
import {
  displayTodos,
  isLatestUserTurn,
  planElapsedMilliseconds,
  planStatus,
  stepElapsedMilliseconds,
  UNKNOWN_STEP_DURATION,
  type TodoDisplayItem,
  type TodoDisplayStatus,
  todoProgress,
  todoProgressLabel,
  todoSummary,
} from '../../todo'
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EllipsisText,
  Spinner,
} from '../ui'
import { planDurationLabel } from './duration'

const ELAPSED_TICK_MS = 1_000
const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60
const PLAN_DETAIL_MIN_WIDTH = 420
const PLAN_ESTIMATE_MIN_WIDTH = 560

function estimateMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_MINUTE))
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
  const LucideMark = paused ? Pause : presentation.lucide
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
      className={`inline-grid min-h-[1lh] shrink-0 place-items-center font-medium ${color}`}
      data-testid={`todo-mark-${status}`}
      aria-label={paused ? t('todo.summary.interrupted') : t(presentation.messageKey)}
    >
      {status === 'running' ? (
        <Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />
      ) : LucideMark ? (
        /* .iconfont 全局 16px, lucide 图标用同一档 icon-8 token 才能与其余状态字形等大。 */
        <LucideMark aria-hidden="true" className="size-[var(--vds-icon-8)]" />
      ) : presentation.mark ? (
        <IconFont type={presentation.mark} />
      ) : null}
    </span>
  )
}

function Row({
  item,
  items,
  thread,
  now,
  isLast = false,
}: {
  item: TodoDisplayItem
  items: TodoDisplayItem[]
  thread: Thread
  now: number
  isLast?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const elapsed = stepElapsedMilliseconds(thread, item, now)
  const duration = elapsed === null ? UNKNOWN_STEP_DURATION : planDurationLabel(elapsed)
  const pendingDependencies =
    item.status === 'todo'
      ? items.filter(
          (dependency) =>
            dependency.id && item.dependsOn?.includes(dependency.id) && dependency.status !== 'done'
        )
      : []
  return (
    <li
      className={`flex min-w-0 items-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] px-[var(--vds-space-1)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] ${item.status === 'running' ? 'bg-[var(--vds-surface-muted)]' : ''}`}
      data-testid="todo-step"
    >
      <span className="relative self-stretch">
        <StatusMark status={item.status} />
        {!isLast ? (
          <span
            aria-hidden="true"
            className="absolute left-[calc(50%_-_1px)] top-[calc(1lh+var(--vds-space-1))] -bottom-[var(--vds-space-3)] border-l border-solid border-[var(--vds-border-default)]"
          />
        ) : null}
      </span>
      <div className="min-w-0 flex-1 break-words">
        <div className="flex min-w-0 items-start justify-between gap-[var(--vds-space-2)]">
          <span
            className={
              item.status === 'done'
                ? 'text-[var(--vds-text-secondary)]'
                : 'text-[var(--vds-text-primary)]'
            }
          >
            {item.status === 'running' && item.activeForm ? item.activeForm : item.content}
          </span>
          <span
            className="shrink-0 whitespace-nowrap text-[var(--vds-text-tertiary)] tabular-nums"
            data-testid="todo-step-elapsed"
            aria-label={t('todo.stepElapsed', { duration })}
          >
            {duration}
          </span>
        </div>
        {pendingDependencies.length > 0 && (
          <span className="block text-[var(--text-3)]">
            {t('todo.waitingFor', {
              dependencies: pendingDependencies.map((dependency) => dependency.content).join(', '),
            })}
          </span>
        )}
        {item.status === 'unrequested' && (
          <Badge size="sm" tone="neutral" className="mt-[var(--vds-space-1)]">{t('todo.status.unrequestedBadge')}</Badge>
        )}
        {item.children?.length ? (
          <Collapsible
            className="mt-[var(--vds-space-1)] !gap-0 overflow-hidden rounded-[var(--vds-accordion-radius)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
            defaultOpen={item.status !== 'done'}
          >
            <CollapsibleTrigger
              className="group flex w-full !justify-start gap-[var(--vds-space-1)] !rounded-none !border-0 !bg-transparent ![padding:0_var(--vds-space-4)] text-left text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)] hover:![background:var(--vds-other-overlay-1)]"
              data-testid="todo-subplan-toggle"
            >
              <span className="shrink-0 transition-transform group-data-[state=open]:rotate-180">
                <Icon name="chevron-down" size={13} sw={1.8} />
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
                    thread={thread}
                    now={now}
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

/** One shared plan projection for the conversation monitor and the AI composer. */
const ESTIMATE_CONFIDENCE_KEYS = {
  low: 'todo.estimate.confidence.low',
  medium: 'todo.estimate.confidence.medium',
  high: 'todo.estimate.confidence.high',
} as const

export function TodoPanel({
  compact = false,
  currentTurnOnly = false,
  onContinue,
  continueDisabled = false,
}: {
  compact?: boolean
  currentTurnOnly?: boolean
  onContinue?: () => Promise<boolean>
  continueDisabled?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const { state } = useApp()
  const thread = activeThread(state)
  const [now, setNow] = React.useState(Date.now())
  const continuingRef = React.useRef(false)
  const [continuing, setContinuing] = React.useState(false)
  const estimatedSkillEvent = [...thread.conversation]
    .reverse()
    .find(
      (item) =>
        item.kind === 'skill' &&
        item.estimate &&
        item.turnId &&
        thread.turnOutcomes?.[item.turnId] === 'running'
    )
  const estimatedSkillReference = [...thread.conversation].reverse().flatMap((item) =>
    item.kind === 'user' && item.turnId && thread.turnOutcomes?.[item.turnId] === 'running'
      ? (item.refs ?? [])
          .filter((reference) => reference.type === 'skill' && reference.estimate)
          .map((reference) => ({
            turnId: item.turnId,
            estimate: reference.estimate,
          }))
      : []
  )[0]
  const estimatedSkill =
    estimatedSkillEvent?.kind === 'skill'
      ? { turnId: estimatedSkillEvent.turnId, estimate: estimatedSkillEvent.estimate }
      : estimatedSkillReference
  const activePlanTurnId =
    thread.todoTurnId && thread.turnOutcomes?.[thread.todoTurnId] === 'running'
      ? thread.todoTurnId
      : undefined
  const preparingSkill = Boolean(
    estimatedSkill?.turnId && estimatedSkill.turnId !== activePlanTurnId
  )
  const presentedTurnId = preparingSkill ? estimatedSkill?.turnId : thread.todoTurnId
  // A retry has its own lifecycle. Until its first plan snapshot arrives, keep
  // the estimate visible instead of showing the previous terminal plan.
  const items = preparingSkill ? [] : displayTodos(thread)
  const { done, total } = todoProgress(items)
  const summary = preparingSkill
    ? { messageKey: 'todo.summary.waiting' as const, status: 'running' as const }
    : todoSummary(thread, items)
  const summaryIssueCount = summary.issueCount ?? 0
  const failedSteps = thread.todos?.filter((item) => item.status === 'failed').length ?? 0
  let summaryLabel: string
  if (summary.messageKey === 'todo.summary.completedPartial') {
    summaryLabel = t(summary.messageKey, { count: summary.issueCount ?? 0 })
  } else if (summary.messageKey === 'todo.summary.ended') {
    summaryLabel = t(summary.messageKey, { count: total - done })
  } else if (summary.status === 'failed' && failedSteps > 0) {
    summaryLabel = t('todo.summary.failedSteps', { count: failedSteps })
  } else if (summary.messageKey) {
    summaryLabel = t(summary.messageKey)
  } else if (summaryIssueCount) {
    const runningIssueOptions: { activity: string; count: number } = {
      activity: summary.label ?? '',
      count: summaryIssueCount,
    }
    summaryLabel = t('todo.summary.runningWithIssues', runningIssueOptions)
  } else {
    summaryLabel = summary.label
  }
  const timingTurnId = activePlanTurnId || estimatedSkill?.turnId || thread.todoTurnId
  const timing = timingTurnId ? thread.turnTimings?.[timingTurnId] : undefined
  const planRunning = activePlanTurnId
    ? planStatus(thread) === 'running'
    : Boolean(estimatedSkill?.turnId && thread.turnOutcomes?.[estimatedSkill.turnId] === 'running')
  const turnRunning = Boolean(timingTurnId && thread.turnOutcomes?.[timingTurnId] === 'running')
  React.useEffect(() => {
    if (!turnRunning || !timing) return
    const timer = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => window.clearInterval(timer)
  }, [turnRunning, timing])
  const toggleRef = React.useRef<HTMLButtonElement | null>(null)
  const [headerWidth, setHeaderWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const button = toggleRef.current
    if (!button) return
    const update = (): void => {
      setHeaderWidth(button.clientWidth)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(button)
    return () => observer.disconnect()
  })
  const elapsedMilliseconds = planElapsedMilliseconds(thread, timingTurnId, now)
  const elapsedSeconds =
    elapsedMilliseconds !== null ? Math.floor(elapsedMilliseconds / MILLISECONDS_PER_SECOND) : null
  const elapsed = elapsedMilliseconds === null ? '' : planDurationLabel(elapsedMilliseconds)
  const estimate = estimatedSkill?.estimate
  const estimateLabel =
    estimate && planRunning
      ? elapsedSeconds !== null && elapsedSeconds >= estimate.upperSeconds
        ? t('todo.estimate.overrun')
        : elapsedSeconds !== null && elapsedSeconds >= SECONDS_PER_MINUTE
          ? t('todo.estimate.remaining', {
              lower: estimateMinutes(Math.max(0, estimate.lowerSeconds - elapsedSeconds)),
              upper: estimateMinutes(Math.max(0, estimate.upperSeconds - elapsedSeconds)),
            })
          : t('todo.estimate.total', {
              lower: estimateMinutes(estimate.lowerSeconds),
              upper: estimateMinutes(estimate.upperSeconds),
            })
      : ''
  const estimateTitle = estimate
    ? t('todo.estimate.basis', {
        source:
          estimate.basis === 'historical_skill_turns'
            ? t('todo.estimate.source.history', { count: estimate.sampleCount })
            : t('todo.estimate.source.baseline'),
        confidence: t(ESTIMATE_CONFIDENCE_KEYS[estimate.confidence]),
        model: estimate.modelId || thread.runtime?.model_id || t('todo.estimate.unknownModel'),
        effort:
          estimate.reasoningEffort ||
          thread.runtime?.active_reasoning_effort ||
          t('todo.estimate.unknownEffort'),
      })
    : undefined
  const estimateTooltip = estimateLabel
    ? estimateTitle
      ? `${estimateLabel} · ${estimateTitle}`
      : estimateLabel
    : undefined
  if (currentTurnOnly && !isLatestUserTurn(thread, presentedTurnId)) return null
  if (total === 0 && !estimateLabel) return null

  const allDone = done === total
  const currentLabel = total > 0 ? summaryLabel : t('todo.summary.preparing')
  const activeStep = [...(thread.todos ?? [])]
    .reverse()
    .find(
      (item) =>
        item.status === 'in_progress' ||
        item.status === 'failed' ||
        item.status === 'blocked' ||
        item.status === 'needs_confirmation'
    )
  const stepLabel =
    summary.status === 'running' ? currentLabel : activeStep?.activeForm || activeStep?.content
  const showResult = summary.status !== 'running' && summary.status !== 'done'
  const canContinue = Boolean(
    onContinue &&
    summary.messageKey === 'todo.summary.interrupted' &&
    !thread.terminated &&
    isLatestUserTurn(thread, presentedTurnId)
  )
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
  const showCurrent =
    summary.status !== 'done' && Boolean(stepLabel) && headerWidth >= PLAN_DETAIL_MIN_WIDTH
  const resultTone =
    summary.status === 'failed' ||
    summary.status === 'blocked' ||
    summary.status === 'partial' ||
    summary.messageKey === 'todo.summary.ended'
      ? 'danger'
      : 'neutral'
  return (
    /* compact 的 -mb-4 与 composer assistant 的 pt-12 相抵 → 执行计划与输入框间距 8px。 */
    <Card
      padding="sm"
      className={`!rounded-[var(--vds-radius-6)] !shadow-none ${compact ? '!px-[var(--vds-space-2)] !py-[var(--vds-space-1)] -mb-[var(--vds-space-1)]' : ''}`}
      data-testid="todo-panel"
      aria-label={t('todo.title')}
    >
      <Collapsible
        className="!gap-[var(--vds-space-1)]"
        key={`${thread.sessionId}:${thread.todoTurnId}:${allDone}`}
        defaultOpen={!compact && !allDone}
      >
        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
          <CollapsibleTrigger asChild>
            <Button
              ref={toggleRef}
              variant="ghost"
              size="content"
              className="group !flex flex-1 !shrink min-w-0 !justify-start gap-[var(--vds-space-2)] !border-0 !px-[var(--vds-space-1)] !py-[var(--vds-space-1)] text-left"
              data-testid="todo-toggle"
            >
              <span className="shrink-0 transition-transform group-data-[state=open]:rotate-180">
                <Icon name="chevron-down" size={13} sw={1.8} />
              </span>
              <span className="flex shrink-0 items-center gap-[var(--vds-space-2)]">
                <span
                  className={`shrink-0 font-medium ${planRunning ? streamingTextClassName : ''}`}
                >
                  {t('todo.title')}
                </span>
                {total > 0 && !compactPaused ? (
                  <Badge size="sm" tone="neutral" className="shrink-0" data-testid="todo-progress">
                    {todoProgressLabel(items)}
                  </Badge>
                ) : null}
              </span>
              {showResult && !compactPaused ? (
                <EllipsisText
                  className={`text-right text-[length:var(--vds-font-body-lv1)] ${resultTone === 'danger' ? 'text-[var(--vds-error-text-primary)]' : 'text-[var(--vds-text-secondary)]'}`}
                  role="status"
                  data-testid="todo-result"
                  tooltip={summaryLabel}
                  tooltipPortalled
                  tooltipSide="bottom"
                  wrapperClassName="min-w-0 shrink"
                >
                  {currentLabel}
                </EllipsisText>
              ) : null}
              {showCurrent ? (
                <EllipsisText
                  className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
                  role="status"
                  data-testid="todo-current"
                  tooltipPortalled
                  tooltipSide="bottom"
                  wrapperClassName="min-w-0 shrink"
                >
                  {stepLabel}
                </EllipsisText>
              ) : null}
              <span className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-2)]">
                <StatusMark
                  status={summary.status}
                  tone={resultTone}
                  paused={summary.messageKey === 'todo.summary.interrupted'}
                />
                {elapsed ? (
                  <span
                    className="shrink-0 whitespace-nowrap text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
                    data-testid="todo-elapsed"
                    aria-label={t('todo.totalElapsed', { duration: elapsed })}
                    title={t('todo.totalElapsed', { duration: elapsed })}
                  >
                    {elapsed}
                  </span>
                ) : null}
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
          {canContinue ? (
            <Button
              size="sm"
              variant="secondary"
              className="shrink-0"
              data-testid="todo-continue"
              disabled={continueDisabled || continuing}
              onClick={() => void continuePlan()}
            >
              {t('todo.continue')}
            </Button>
          ) : null}
        </div>
        <CollapsibleContent
          className="!rounded-none !border-0 !bg-transparent !p-0"
          data-testid="todo-body"
        >
          {total === 0 ? null : (
            <ol className="m-0 mt-[var(--vds-space-2)] max-h-48 list-none overflow-y-auto border-t border-[var(--vds-divider-default)] p-0 pt-[var(--vds-space-1)]">
              {items.map((item, index) => (
                <Row
                  key={item.id || index}
                  item={item}
                  items={items}
                  thread={thread}
                  now={now}
                  isLast={index === items.length - 1}
                />
              ))}
            </ol>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
