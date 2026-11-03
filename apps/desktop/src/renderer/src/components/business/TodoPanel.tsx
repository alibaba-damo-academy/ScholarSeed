import React from 'react'
import { useTranslation } from 'react-i18next'
import { activeThread, useApp } from '../../store'
import type { Thread } from '../../model'
import {
  displayTodos,
  isLatestUserTurn,
  planElapsedMilliseconds,
  planSkillEstimate,
  planStatus,
  stepDisplayMilliseconds,
  type TodoDisplayItem,
  todoProgress,
  todoSummary,
} from '../../todo'
import { Plan, type PlanItem } from './Plan'

const ELAPSED_TICK_MS = 1_000
const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60

function estimateMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_MINUTE))
}

function timedItems(thread: Thread, items: TodoDisplayItem[], now: number): PlanItem[] {
  return items.map((item) => ({
    ...item,
    elapsedMilliseconds: stepDisplayMilliseconds(thread, item, now),
    children: item.children ? timedItems(thread, item.children, now) : undefined,
  }))
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
  const estimatedSkill = planSkillEstimate(thread)
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
  const elapsedMilliseconds = planElapsedMilliseconds(thread, timingTurnId, now)
  const elapsedSeconds =
    elapsedMilliseconds !== null ? Math.floor(elapsedMilliseconds / MILLISECONDS_PER_SECOND) : null
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
      : planRunning && elapsedSeconds !== null && elapsedSeconds >= SECONDS_PER_MINUTE
        ? t('todo.estimate.unavailable')
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
  const canContinue = Boolean(
    onContinue &&
    summary.messageKey === 'todo.summary.interrupted' &&
    !thread.terminated &&
    isLatestUserTurn(thread, presentedTurnId)
  )
  return (
    <Plan
      id={`${thread.sessionId}:${thread.todoTurnId}`}
      items={timedItems(thread, items, now)}
      summary={{
        status: summary.status,
        label: summaryLabel,
        paused: summary.messageKey === 'todo.summary.interrupted',
        danger: summary.messageKey === 'todo.summary.ended',
      }}
      activeLabel={stepLabel}
      elapsedMilliseconds={elapsedMilliseconds}
      estimateLabel={estimateLabel}
      estimateTooltip={estimateTooltip}
      running={planRunning}
      compact={compact}
      canContinue={canContinue}
      continueDisabled={continueDisabled}
      onContinue={onContinue}
    />
  )
}
