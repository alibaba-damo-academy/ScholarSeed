import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  taskDetailText,
  taskErrorText,
  type TaskSourceContribution
} from '../../contracts/features'
import {
  taskProgressPresentation,
  taskTitleText,
  type ProductTask
} from '../../contracts/tasks'
import { useApp } from '../../store'
import { Button, ProgressBar, ScrollArea, Tag, type TagTone } from '../ui'

import { TaskCenterContext, useTaskCenter, type TaskCenterValue } from './taskCenterContext'

const TASK_FALLBACK_POLL_INTERVAL_MS = 15_000


export function TaskCenterProvider({
  children,
  sources
}: {
  children: React.ReactNode
  sources: readonly TaskSourceContribution[]
}): React.JSX.Element {
  const [tasks, setTasks] = useState<ProductTask[]>([])
  const [open, setOpen] = useState(false)
  const [disconnected, setDisconnected] = useState<Set<string>>(() => new Set())
  const tasksRef = useRef<ProductTask[]>([])
  const watchers = useRef<Map<string, () => void>>(new Map())
  const pendingTerminals = useRef<Map<string, { task: ProductTask; announce: boolean }>>(new Map())
  const finalizing = useRef(false)
  const initialSyncStarted = useRef(false)
  const initialSyncCompleted = useRef(false)
  const { state, act } = useApp()
  const { t } = useTranslation('tasks')
  const errorText = useCallback(
    (task: ProductTask): string => taskErrorText(task, sources, t),
    [sources, t]
  )
  const detailText = useCallback(
    (task: ProductTask): string => taskDetailText(task, sources, t),
    [sources, t]
  )

  const replaceTask = useCallback((task: ProductTask): void => {
    const next = [
      task,
      ...tasksRef.current.filter(
        (candidate) => candidate.id !== task.id || candidate.sourceId !== task.sourceId
      )
    ].sort((left, right) => right.updatedAt - left.updatedAt)
    tasksRef.current = next
    setTasks(next)
  }, [])

  const finalizePending = useCallback(async (): Promise<void> => {
    if (finalizing.current) return
    finalizing.current = true
    try {
      while (pendingTerminals.current.size > 0) {
        const batch = new Map(pendingTerminals.current)
        let refreshed = false
        try {
          refreshed = await act.reloadResourceTree()
        } catch {
          refreshed = false
        }
        if (!refreshed) break
        const resolved = new Map<string, { task: ProductTask; announce: boolean }>()
        for (const [key, entry] of batch) {
          const pending = pendingTerminals.current.get(key)
          if (pending?.task.eventSeq !== entry.task.eventSeq) continue
          pendingTerminals.current.delete(key)
          resolved.set(key, entry)
        }
        const next = tasksRef.current
          .map((current) => resolved.get(`${current.sourceId}:${current.id}`)?.task ?? current)
          .sort((left, right) => right.updatedAt - left.updatedAt)
        tasksRef.current = next
        setTasks(next)
        for (const { task, announce } of resolved.values()) {
          if (!announce) continue
          act.noticeResource(
            task.status === 'completed' ? 'ok' : 'error',
            task.status === 'completed'
              ? {
                  namespace: 'tasks',
                  key: 'feedback.completed',
                  name: task.title,
                  detail: detailText(task) || undefined
                }
              : {
                  namespace: 'tasks',
                  key: 'feedback.incomplete',
                  name: task.title,
                  detail: errorText(task) || undefined
                }
          )
        }
      }
    } finally {
      finalizing.current = false
    }
  }, [act, detailText, errorText])

  const finalize = useCallback(
    (task: ProductTask, announce: boolean): void => {
      const key = `${task.sourceId}:${task.id}`
      pendingTerminals.current.set(key, { task, announce })
      replaceTask({
        ...task,
        status: 'settling',
        phase: 'refreshing',
        detail: ''
      })
      void finalizePending()
    },
    [finalizePending, replaceTask]
  )

  const acceptTask = useCallback(
    (task: ProductTask, announce: boolean): void => {
      const key = `${task.sourceId}:${task.id}`
      const previous = tasksRef.current.find(
        (candidate) => `${candidate.sourceId}:${candidate.id}` === key
      )
      if (previous && task.eventSeq < previous.eventSeq) return
      const becameTerminal =
        announce &&
        previous?.status !== task.status &&
        (task.status === 'completed' ||
          task.status === 'partial' ||
          task.status === 'failed' ||
          task.status === 'cancelled')
      if (
        becameTerminal &&
        (task.status === 'completed' || task.status === 'partial') &&
        task.projectId === state.homeSelectedProjectId
      ) {
        finalize(task, true)
        return
      }
      replaceTask(task)
      if (!becameTerminal) return
      act.noticeResource(
        task.status === 'cancelled' ? 'ok' : 'error',
        task.status === 'cancelled'
          ? { namespace: 'tasks', key: 'feedback.cancelled', name: task.title }
          : {
              namespace: 'tasks',
              key: 'feedback.incomplete',
              name: task.title,
              detail: errorText(task) || undefined
            }
      )
    },
    [act, errorText, finalize, replaceTask, state.homeSelectedProjectId]
  )

  const refresh = useCallback(async (announce = true): Promise<void> => {
    const settled = await Promise.allSettled(sources.map((source) => source.list()))
    const snapshots = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    if (!initialSyncCompleted.current && !announce) {
      const next = snapshots.sort((left, right) => right.updatedAt - left.updatedAt)
      tasksRef.current = next
      setTasks(next)
      next
        .filter(
          (task) =>
            (task.status === 'completed' || task.status === 'partial') &&
            task.projectId === state.homeSelectedProjectId
        )
        .forEach((task) => finalize(task, false))
    } else {
      snapshots.forEach((task) => acceptTask(task, announce))
    }
    if (pendingTerminals.current.size > 0) void finalizePending()
    initialSyncCompleted.current = true
  }, [acceptTask, finalize, finalizePending, sources, state.homeSelectedProjectId])

  useEffect(() => {
    if (initialSyncStarted.current) return
    initialSyncStarted.current = true
    void refresh(false)
  }, [refresh])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    const unsubscribers = sources.flatMap((source) =>
      source.subscribe
        ? [
            source.subscribe((task) => {
              acceptTask(task, true)
              void refresh()
            })
          ]
        : []
    )
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [acceptTask, refresh, sources])

  useEffect(() => {
    const activeKeys = new Set<string>()
    for (const task of tasks) {
      if (task.status !== 'queued' && task.status !== 'running') continue
      const key = `${task.sourceId}:${task.id}`
      activeKeys.add(key)
      if (watchers.current.has(key)) continue
      const source = sources.find((candidate) => candidate.id === task.sourceId)
      if (!source?.watch) continue
      const stop = source.watch(task, {
        onTask: (updated) => acceptTask(updated, true),
        onConnectionChange: (connected) => {
          setDisconnected((current) => {
            const next = new Set(current)
            if (connected) next.delete(key)
            else next.add(key)
            return next
          })
        }
      })
      watchers.current.set(key, stop)
    }
    for (const [key, stop] of watchers.current) {
      if (activeKeys.has(key)) continue
      stop()
      watchers.current.delete(key)
    }
  }, [acceptTask, sources, tasks])

  useEffect(() => {
    if (!open || disconnected.size === 0) return
    const timer = window.setInterval(() => void refresh(), TASK_FALLBACK_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [disconnected, open, refresh])

  useEffect(
    () => () => {
      watchers.current.forEach((stop) => stop())
      watchers.current.clear()
    },
    []
  )

  const mutate = useCallback(
    async (task: ProductTask, action: 'cancel' | 'retry'): Promise<void> => {
      const source = sources.find((candidate) => candidate.id === task.sourceId)
      if (!source) return
      const updated = await source[action](task.id)
      acceptTask(updated, true)
    },
    [acceptTask, sources]
  )

  const value = useMemo<TaskCenterValue>(
    () => ({
      activeCount: tasks.filter(
        (task) => task.status === 'queued' || task.status === 'running' || task.status === 'settling'
      ).length,
      tasks,
      open,
      setOpen,
      cancel: (task) => mutate(task, 'cancel'),
      retry: (task) => mutate(task, 'retry'),
      errorText
    }),
    [errorText, mutate, open, tasks]
  )

  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>
}


const STATUS_TONES = {
  queued: 'neutral',
  running: 'warning',
  settling: 'warning',
  completed: 'brand',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral'
} as const satisfies Record<ProductTask['status'], TagTone>

const STATUS_MESSAGE_KEYS = {
  queued: 'status.queued',
  running: 'status.running',
  settling: 'status.settling',
  completed: 'status.completed',
  partial: 'status.partial',
  failed: 'status.failed',
  cancelled: 'status.cancelled'
} as const

export function TaskCenter(): React.JSX.Element {
  const { t } = useTranslation('tasks')
  const { t: uiText } = useTranslation('ui')
  const { tasks, cancel, retry, errorText } = useTaskCenter()
  return (
    <section
      className="w-full min-w-0 overflow-hidden"
      aria-label={t('center.title')}
      data-testid="task-center"
    >
      <div className="border-b border-[var(--vds-divider-default)] px-4 py-3">
        <h2 className="m-0 text-[14px] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
          {t('center.title')}
        </h2>
        <p className="m-0 mt-1 text-[11px] text-[var(--vds-text-secondary)]">
          {t('center.description')}
        </p>
      </div>
      <ScrollArea className="max-h-[420px]">
        {tasks.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-[var(--vds-text-secondary)]">
            {t('center.empty')}
          </div>
        ) : (
          <div className="grid gap-2 p-3">
            {tasks.map((task) => {
              const active =
                task.status === 'queued' || task.status === 'running' || task.status === 'settling'
              const canCancel = task.status === 'queued' || task.status === 'running'
              const canRetry = task.status === 'failed' || task.status === 'partial' || task.status === 'cancelled'
              const progress = taskProgressPresentation(task, t)
              return (
                <article
                  key={`${task.sourceId}:${task.id}`}
                  className="min-w-0 overflow-hidden rounded-[10px] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
                        {taskTitleText(task.title, t)}
                      </div>
                    </div>
                    <Tag className="shrink-0" size="small" tone={STATUS_TONES[task.status]}>{t(STATUS_MESSAGE_KEYS[task.status])}</Tag>
                  </div>
                  {active ? (
                    <ProgressBar
                      className="mt-3 w-full max-w-full"
                      indeterminate={!progress.determinate}
                      label={progress.label}
                      value={progress.value}
                    />
                  ) : null}
                  {task.error ? (
                    <p className="m-0 mt-2 text-[11px] text-[var(--vds-error-text-primary)]">
                      {errorText(task)}
                    </p>
                  ) : null}
                  {canCancel || canRetry ? (
                    <div className="mt-3 flex justify-end gap-2">
                      {canCancel ? (
                        <Button size="sm" variant="outline" onClick={() => void cancel(task)}>
                          {uiText('cancel')}
                        </Button>
                      ) : null}
                      {canRetry ? (
                        <Button size="sm" variant="outline" onClick={() => void retry(task)}>
                          {uiText('retry')}
                        </Button>
                      ) : null}
                    </div>
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
