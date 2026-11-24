import { apiFetch } from '../../api.ts'
import { PDF_AI_PREFIX, readPdfAiTask, submitPdfAiReceipt } from '../../app/api/pdf.ts'
import { sseData } from '../../sse.ts'
import type { ReadingState, ReadingTask, ReadingTiming } from '../../contracts/literature'

const PREFIX = `${PDF_AI_PREFIX}/tasks`
export const readingBusy = (task?: ReadingTask | null): boolean =>
  task?.status === 'pending' || task?.status === 'running'
export class ReadingError extends Error {
  constructor(
    readonly code: string,
    readonly diagnostic = ''
  ) {
    super(code)
  }
}
export async function readingRequest<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await apiFetch(url, {
    signal,
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })
  const data = await response.json()
  if (!response.ok)
    throw new ReadingError(
      data?.detail?.code || 'pdf_ai_execution_failed',
      data?.detail?.diagnostic || ''
    )
  return data as T
}
export function readReading(
  literatureId: string,
  attachmentId: string,
  revision: string,
  signal?: AbortSignal
): Promise<ReadingState> {
  const query = new URLSearchParams({ attachment_id: attachmentId, source_revision: revision })
  return readingRequest(
    `/api/literature/${encodeURIComponent(literatureId)}/ai/state?${query}`,
    undefined,
    signal
  )
}
export function generateReading(
  literatureId: string,
  attachmentId: string,
  revision: string,
  modelKey: string,
  language: 'zh' | 'en',
  serviceInstanceId?: string | null,
  signal = new AbortController().signal
): Promise<ReadingTask> {
  const request = {
    literature_id: literatureId,
    attachment_id: attachmentId,
    revision,
    model_key: modelKey,
    kind: 'interpretation',
    module: 'summary',
    response_language: language,
    client_action_id: crypto.randomUUID(),
    client_attempt_id: crypto.randomUUID(),
    service_instance_id: serviceInstanceId ?? undefined,
  }
  return submitPdfAiReceipt<ReadingTask>(request, signal)
}
export function cancelReading(
  taskId: string,
  signal = new AbortController().signal
): Promise<ReadingTask> {
  return readPdfAiTask(`${PREFIX}/${encodeURIComponent(taskId)}/cancel`, {}, signal)
}
export async function observeReading(
  taskId: string,
  signal: AbortSignal,
  receive: (task: ReadingTask) => void
): Promise<void> {
  const response = await apiFetch(`${PREFIX}/${encodeURIComponent(taskId)}/events`, { signal })
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    throw new ReadingError('pdf_ai_invalid_response')
  for await (const data of sseData(response.body)) {
    const task = JSON.parse(data) as ReadingTask
    if (
      task.task_id !== taskId ||
      !['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(task.status)
    )
      throw new ReadingError('pdf_ai_invalid_response')
    if (signal.aborted) return
    receive(task)
    if (!readingBusy(task)) return
  }
  if (!signal.aborted) throw new ReadingError('pdf_ai_invalid_response')
}

export function recordReadingTiming(taskId: string, timing: ReadingTiming): Promise<unknown> {
  return readingRequest(`${PREFIX}/${encodeURIComponent(taskId)}/timing`, timing)
}
