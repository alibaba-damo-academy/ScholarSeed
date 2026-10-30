import { useStartup } from '../../app/connection'
import { STARTUP_PHASE } from '../../../../startup'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BrushCleaning } from 'lucide-react'
import { IconFont } from '../primitive/Iconfont'

import {
  taskDetailText,
  taskErrorText,
  type TaskSourceContribution,
} from '../../contracts/features'
import {
  isActiveProductTask,
  taskProgressPresentation,
  taskTitleText,
  type ProductTask,
} from '../../contracts/tasks'
import { useApp } from '../../store'
import {
  Button,
  EllipsisText,
  IconButton,
  ProgressBar,
  ScrollArea,
  Tag,
  Tooltip,
  type TagTone,
} from '../ui'

import { TaskCenterContext, useTaskCenter, type TaskCenterValue } from './taskCenterContext'
import { TaskFeed } from './taskfeed'
import { clearCompletedMessages, visibleTaskMessages } from './taskcenter/presentation'

const TASK_FALLBACK_POLL_INTERVAL_MS = 15_000
const TIMESTAMP_MILLISECONDS_PER_SECOND = 1000
const MESSAGE_DATE_FORMATTER = new Intl.DateTimeFormat('en', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function TaskCenterProvider({
  children,
  sources,
}: {
  children: React.ReactNode
  sources: readonly TaskSourceContribution[]
}): React.JSX.Element {
  const [tasks, setTasks] = useState<ProductTask[]>([])
  const [open, setOpen] = useState(false)
  const [clearingCompleted, setClearingCompleted] = useState(false)
  const clearingRef = useRef(false)
  const { state, act } = useApp()
  const startup = useStartup()
  const { t } = useTranslation('tasks')
  const errorText = useCallback(
    (task: ProductTask): string => taskErrorText(task, sources, t),
    [sources, t]
  )
  const detailText = useCallback(
    (task: ProductTask): string => taskDetailText(task, sources, t),
    [sources, t]
  )
  const failures = useCallback(
    (task: ProductTask) =>
      sources.find((source) => source.id === task.sourceId)?.present(task, t).failures ?? [],
    [sources, t]
  )
  const failureDetail = useCallback(
    (task: ProductTask): string => {
      const sourceFailures = failures(task)
      const first = sourceFailures[0]
      const reason = first
        ? t('failure', { name: first.name, reason: first.reason })
        : errorText(task) || t('feedback.reasonUnavailable')
      const remaining = sourceFailures.length - 1
      return [
        reason,
        detailText(task),
        remaining > 0 ? t('feedback.moreFailures', { count: remaining }) : '',
      ]
        .filter(Boolean)
        .join(' ')
    },
    [detailText, errorText, failures, t]
  )

  const announceRef = useRef<(task: ProductTask) => void>(() => undefined)
  announceRef.current = (task) => {
    if (task.status === 'completed') {
      act.noticeResource('ok', {
        namespace: 'tasks',
        key: 'feedback.completed',
        name: task.title,
        detail: detailText(task) || undefined,
      })
    } else {
      act.noticeResource(
        task.status === 'cancelled' ? 'ok' : 'error',
        task.status === 'cancelled'
          ? { namespace: 'tasks', key: 'feedback.cancelled', name: task.title }
          : {
              namespace: 'tasks',
              key: 'feedback.incomplete',
              name: task.title,
              detail: failureDetail(task),
              openTaskCenter: true,
            }
      )
    }
  }
  const feed = useMemo(
    () => new TaskFeed(sources, setTasks, (task) => announceRef.current(task)),
    [sources]
  )

  useEffect(() => {
    if (startup.phase !== STARTUP_PHASE.ready) return
    feed.start()
    const timer = window.setInterval(() => {
      if (feed.needsRefresh()) void feed.refresh()
    }, TASK_FALLBACK_POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      feed.stop()
    }
  }, [feed, startup.generation, startup.phase])

  useEffect(() => {
    if (open && startup.phase === STARTUP_PHASE.ready) void feed.refresh()
  }, [open, feed, startup.phase])

  useEffect(() => {
    if (startup.phase !== STARTUP_PHASE.ready) return
    const onFocus = (): void => {
      void feed.refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [feed, startup.phase])

  const value = useMemo<TaskCenterValue>(
    () => ({
      activeCount: tasks.filter(isActiveProductTask).length,
      tasks: visibleTaskMessages(tasks, state.taskMessageDismissals),
      open,
      setOpen,
      clearingCompleted,
      clearCompleted: async () => {
        if (clearingRef.current) return
        clearingRef.current = true
        setClearingCompleted(true)
        try {
          await act.clearTaskMessages(clearCompletedMessages(tasks, state.taskMessageDismissals))
        } finally {
          clearingRef.current = false
          setClearingCompleted(false)
        }
      },
      cancel: (task) => feed.mutate(task, 'cancel'),
      retry: (task) => feed.mutate(task, 'retry'),
      errorText,
      failures,
    }),
    [act, clearingCompleted, errorText, failures, feed, open, state.taskMessageDismissals, tasks]
  )

  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>
}

const STATUS_TONES = {
  queued: 'neutral',
  running: 'warning',
  completed: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
} as const satisfies Record<ProductTask['status'], TagTone>

const STATUS_MESSAGE_KEYS = {
  queued: 'status.queued',
  running: 'status.running',
  completed: 'status.completed',
  partial: 'status.partial',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
} as const

export function TaskCenter(): React.JSX.Element {
  const { t } = useTranslation('tasks')
  const { t: uiText } = useTranslation('ui')
  const { tasks, cancel, retry, clearCompleted, clearingCompleted } = useTaskCenter()
  const hasCompleted = tasks.some((task) => task.status === 'completed')
  return (
    <section
      className="flex w-full min-w-0 flex-col gap-[var(--vds-space-3)] overflow-hidden p-[var(--vds-space-4)]"
      aria-label={t('center.title')}
      data-testid="task-center"
    >
      <div className="flex items-center justify-between gap-[var(--vds-space-3)]">
        <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
          {t('center.title')}
        </h2>
        {tasks.length > 0 && (
          <Tooltip
            content={t('center.clearCompleted')}
            contentClassName="!z-[var(--vds-z-update-entry-tooltip)]"
            side="bottom"
            portalled
          >
            <IconButton
              variant="ghostIcon"
              size="sm"
              label={t('center.clearCompleted')}
              title={undefined}
              icon={<BrushCleaning strokeWidth={1.5} />}
              disabled={!hasCompleted || clearingCompleted}
              loading={clearingCompleted}
              onClick={() => void clearCompleted()}
              data-testid="task-center-clear-completed"
            />
          </Tooltip>
        )}
      </div>
      <ScrollArea className="min-w-0 max-h-[var(--vds-message-center-list-height)]">
        {tasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--vds-text-secondary)]">
            {t('center.empty')}
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-[var(--vds-space-2)]">
            {tasks.map((task) => {
              const active = isActiveProductTask(task)
              const canCancel = task.status === 'queued' || task.status === 'running'
              const canRetry =
                task.status === 'failed' || task.status === 'partial' || task.status === 'cancelled'
              const progress = taskProgressPresentation(task, t)
              const title =
                typeof task.title === 'string' ? taskTitleText(task.title, t) : t(task.title.key)
              const files =
                task.sourceNames.length > 0
                  ? task.sourceNames
                  : task.outcome.results.map((result) => result.name)
              const createdAt = new Date(task.createdAt * TIMESTAMP_MILLISECONDS_PER_SECOND)
              const dateParts = Object.fromEntries(
                MESSAGE_DATE_FORMATTER.formatToParts(createdAt).map((part) => [
                  part.type,
                  part.value,
                ])
              )
              const createdAtText = `${dateParts.year}-${dateParts.month}-${dateParts.day} ${dateParts.hour}:${dateParts.minute}`
              return (
                <article
                  key={`${task.sourceId}:${task.id}`}
                  className="min-w-0 overflow-hidden rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <EllipsisText
                        tooltip={title}
                        tooltipContentClassName="!z-[var(--vds-z-update-entry-tooltip)]"
                        tooltipPortalled
                        tabIndex={0}
                        className="truncate text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
                      >
                        {title}
                      </EllipsisText>
                    </div>
                    <Tag className="shrink-0" size="small" tone={STATUS_TONES[task.status]}>
                      {t(STATUS_MESSAGE_KEYS[task.status])}
                    </Tag>
                  </div>
                  <div className="mt-[var(--vds-message-center-content-gap)] grid min-w-0 grid-cols-1 gap-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                    {files.length > 0 ? (
                      files.map((name, index) => (
                        <EllipsisText
                          key={`${index}:${name}`}
                          tooltip={name}
                          tooltipContentClassName="!z-[var(--vds-z-update-entry-tooltip)]"
                          tooltipPortalled
                          tabIndex={0}
                          data-testid="task-source-name"
                        >
                          {name}
                        </EllipsisText>
                      ))
                    ) : (
                      <p className="m-0">{t('center.noFiles')}</p>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-1)]">
                      <time dateTime={createdAt.toISOString()}>{createdAtText}</time>
                      {canCancel || canRetry ? (
                        <div className="flex gap-[var(--vds-space-2)]">
                          {canCancel ? (
                            <Button size="sm" variant="outline" onClick={() => void cancel(task)}>
                              {uiText('cancel')}
                            </Button>
                          ) : null}
                          {canRetry ? (
                            <Button
                              size="sm"
                              variant="outline"
                              icon={
                                <IconFont
                                  type="icon-line-operation-refresh"
                                  className="text-[var(--vds-icon-outline-default)]"
                                />
                              }
                              onClick={() => void retry(task)}
                            >
                              {uiText('retry')}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {active ? (
                    <ProgressBar
                      className="mt-3 w-full max-w-full"
                      indeterminate={!progress.determinate}
                      label={progress.label}
                      value={progress.value}
                    />
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </section>
  )
}
