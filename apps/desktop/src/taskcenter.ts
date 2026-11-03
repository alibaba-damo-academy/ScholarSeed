export const TASK_ACTION = { cancel: 'cancel', retry: 'retry' } as const
export const TASK_ERROR = {
  invalid: 'invalid',
  stale: 'stale',
  unavailable: 'unavailable',
  ineligible: 'ineligible',
  pending: 'pending',
  failed: 'failed',
  revoked: 'revoked',
} as const
export const TASK_STATUS = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  partial: 'partial',
  failed: 'failed',
  cancelled: 'cancelled',
} as const

export type TaskDisplayStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS]
export type TaskError = (typeof TASK_ERROR)[keyof typeof TASK_ERROR]
export type TaskRowKey = { sourceId: string; taskId: string; eventSeq: number }
export type TaskActionRequest = {
  kind: (typeof TASK_ACTION)[keyof typeof TASK_ACTION]
  requestId: string
  row: TaskRowKey
}
export type TaskActionReply = { ok: true } | { ok: false; error: TaskError }
export type TaskActionState = { pending: boolean; error: TaskError | null }
export type TaskDisplayRow = TaskRowKey & {
  title: string
  status: TaskDisplayStatus
  progress: { determinate: boolean; label: string; value: number }
  error: string
  failures: { name: string; reason: string }[]
  canCancel: boolean
  canRetry: boolean
  action: TaskActionState
}
export type TaskProjection = { activeCount: number; rows: TaskDisplayRow[] }

const PROGRESS_MAX = 100
const ROW_FIELDS = ['sourceId', 'taskId', 'eventSeq']
const DISPLAY_FIELDS = [
  ...ROW_FIELDS,
  'title',
  'status',
  'progress',
  'error',
  'failures',
  'canCancel',
  'canRetry',
  'action',
]
const ACTIVE_STATUSES: readonly TaskDisplayStatus[] = [
  TASK_STATUS.queued,
  TASK_STATUS.running,
]

function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object' || ancestors.has(value)) return undefined
  const array = Array.isArray(value)
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
    return undefined
  ancestors.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string')) return undefined
  const result: Record<string, unknown> | unknown[] = array ? [] : {}
  if (array && keys.length !== value.length + 1) return undefined
  for (const key of keys as string[]) {
    if (array && key === 'length') continue
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) return undefined
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return undefined
    const cloned = cloneJson(descriptor.value, ancestors)
    if (cloned === undefined) return undefined
    Object.defineProperty(result, key, {
      value: cloned,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  ancestors.delete(value)
  return result
}

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  )
}

function identity(value: Record<string, unknown>): boolean {
  return (
    typeof value.sourceId === 'string' &&
    value.sourceId.length > 0 &&
    typeof value.taskId === 'string' &&
    value.taskId.length > 0 &&
    Number.isSafeInteger(value.eventSeq) &&
    (value.eventSeq as number) >= 0
  )
}

function displayRow(value: unknown): value is TaskDisplayRow {
  if (!exact(value, DISPLAY_FIELDS) || !identity(value)) return false
  if (
    typeof value.title !== 'string' ||
    typeof value.error !== 'string' ||
    !Object.values(TASK_STATUS).includes(value.status as TaskDisplayStatus) ||
    typeof value.canCancel !== 'boolean' ||
    typeof value.canRetry !== 'boolean'
  )
    return false
  const progress = value.progress
  if (
    !exact(progress, ['determinate', 'label', 'value']) ||
    typeof progress.determinate !== 'boolean' ||
    typeof progress.label !== 'string' ||
    typeof progress.value !== 'number' ||
    progress.value < 0 ||
    progress.value > PROGRESS_MAX
  )
    return false
  if (
    !Array.isArray(value.failures) ||
    !value.failures.every(
      (failure) =>
        exact(failure, ['name', 'reason']) &&
        typeof failure.name === 'string' &&
        typeof failure.reason === 'string'
    )
  )
    return false
  const action = value.action
  return (
    exact(action, ['pending', 'error']) &&
    typeof action.pending === 'boolean' &&
    (action.error === null || Object.values(TASK_ERROR).includes(action.error as TaskError))
  )
}

export function parseTaskActionRequest(value: unknown): TaskActionRequest | null {
  try {
    const parsed = cloneJson(value)
    if (
      !exact(parsed, ['kind', 'requestId', 'row']) ||
      !Object.values(TASK_ACTION).includes(parsed.kind as TaskActionRequest['kind']) ||
      typeof parsed.requestId !== 'string' ||
      parsed.requestId.length === 0 ||
      !exact(parsed.row, ROW_FIELDS) ||
      !identity(parsed.row)
    )
      return null
    return parsed as TaskActionRequest
  } catch {
    return null
  }
}

export function parseTaskProjection(value: unknown): TaskProjection | null {
  try {
    const parsed = cloneJson(value)
    if (
      !exact(parsed, ['activeCount', 'rows']) ||
      !Number.isSafeInteger(parsed.activeCount) ||
      !Array.isArray(parsed.rows) ||
      !parsed.rows.every(displayRow)
    )
      return null
    const activeCount = parsed.rows.filter((row) => ACTIVE_STATUSES.includes(row.status)).length
    return parsed.activeCount === activeCount ? (parsed as TaskProjection) : null
  } catch {
    return null
  }
}
