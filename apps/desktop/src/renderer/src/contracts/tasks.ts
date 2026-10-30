import type { TFunction } from 'i18next'

export type ProductTaskStatus =
  'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

export type ProductTaskResultStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled'

export interface ProductTaskResult {
  index: number
  name: string
  status: ProductTaskResultStatus
  error: string
  retryable: boolean
}

export interface ProductTaskOutcome {
  available: boolean
  total: number
  succeeded: number
  failed: number
  cancelled: number
  results: ProductTaskResult[]
}

export type TaskTitle =
  | string
  | {
      key: 'title.copy' | 'title.link'
      names: string[]
    }

export function taskTitleText(title: TaskTitle, t: TFunction<'tasks'>): string {
  if (typeof title === 'string') return title
  const operation = t(title.key)
  if (title.names.length === 0) return operation
  const source =
    title.names.length === 1
      ? title.names[0]
      : t('title.sources', { name: title.names[0], count: title.names.length })
  return t('title.withSource', { operation, source })
}

export interface ProductTask {
  id: string
  sourceId: string
  projectId: string
  operation: string
  title: TaskTitle
  detail: string
  sourceNames: string[]
  outcome: ProductTaskOutcome
  status: ProductTaskStatus
  phase: string
  discoveredItems: number
  completedItems: number
  totalItems: number
  completedBytes: number
  totalBytes: number
  versionDiscoveredItems: number
  versionCompletedItems: number
  versionTotalItems: number
  eventSeq: number
  error: string
  createdAt: number
  updatedAt: number
}

export interface ProductTaskPresentation {
  title: string
  detail: string
  announcement: string
  error: string
  failures: Array<{ name: string; reason: string }>
}

export function isActiveProductTask(task: ProductTask): boolean {
  return task.status === 'queued' || task.status === 'running'
}

const PERCENT_MAX = 100

export interface TaskProgressPresentation {
  determinate: boolean
  label: string
  value: number
}

/**
 * Product progress is phase-local: only facts measurable inside the current stage
 * become a percentage. Terminal outcomes come from the task source.
 */
export function taskProgressPresentation(
  task: ProductTask,
  t: TFunction<'tasks'>
): TaskProgressPresentation {
  if (task.status === 'completed') {
    return { determinate: true, label: t('status.completed'), value: PERCENT_MAX }
  }
  if (task.status === 'partial') {
    return { determinate: false, label: t('status.partial'), value: 0 }
  }
  if (task.status === 'failed') {
    return { determinate: false, label: t('progress.failed'), value: 0 }
  }
  if (task.status === 'cancelled') {
    return { determinate: false, label: t('status.cancelled'), value: 0 }
  }
  if (task.phase === 'scanning') {
    return {
      determinate: false,
      label: t('progress.scanning', { count: task.discoveredItems }),
      value: 0,
    }
  }
  if (task.phase === 'linking') {
    return {
      determinate: false,
      label:
        task.totalItems > 0
          ? t('progress.linkingCount', { count: task.totalItems })
          : t('progress.linking'),
      value: 0,
    }
  }
  if (task.phase === 'versioning') {
    if (task.versionTotalItems <= 0) {
      return {
        determinate: false,
        label: t('progress.discoveringVersions', { count: task.versionDiscoveredItems }),
        value: 0,
      }
    }
    return {
      determinate: true,
      label: t('progress.versioning', {
        completed: task.versionCompletedItems,
        total: task.versionTotalItems,
      }),
      value: Math.min(
        PERCENT_MAX,
        Math.max(0, (task.versionCompletedItems / task.versionTotalItems) * PERCENT_MAX)
      ),
    }
  }
  if (task.phase !== 'copying')
    return { determinate: false, label: t('progress.preparing'), value: 0 }
  const completed = task.totalBytes > 0 ? task.completedBytes : task.completedItems
  const total = task.totalBytes > 0 ? task.totalBytes : task.totalItems
  if (total <= 0) return { determinate: false, label: t('progress.copying'), value: 0 }
  const percentage = Math.min(PERCENT_MAX, Math.max(0, (completed / total) * PERCENT_MAX))
  return {
    determinate: true,
    label: t('progress.copyingPercent', { percentage: Math.round(percentage) }),
    value: percentage,
  }
}
