import React from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import { IconFont } from '../primitive/Iconfont'
import { activeThread, useApp } from '../../store'
import {
  displayTodos,
  isLatestUserTurn,
  planStatus,
  type TodoDisplayItem,
  type TodoDisplayStatus,
  todoProgress,
  todoProgressLabel,
  todoSummary
} from '../../todo'
import { Badge, Button, Card, Collapsible, CollapsibleContent, CollapsibleTrigger, EllipsisText } from '../ui'

const ELAPSED_TICK_MS = 1_000
const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60

function estimateMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_MINUTE))
}

const STATUS_PRESENTATION = {
  done: { mark: 'a-line-status-success', messageKey: 'todo.status.done', className: 'text-[var(--vds-success-text-primary)]' },
  running: { mark: 'fill-status-loading', messageKey: 'todo.status.running', className: 'text-[var(--vds-brand-text-primary)]' },
  need: { mark: 'a-line-status-help', messageKey: 'todo.status.need', className: 'text-[var(--vds-warning-text-primary)]' },
  todo: { mark: 'a-line-status-notfull', messageKey: 'todo.status.todo', className: 'text-[var(--vds-text-tertiary)]' },
  partial: { mark: 'a-line-status-help', messageKey: 'todo.status.partial', className: 'text-[var(--vds-warning-text-primary)]' },
  blocked: { mark: 'a-line-status-error', messageKey: 'todo.status.blocked', className: 'text-[var(--vds-error-text-primary)]' },
  failed: { mark: 'a-line-status-error', messageKey: 'todo.status.failed', className: 'text-[var(--vds-error-text-primary)]' },
  stopped: { mark: 'a-line-status-notfull', messageKey: 'todo.status.stopped', className: 'text-[var(--vds-text-tertiary)]' }
} as const satisfies Record<TodoDisplayStatus, { mark: string; messageKey: string; className: string }>

function StatusMark({ status }: { status: TodoDisplayStatus }): React.JSX.Element {
  const { t } = useTranslation('components')
  const presentation = STATUS_PRESENTATION[status]
  return (
    <span
      className={`inline-grid shrink-0 place-items-center font-medium ${presentation.className}`}
      data-testid={`todo-mark-${status}`}
      aria-label={t(presentation.messageKey)}
    >
      <IconFont type={presentation.mark} className={status === 'running' ? 'animate-spin motion-reduce:animate-none' : undefined} />
    </span>
  )
}

