import type { TFunction } from 'i18next'

import {
  taskTitleText,
  type ProductTask,
  type ProductTaskPresentation
} from '../../contracts/tasks.ts'

interface ResourceImportSourcePayload {
  source_index: number
  source_name?: string
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled'
  error: string
  retryable?: boolean
}

interface ResourceImportSourceSummaryPayload {
  total: number
  succeeded: number
  failed: number
  cancelled: number
}

interface ResourceImportJobPayload {
  id: string
  project_id: string
  mode: 'copy' | 'link'
  status: ProductTask['status']
  phase: string
  source_names: string[]
  source_summary?: ResourceImportSourceSummaryPayload
  source_results?: ResourceImportSourcePayload[]
  scan_discovered_items: number
  completed_items: number
  total_items: number
  completed_bytes: number
  total_bytes: number
  version_discovered_items: number
  version_completed_items: number
  version_total_items: number
  event_seq: number
  error: string
  created_at: number
  updated_at: number
}

const RESOURCE_IMPORT_SOURCE_ID = 'resource-imports'

const IMPORT_EVENT_RECONNECT_INITIAL_MS = 1_000
const IMPORT_EVENT_RECONNECT_MAX_MS = 30_000
const importTaskListeners = new Set<(task: ProductTask) => void>()
const base = (): string => window.scholarseed?.getApiBase() ?? ''

const toImportTask = (job: ResourceImportJobPayload): ProductTask => {
  const results = (job.source_results ?? []).map((result) => ({
    index: result.source_index,
    name: result.source_name ?? job.source_names[result.source_index] ?? '',
    status: result.status,
    error: result.error,
    retryable:
      result.retryable ?? (result.status === 'failed' || result.status === 'cancelled')
  }))
  const resultSummary = {
    total: results.length,
    succeeded: results.filter((result) => result.status === 'succeeded').length,
    failed: results.filter((result) => result.status === 'failed').length,
    cancelled: results.filter((result) => result.status === 'cancelled').length
  }
  const summary = results.length > 0 ? resultSummary : (job.source_summary ?? resultSummary)
  return {
    id: job.id,
    sourceId: RESOURCE_IMPORT_SOURCE_ID,
    projectId: job.project_id,
    operation: job.mode,
    title: { key: job.mode === 'copy' ? 'title.copy' : 'title.link', names: job.source_names },
    detail: '',
    sourceNames: job.source_names,
    outcome: {
      available: results.length === job.source_names.length,
      ...summary,
      results
    },
    status: job.status,
    phase: job.phase,
    discoveredItems: job.scan_discovered_items,
    completedItems: job.completed_items,
    totalItems: job.total_items,
    completedBytes: job.completed_bytes,
    totalBytes: job.total_bytes,
    versionDiscoveredItems: job.version_discovered_items,
    versionCompletedItems: job.version_completed_items,
    versionTotalItems: job.version_total_items,
    eventSeq: job.event_seq,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at
  }
}

const RESOURCE_IMPORT_ERROR_KEYS = {
  source_not_found: 'resourceImport.errors.sourceNotFound',
  parent_not_writable: 'resourceImport.errors.parentNotWritable',
  target_not_found: 'resourceImport.errors.targetNotFound',
  name_exists: 'resourceImport.errors.nameExists',
  import_failed: 'resourceImport.errors.importFailed',
  copy_failed: 'resourceImport.errors.copyFailed',
  root_exists: 'resourceImport.errors.rootExists',
  disk_full: 'resourceImport.errors.diskFull',
  storage_io_failed: 'resourceImport.errors.storageIoFailed',
  resource_import_interrupted: 'resourceImport.errors.interrupted',
  resource_import_failed: 'resourceImport.errors.importFailed',
  resource_import_partial: 'resourceImport.errors.partial'
} as const

const resourceImportError = (error: string, t: TFunction<'tasks'>): string => {
  const key = RESOURCE_IMPORT_ERROR_KEYS[error as keyof typeof RESOURCE_IMPORT_ERROR_KEYS]
  return key ? t(key) : t('resourceImport.errors.unknown', { error })
}

export function presentResourceImportTask(
  task: ProductTask,
  t: TFunction<'tasks'>
): ProductTaskPresentation {
  const copy = task.operation === 'copy'
  const title = taskTitleText(task.title, t)
  const notImported = task.outcome.failed + task.outcome.cancelled
  const terminal =
    task.status === 'completed' ||
    task.status === 'partial' ||
    task.status === 'failed' ||
    task.status === 'cancelled'
  const detail = task.outcome.available && terminal
    ? t(
        copy ? 'resourceImport.summary.copy' : 'resourceImport.summary.link',
        { succeeded: task.outcome.succeeded, failed: notImported }
      )
    : task.totalItems > 0
      ? t('resourceImport.progressItems', {
          completed: task.completedItems,
          total: task.totalItems
        })
      : t('progress.preparing')
  return {
    title,
    detail,
    announcement: t('resourceImport.announcement', { title, detail }),
    error: task.error ? resourceImportError(task.error, t) : '',
    failures: task.outcome.results
      .filter((result) => result.status === 'failed' || result.status === 'cancelled')
      .map((result) => ({
        name: result.name,
        reason:
          result.status === 'cancelled'
            ? t('resourceImport.errors.cancelled')
            : resourceImportError(result.error, t)
      }))
  }
}

