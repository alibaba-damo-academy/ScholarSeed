import React from 'react'
import { useTranslation } from 'react-i18next'
import { CircleDashed, type LucideIcon } from 'lucide-react'

import aiThinking from '../../assets/ai-thinking.gif'
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
import { Badge, Button, Card, Collapsible, CollapsibleContent, CollapsibleTrigger, EllipsisText, Spinner } from '../ui'

const ELAPSED_TICK_MS = 1_000
const MILLISECONDS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60

function estimateMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_MINUTE))
}

type StatusPresentation = { mark?: string; lucide?: LucideIcon; messageKey: string; className: string }

const STATUS_PRESENTATION: Record<TodoDisplayStatus, StatusPresentation> = {
  done: { mark: 'a-line-status-success', messageKey: 'todo.status.done', className: 'text-[var(--vds-success-text-primary)]' },
  running: { mark: 'fill-status-loading', messageKey: 'todo.status.running', className: 'text-[var(--vds-brand-text-primary)]' },
  need: { mark: 'a-line-status-help', messageKey: 'todo.status.need', className: 'text-[var(--vds-warning-text-primary)]' },
  // 未开始不用禁用(禁止)字形, 用 lucide 虚线圆; size-[1em] 随继承字号缩放, 与 iconfont 字形行为一致。
  todo: { lucide: CircleDashed, messageKey: 'todo.status.todo', className: 'text-[var(--vds-text-tertiary)]' },
  partial: { mark: 'a-line-status-help', messageKey: 'todo.status.partial', className: 'text-[var(--vds-warning-text-primary)]' },
  blocked: { mark: 'a-line-status-error', messageKey: 'todo.status.blocked', className: 'text-[var(--vds-error-text-primary)]' },
  failed: { mark: 'a-line-status-error', messageKey: 'todo.status.failed', className: 'text-[var(--vds-error-text-primary)]' },
  stopped: { mark: 'a-line-status-notfull', messageKey: 'todo.status.stopped', className: 'text-[var(--vds-text-tertiary)]' }
}