function Row({
  item,
  items
}: {
  item: TodoDisplayItem
  items: TodoDisplayItem[]
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const pendingDependencies =
    item.status === 'todo'
      ? items.filter(
        (dependency) =>
          dependency.id &&
          item.dependsOn?.includes(dependency.id) &&
          dependency.status !== 'done'
      )
      : []
  return (
    <li className={`flex min-w-0 items-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] ${item.status === 'running' ? 'bg-[var(--vds-surface-muted)]' : ''}`} data-testid="todo-step">
      <StatusMark status={item.status} />
      <div className="min-w-0 flex-1 break-words">
        <span className={item.status === 'done' ? 'text-[var(--vds-text-secondary)]' : 'text-[var(--vds-text-primary)]'}>
          {item.status === 'running' && item.activeForm ? item.activeForm : item.content}
        </span>
        {pendingDependencies.length > 0 && (
          <span className="block text-[var(--text-3)]">
            {t('todo.waitingFor', { dependencies: pendingDependencies.map((dependency) => dependency.content).join(', ') })}
          </span>
        )}
        {item.children?.length ? (
          <Collapsible defaultOpen={item.status !== 'done'}>
            <CollapsibleTrigger className="mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]" data-testid="todo-subplan-toggle">
              {t('todo.subplanProgress', { done: todoProgress(item.children).done, total: item.children.length })}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ol className="m-0 list-none border-l border-[var(--vds-border-default)] pl-[var(--vds-space-2)]" aria-label={t('todo.subplanProgress', { done: todoProgress(item.children).done, total: item.children.length })}>
                {item.children.map((child, index) => <Row key={child.id || index} item={child} items={item.children!} />)}
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
  "low": "todo.estimate.confidence.low",
  "medium": "todo.estimate.confidence.medium",
  "high": "todo.estimate.confidence.high"
} as const

export function TodoPanel({
  compact = false,
  currentTurnOnly = false
}: {
  compact?: boolean
  currentTurnOnly?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const { state } = useApp()
  const thread = activeThread(state)
  const [now, setNow] = React.useState(Date.now())
  const estimatedSkillEvent = [...thread.conversation].reverse().find((item) => (
    item.kind === 'skill'
    && item.estimate
    && item.turnId
    && thread.turnOutcomes?.[item.turnId] === 'running'
  ))
  const estimatedSkillReference = [...thread.conversation].reverse().flatMap((item) => (
    item.kind === 'user' && item.turnId && thread.turnOutcomes?.[item.turnId] === 'running'
      ? (item.refs ?? []).filter((reference) => reference.type === 'skill' && reference.estimate).map((reference) => ({
        turnId: item.turnId,
        estimate: reference.estimate
      }))
      : []
  ))[0]
  const estimatedSkill = estimatedSkillEvent?.kind === 'skill'
    ? { turnId: estimatedSkillEvent.turnId, estimate: estimatedSkillEvent.estimate }
    : estimatedSkillReference
  const activePlanTurnId = thread.todoTurnId
    && thread.turnOutcomes?.[thread.todoTurnId] === 'running'
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
  let summaryLabel: string
  if (summary.messageKey === 'todo.summary.completedPartial') {
    summaryLabel = t(summary.messageKey, { count: summary.issueCount ?? 0 })
  } else if (summary.messageKey) {
    summaryLabel = t(summary.messageKey)
  } else if (summaryIssueCount) {
    const runningIssueOptions: { activity: string; count: number } = {
      activity: summary.label ?? '',
      count: summaryIssueCount
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
  React.useEffect(() => {
    if (!planRunning || !timing) return
    const timer = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => window.clearInterval(timer)
  }, [planRunning, timing])
  const elapsedSeconds = timing
    ? Math.max(0, Math.floor(((timing.completedAt ?? now) - timing.startedAt) / MILLISECONDS_PER_SECOND))
    : null
  const elapsed = elapsedSeconds === null
    ? ''
    : elapsedSeconds >= SECONDS_PER_MINUTE
      ? t('todo.elapsedMinutes', { minutes: Math.floor(elapsedSeconds / SECONDS_PER_MINUTE), seconds: elapsedSeconds % SECONDS_PER_MINUTE })
      : t('todo.elapsedSeconds', { seconds: elapsedSeconds })
  const estimate = estimatedSkill?.estimate
  const estimateLabel = estimate && planRunning
    ? elapsedSeconds !== null && elapsedSeconds >= estimate.upperSeconds
      ? t('todo.estimate.overrun')
      : elapsedSeconds !== null && elapsedSeconds >= SECONDS_PER_MINUTE
        ? t('todo.estimate.remaining', {
          lower: estimateMinutes(Math.max(0, estimate.lowerSeconds - elapsedSeconds)),
          upper: estimateMinutes(Math.max(0, estimate.upperSeconds - elapsedSeconds))
        })
        : t('todo.estimate.total', {
          lower: estimateMinutes(estimate.lowerSeconds),
          upper: estimateMinutes(estimate.upperSeconds)
        })
    : ''
  const estimateTitle = estimate
    ? t('todo.estimate.basis', {
      source: estimate.basis === 'historical_skill_turns'
        ? t('todo.estimate.source.history', { count: estimate.sampleCount })
        : t('todo.estimate.source.baseline'),
      confidence: t(ESTIMATE_CONFIDENCE_KEYS[estimate.confidence]),
      model: estimate.modelId || thread.runtime?.model_id || t('todo.estimate.unknownModel'),
      effort: estimate.reasoningEffort || thread.runtime?.active_reasoning_effort || t('todo.estimate.unknownEffort')
    })
    : undefined
  const estimateTooltip = estimateLabel
    ? estimateTitle ? `${estimateLabel} · ${estimateTitle}` : estimateLabel
    : undefined
  if (currentTurnOnly && !isLatestUserTurn(thread, presentedTurnId)) return null
  if (total === 0 && !estimateLabel) return null

  const allDone = done === total
  const currentLabel = total > 0 ? summaryLabel : t('todo.summary.preparing')
  return (
    <Card padding="sm" className={`!rounded-[var(--vds-radius-4)] !shadow-none ${compact ? '!px-[var(--vds-space-2)] !py-[var(--vds-space-1)] -mb-[var(--vds-space-2)]' : ''}`} data-testid="todo-panel" aria-label={t('todo.title')}>
      <Collapsible className="!gap-[var(--vds-space-1)]" key={`${thread.sessionId}:${thread.todoTurnId}:${allDone}`} defaultOpen={!compact && !allDone}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="content" className="group !flex w-full min-w-0 !justify-start gap-[var(--vds-space-2)] !border-0 !px-[var(--vds-space-1)] !py-[var(--vds-space-1)] text-left" data-testid="todo-toggle">
            <StatusMark status={summary.status} />
            <span className="shrink-0 font-medium">{t('todo.title')}</span>
            {total > 0 ? (
              <Badge size="sm" tone="neutral" className="shrink-0 font-mono tabular-nums" data-testid="todo-progress">
                {todoProgressLabel(items)}
              </Badge>
            ) : null}
            {elapsed ? <span className="shrink-0 font-mono tabular-nums text-[var(--vds-text-tertiary)]" data-testid="todo-elapsed">· {elapsed}</span> : null}
            {estimateLabel ? (
              <EllipsisText className="max-w-[var(--vds-layout-inline-metadata-max-width)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]" data-testid="todo-estimate" tooltip={estimateTooltip} tooltipPortalled tooltipSide="bottom" wrapperClassName="shrink min-w-0">
                · {estimateLabel}
              </EllipsisText>
            ) : null}
            <EllipsisText className="text-right text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]" role="status" data-testid="todo-current" tooltipPortalled tooltipSide="bottom" wrapperClassName="ml-auto min-w-0 flex-1">
              {currentLabel}
            </EllipsisText>
            <span className="shrink-0 transition-transform group-data-[state=open]:rotate-180">
              <Icon name="chevron-down" size={13} sw={1.8} />
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0" data-testid="todo-body">
          {total === 0 ? null : (
            <ol className="m-0 mt-[var(--vds-space-2)] max-h-48 list-none overflow-y-auto border-t border-[var(--vds-divider-default)] p-0 pt-[var(--vds-space-1)]">
              {items.map((item, index) => (
                <Row key={item.id || index} item={item} items={items} />
              ))}
            </ol>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