const isTerminalProductTask = (task: ProductTask): boolean =>
  task.status === 'completed' ||
  task.status === 'partial' ||
  task.status === 'failed' ||
  task.status === 'cancelled'

export function subscribeResourceImportTasks(listener: (task: ProductTask) => void): () => void {
  importTaskListeners.add(listener)
  return () => importTaskListeners.delete(listener)
}

export function watchResourceImportTask(
  initialTask: ProductTask,
  callbacks: {
    onTask: (task: ProductTask) => void
    onConnectionChange: (connected: boolean) => void
  }
): () => void {
  let task = initialTask
  let stream: EventSource | null = null
  let retryTimer: number | null = null
  let closed = false
  let attempt = 0

  const open = (): void => {
    if (closed) return
    const query = new URLSearchParams({ after_seq: String(task.eventSeq) })
    const connection = new EventSource(
      `${base()}/api/resource/import-jobs/${encodeURIComponent(task.id)}/events?${query.toString()}`,
      { withCredentials: true }
    )
    stream = connection
    connection.onopen = () => {
      if (connection !== stream) return
      attempt = 0
      callbacks.onConnectionChange(true)
    }
    connection.onmessage = (message) => {
      if (connection !== stream) return
      try {
        const event = JSON.parse(message.data) as {
          seq: number
          data: Partial<ResourceImportJobPayload>
        }
        task = toImportTask({
          id: task.id,
          project_id: task.projectId,
          mode: task.operation === 'copy' ? 'copy' : 'link',
          status: task.status === 'settling' ? 'running' : task.status,
          phase: task.phase,
          source_names: task.sourceNames,
          source_summary: {
            total: task.outcome.total,
            succeeded: task.outcome.succeeded,
            failed: task.outcome.failed,
            cancelled: task.outcome.cancelled
          },
          source_results: task.outcome.results.map((result) => ({
            source_index: result.index,
            source_name: result.name,
            status: result.status,
            error: result.error,
            retryable: result.retryable
          })),
          scan_discovered_items: task.discoveredItems,
          completed_items: task.completedItems,
          total_items: task.totalItems,
          completed_bytes: task.completedBytes,
          total_bytes: task.totalBytes,
          version_discovered_items: task.versionDiscoveredItems,
          version_completed_items: task.versionCompletedItems,
          version_total_items: task.versionTotalItems,
          event_seq: event.seq,
          error: task.error,
          created_at: task.createdAt,
          updated_at: task.updatedAt,
          ...event.data
        })
        callbacks.onTask(task)
        if (isTerminalProductTask(task)) {
          closed = true
          connection.close()
          stream = null
          callbacks.onConnectionChange(true)
        }
      } catch {
        // Ignore a malformed frame; the next durable event or snapshot remains authoritative.
      }
    }
    connection.onerror = () => {
      if (connection !== stream || closed) return
      connection.close()
      stream = null
      callbacks.onConnectionChange(false)
      attempt += 1
      const delay = Math.min(
        IMPORT_EVENT_RECONNECT_MAX_MS,
        IMPORT_EVENT_RECONNECT_INITIAL_MS * 2 ** (attempt - 1)
      )
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        open()
      }, delay)
    }
  }

  open()
  return () => {
    closed = true
    if (retryTimer !== null) window.clearTimeout(retryTimer)
    stream?.close()
    stream = null
  }
}

export async function createResourceImport(
  mode: 'copy' | 'link',
  sources: string[],
  targetDir: string,
  project?: string | null
): Promise<{ ok: boolean; error?: string; task?: ProductTask }> {
  try {
    const response = await fetch(`${base()}/api/resource/import-jobs`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({ mode, sources, target_dir: targetDir, project: project ?? null })
    })
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string; job?: ResourceImportJobPayload }
      | null
    if (!response.ok) return { ok: false, error: payload?.detail ?? `http_${response.status}` }
    const task = payload?.job ? toImportTask(payload.job) : undefined
    if (task) importTaskListeners.forEach((listener) => listener(task))
    return { ok: true, task }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'network_error' }
  }
}

export async function listResourceImportTasks(): Promise<ProductTask[]> {
  const response = await fetch(`${base()}/api/resource/import-jobs`, { credentials: 'include' })
  if (!response.ok) throw new Error(`http_${response.status}`)
  const payload = (await response.json()) as { items: ResourceImportJobPayload[] }
  return payload.items.map(toImportTask)
}

async function mutateResourceImportTask(
  taskId: string,
  action: 'cancel' | 'retry'
): Promise<ProductTask> {
  const response = await fetch(
    `${base()}/api/resource/import-jobs/${encodeURIComponent(taskId)}/${action}`,
    { method: 'POST', credentials: 'include' }
  )
  const payload = (await response.json().catch(() => null)) as
    | { detail?: string; job?: ResourceImportJobPayload }
    | null
  if (!response.ok || !payload?.job) {
    throw new Error(payload?.detail ?? `http_${response.status}`)
  }
  return toImportTask(payload.job)
}

export const cancelResourceImportTask = (taskId: string): Promise<ProductTask> =>
  mutateResourceImportTask(taskId, 'cancel')

export const retryResourceImportTask = (taskId: string): Promise<ProductTask> =>
  mutateResourceImportTask(taskId, 'retry')