function StatusMark({ status }: { status: TodoDisplayStatus }): React.JSX.Element {
  const { t } = useTranslation('components')
  const presentation = STATUS_PRESENTATION[status]
  const LucideMark = presentation.lucide
  return (
    /* min-h-[1lh]: iconfont 字形靠行盒撑高(18/22px), svg 没有行盒会缩成图标自身高度,
       在 items-start 的行里顶边对齐显得偏高; 用自身行高兜底后与右侧文字首行居中对齐。 */
    <span
      className={`inline-grid min-h-[1lh] shrink-0 place-items-center font-medium ${presentation.className}`}
      data-testid={`todo-mark-${status}`}
      aria-label={t(presentation.messageKey)}
    >
      {status === 'running'
        ? <Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />
        : LucideMark
          /* .iconfont 全局 16px, lucide 图标用同一档 icon-8 token 才能与其余状态字形等大。 */
          ? <LucideMark aria-hidden="true" className="size-[var(--vds-icon-8)]" />
          : presentation.mark
            ? <IconFont type={presentation.mark} />
            : null}
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
  // 头部宽度不足时(固定项+时间已挤满, 描述被压到极限仍溢出)把「· 时间」折叠为零宽,
  // 让出空间给描述; 宽度恢复(放下完整头部内容)后再内联展示。
  // 用 ResizeObserver + 功能性 setState 避免震荡。
  // hooks 必须位于下方条件 return 之前, 保证每次渲染 hook 顺序稳定。
  const toggleRef = React.useRef<HTMLButtonElement | null>(null)
  const elapsedRef = React.useRef<HTMLSpanElement | null>(null)
  const currentTextRef = React.useRef<HTMLSpanElement | null>(null)
  const elapsedNeedRef = React.useRef(0)
  const [elapsedHidden, setElapsedHidden] = React.useState(false)
  React.useLayoutEffect(() => {
    const button = toggleRef.current
    if (!button) return
    const update = (): void => {
      const gap = Number.parseFloat(window.getComputedStyle(button).columnGap) || 0
      const elapsedNode = elapsedRef.current
      if (elapsedNode) elapsedNeedRef.current = elapsedNode.offsetWidth + gap
      const currentText = currentTextRef.current
      const currentWrapper = currentText?.parentElement ?? null
      setElapsedHidden((hidden) => {
        // 展示态: 描述已被截断(宽度不够)就折叠用时把空间让给描述。
        if (!hidden) return currentText ? currentText.scrollWidth > currentText.clientWidth : hidden
        // 折叠态: scrollWidth 不溢出时恒等于 clientWidth, 量不出空余; 描述 wrapper 的
        // ml-auto 用掉后剩余的自动外边距才是真实空余, 够放下用时(内容+一个 gap)才恢复。
        if (!currentWrapper || !elapsedNeedRef.current) return hidden
        const slack = Number.parseFloat(window.getComputedStyle(currentWrapper).marginLeft) || 0
        return slack < elapsedNeedRef.current
      })
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(button)
    return () => observer.disconnect()
  })
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
    /* compact 的 -mb-8 与 composer assistant 的 pt-12 相抵 → 执行计划与输入框间距 4px（AI 面板容器间距统一 4px）。 */
    <Card padding="sm" className={`!rounded-[var(--vds-radius-6)] !shadow-none ${compact ? '!px-[var(--vds-space-2)] !py-[var(--vds-space-1)] -mb-[var(--vds-space-2)]' : ''}`} data-testid="todo-panel" aria-label={t('todo.title')}>
      <Collapsible className="!gap-[var(--vds-space-1)]" key={`${thread.sessionId}:${thread.todoTurnId}:${allDone}`} defaultOpen={!compact && !allDone}>
        <CollapsibleTrigger asChild>
          <Button ref={toggleRef} variant="ghost" size="content" className="group !flex w-full min-w-0 !justify-start gap-[var(--vds-space-2)] !border-0 !px-[var(--vds-space-1)] !py-[var(--vds-space-1)] text-left" data-testid="todo-toggle">
            <span className="flex shrink-0 items-center gap-[var(--vds-space-2)]">
              <StatusMark status={summary.status} />
              <span className="shrink-0 font-medium">{t('todo.title')}</span>
              {total > 0 ? (
                <Badge size="sm" tone="neutral" className="shrink-0" data-testid="todo-progress">
                  {todoProgressLabel(items)}
                </Badge>
              ) : null}
              {elapsed ? (
                /* 折叠态: 零宽隐藏文本(负 margin 抵消一个 flex gap), 把空间让给描述。 */
                <span className={`shrink-0 ${elapsedHidden ? '!-ml-[var(--vds-space-2)] !w-0 !max-w-0 overflow-hidden' : 'inline-flex'}`}>
                  <span ref={elapsedRef} className="shrink-0 whitespace-nowrap text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]" data-testid="todo-elapsed">· {elapsed}</span>
                </span>
              ) : null}
            </span>
            {estimateLabel ? (
              <EllipsisText className="max-w-[var(--vds-layout-inline-metadata-max-width)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]" data-testid="todo-estimate" tooltip={estimateTooltip} tooltipPortalled tooltipSide="bottom" wrapperClassName="shrink min-w-0">
                · {estimateLabel}
              </EllipsisText>
            ) : null}
            {/* wrapper 不能 flex-1: 隐藏时间后的空余宽度会被它吸收, scrollWidth 永远等于
                clientWidth, 宽度恢复时再显示条件恒假; ml-auto + 自然宽度同样右对齐。 */}
            <EllipsisText ref={currentTextRef} className="text-right text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]" role="status" data-testid="todo-current" tooltipPortalled tooltipSide="bottom" wrapperClassName="ml-auto min-w-0">
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
