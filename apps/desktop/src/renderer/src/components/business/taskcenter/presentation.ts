import type { TFunction } from 'i18next'
import {
  TASK_ACTION,
  TASK_ERROR,
  TASK_STATUS,
  parseTaskActionRequest,
  type TaskActionRequest,
  type TaskActionReply,
  type TaskActionState,
  type TaskProjection,
} from '../../../../../taskcenter.ts'
import { taskErrorText, type TaskSourceContribution } from '../../../contracts/features.ts'
import {
  taskTitleText,
  taskProgressPresentation,
  type ProductTask,
} from '../../../contracts/tasks.ts'

export type TaskDispatcherPorts = {
  tasks(): readonly ProductTask[]
  sources(): readonly TaskSourceContribution[]
  accept(task: ProductTask): void
  changed(): void
}

export function clearCompletedMessages(
  tasks: readonly ProductTask[],
  dismissals: Readonly<Record<string, number>>
): Record<string, number> {
  const next = { ...dismissals }
  for (const task of tasks) {
    if (task.status !== TASK_STATUS.completed) continue
    const key = JSON.stringify([task.sourceId, task.id])
    next[key] = Math.max(next[key] ?? 0, task.eventSeq)
  }
  return next
}

export function visibleTaskMessages(
  tasks: readonly ProductTask[],
  dismissals: Readonly<Record<string, number>>
): ProductTask[] {
  return tasks.filter(
    (task) =>
      task.status !== TASK_STATUS.completed ||
      task.eventSeq > (dismissals[JSON.stringify([task.sourceId, task.id])] ?? -1)
  )
}

const ACTIVE_STATUSES: readonly string[] = [TASK_STATUS.queued, TASK_STATUS.running]
const ACTION_STATUSES: Record<TaskActionRequest['kind'], readonly string[]> = {
  [TASK_ACTION.cancel]: [TASK_STATUS.queued, TASK_STATUS.running],
  [TASK_ACTION.retry]: [TASK_STATUS.failed, TASK_STATUS.partial, TASK_STATUS.cancelled],
}

function rowKey(sourceId: string, taskId: string): string {
  return JSON.stringify([sourceId, taskId])
}

export function projectTasks(
  tasks: readonly ProductTask[],
  sources: readonly TaskSourceContribution[],
  t: TFunction<'tasks'>,
  actions: ReadonlyMap<string, TaskActionState>
): TaskProjection {
  return {
    activeCount: tasks.filter((task) => ACTIVE_STATUSES.includes(task.status)).length,
    rows: tasks.map((task) => {
      const source = sources.find((candidate) => candidate.id === task.sourceId)
      return {
        sourceId: task.sourceId,
        taskId: task.id,
        eventSeq: task.eventSeq,
        title: taskTitleText(task.title, t),
        status: task.status,
        progress: taskProgressPresentation(task, t),
        error: taskErrorText(task, sources, t),
        failures: (source?.present(task, t).failures ?? []).map((failure) => ({
          name: failure.name,
          reason: failure.reason,
        })),
        canCancel: ACTION_STATUSES[TASK_ACTION.cancel].includes(task.status),
        canRetry: ACTION_STATUSES[TASK_ACTION.retry].includes(task.status),
        action: {
          ...(actions.get(rowKey(task.sourceId, task.id)) ?? { pending: false, error: null }),
        },
      }
    }),
  }
}

export function createTaskDispatcher(ports: TaskDispatcherPorts): {
  dispatch(request: TaskActionRequest): Promise<TaskActionReply>
  states(): ReadonlyMap<string, TaskActionState>
  dispose(): void
} {
  const actions = new Map<string, TaskActionState>()
  let disposed = false
  return {
    async dispatch(request) {
      if (disposed) return { ok: false, error: TASK_ERROR.revoked }
      const parsed = parseTaskActionRequest(request)
      if (!parsed) return { ok: false, error: TASK_ERROR.invalid }
      const key = rowKey(parsed.row.sourceId, parsed.row.taskId)
      if (actions.get(key)?.pending) return { ok: false, error: TASK_ERROR.pending }
      const task = ports
        .tasks()
        .find(
          (candidate) =>
            candidate.sourceId === parsed.row.sourceId && candidate.id === parsed.row.taskId
        )
      if (!task || task.eventSeq !== parsed.row.eventSeq)
        return { ok: false, error: TASK_ERROR.stale }
      const source = ports.sources().find((candidate) => candidate.id === task.sourceId)
      if (!source) return { ok: false, error: TASK_ERROR.unavailable }
      if (!ACTION_STATUSES[parsed.kind].includes(task.status))
        return { ok: false, error: TASK_ERROR.ineligible }
      actions.set(key, { pending: true, error: null })
      ports.changed()
      try {
        const updated = await source[parsed.kind](task.id)
        if (disposed) return { ok: false, error: TASK_ERROR.revoked }
        ports.accept(updated)
        if (disposed) return { ok: false, error: TASK_ERROR.revoked }
        actions.set(key, { pending: false, error: null })
        ports.changed()
        return { ok: true }
      } catch {
        if (disposed) return { ok: false, error: TASK_ERROR.revoked }
        actions.set(key, { pending: false, error: TASK_ERROR.failed })
        ports.changed()
        return { ok: false, error: TASK_ERROR.failed }
      }
    },
    states: () => new Map([...actions].map(([key, state]) => [key, { ...state }])),
    dispose() {
      disposed = true
      actions.clear()
    },
  }
}
