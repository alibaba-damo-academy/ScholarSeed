import { apiFetch } from './client.ts'

export interface PdfAiSubmission {
  kind: string
  client_attempt_id: string
  service_instance_id?: string
}
interface PdfAiSubmissionOptions {
  allowJoinedTaskId?: boolean
  delays?: readonly number[]
}
export interface PdfAiTaskReceipt {
  task_id: string
  status: string
}
export const PDF_AI_TASK_UNRESOLVED = 'pdf_ai_task_unresolved'
export const PDF_AI_SERVICE_INSTANCE_CHANGED = 'pdf_ai_service_instance_changed'

export interface PdfAiFailure {
  code?: string
  diagnostic: string
}

export const PDF_AI_PREFIX = '/api/literature/ai'
export const PDF_AI_INVALID_RESPONSE = 'pdf_ai_invalid_response'
const PDF_AI_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
export const PDF_AI_TASK_STATUSES = new Set([
  'pending',
  'running',
  'unknown',
  ...PDF_AI_TERMINAL_STATUSES,
])
export const PDF_AI_RECOVERY_DELAYS = [1000, 2000, 4000, 8000, 16000, 16000, 16000] as const
const PDF_AI_SUBMISSION_DELAYS = [1000, 2000, 4000, 8000] as const
export const PDF_AI_STREAM_INTERRUPTED = 'pdf_ai_stream_interrupted'
const PDF_AI_RECOVERY_REQUEST_TIMEOUT_MS = 10_000
const PDF_AI_SUBMISSION_TIMEOUT_MS = 30_000
const PDF_AI_TRANSIENT_HTTP = new Set([502, 503, 504])
const PDF_AI_TASK_MISSING = 'pdf_ai_task_missing'
export const pdfAiTaskFinished = (task: PdfAiTaskReceipt): boolean =>
  PDF_AI_TERMINAL_STATUSES.has(task.status)
export class PdfAiRequestError extends Error {
  readonly httpStatus?: number
  readonly code?: string
  readonly diagnostic: string
  constructor(failure: PdfAiFailure, httpStatus?: number) {
    super(failure.diagnostic || failure.code || '')
    this.code = failure.code
    this.diagnostic = failure.diagnostic
    this.name = 'PdfAiRequestError'
    this.httpStatus = httpStatus
  }
}

export class PdfAiUnconfirmedSubmission extends PdfAiRequestError {
  constructor(readonly attemptId: string) {
    super({ code: PDF_AI_TASK_UNRESOLVED, diagnostic: '' })
  }
}

function pdfAiClientRejection(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500
}

export async function pdfAiApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await apiFetch(
    path,
    body === undefined
      ? { signal }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }
  )
  let responseText: string
  try {
    responseText = await response.text()
  } catch (cause) {
    if (pdfAiClientRejection(response.status)) {
      throw new PdfAiRequestError({ diagnostic: `HTTP ${response.status}` }, response.status)
    }
    throw cause
  }
  let payload: unknown
  try {
    payload = responseText ? JSON.parse(responseText) : null
  } catch {
    throw new PdfAiRequestError(
      {
        code: PDF_AI_INVALID_RESPONSE,
        diagnostic: response.ok ? '' : `HTTP ${response.status}`,
      },
      response.status
    )
  }
  const detail =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).detail
      : undefined
  if (!response.ok)
    throw new PdfAiRequestError(pdfAiFailure(detail) ?? { diagnostic: '' }, response.status)
  return payload as T
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string') ?? ''
}

/** HTTP details, live tasks and restored tasks retain error identity independently of language. */
export function pdfAiFailure(value: unknown): PdfAiFailure | undefined {
  if (typeof value === 'string') return value ? { diagnostic: value } : undefined
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const code = firstString(source.error_code) || firstString(source.code)
  const detail = firstString(source.error_detail, source.diagnostic, source.message)
  const legacy = firstString(source.error)
  const diagnostic = detail || (legacy && legacy !== code ? legacy : '')
  return code || diagnostic ? { ...(code ? { code } : {}), diagnostic } : undefined
}

export function recoverablePdfTransport(cause: unknown): boolean {
  return (
    cause instanceof TypeError ||
    (cause instanceof DOMException && cause.name === 'TimeoutError') ||
    (cause instanceof PdfAiRequestError &&
      (cause.code === PDF_AI_STREAM_INTERRUPTED ||
        PDF_AI_TRANSIENT_HTTP.has(cause.httpStatus ?? 0)))
  )
}

export async function recoveryDelay(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, delay)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

export async function readPdfAiTask<T extends PdfAiTaskReceipt>(
  path: string,
  body: unknown,
  signal: AbortSignal
): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(PDF_AI_RECOVERY_REQUEST_TIMEOUT_MS)])
  try {
    const task = await pdfAiApi<T>(path, body, bounded)
    bounded.throwIfAborted()
    return task
  } catch (cause) {
    // A fetch body can report AbortError even when the bound signal timed out.
    if (!(cause instanceof PdfAiRequestError && pdfAiClientRejection(cause.httpStatus))) {
      bounded.throwIfAborted()
    }
    throw cause
  }
}

export async function queryPdfAiTask<T extends PdfAiTaskReceipt>(
  taskId: string,
  signal: AbortSignal,
  serviceInstanceId?: string
): Promise<T> {
  const path = `${PDF_AI_PREFIX}/tasks/${encodeURIComponent(taskId)}`
  const query = serviceInstanceId
    ? `?${new URLSearchParams({ service_instance_id: serviceInstanceId })}`
    : ''
  const task = await readPdfAiTask<T>(path + query, undefined, signal)
  if (!task || task.task_id !== taskId || !PDF_AI_TASK_STATUSES.has(task.status)) {
    throw new PdfAiRequestError({ code: PDF_AI_INVALID_RESPONSE, diagnostic: '' })
  }
  return task
}

export function pdfAiTaskMissing(cause: unknown): boolean {
  return (
    cause instanceof PdfAiRequestError &&
    cause.httpStatus === 404 &&
    cause.code === PDF_AI_TASK_MISSING
  )
}

function pdfAiInstanceChanged(cause: unknown): boolean {
  return cause instanceof PdfAiRequestError && cause.code === PDF_AI_SERVICE_INSTANCE_CHANGED
}

async function postPdfAiTask<T extends PdfAiTaskReceipt>(
  request: PdfAiSubmission,
  signal: AbortSignal,
  allowJoinedTaskId: boolean
): Promise<T> {
  const task = await readPdfAiTask<T>(`${PDF_AI_PREFIX}/tasks`, request, signal)
  if (
    !task ||
    typeof task.task_id !== 'string' ||
    !task.task_id ||
    (task.task_id !== request.client_attempt_id && !allowJoinedTaskId) ||
    !PDF_AI_TASK_STATUSES.has(task.status)
  ) {
    throw new PdfAiRequestError({ code: PDF_AI_INVALID_RESPONSE, diagnostic: '' })
  }
  return task
}

function uncertainPdfSubmission(cause: unknown): boolean {
  if (recoverablePdfTransport(cause)) return true
  return (
    cause instanceof PdfAiRequestError &&
    cause.code === PDF_AI_INVALID_RESPONSE &&
    (cause.httpStatus === undefined || (cause.httpStatus >= 200 && cause.httpStatus < 300))
  )
}

export async function submitPdfAiReceipt<T extends PdfAiTaskReceipt>(
  request: PdfAiSubmission,
  signal: AbortSignal,
  options: PdfAiSubmissionOptions = {}
): Promise<T> {
  signal.throwIfAborted()
  const deadline = AbortSignal.timeout(PDF_AI_SUBMISSION_TIMEOUT_MS)
  try {
    return await submitPdfAiAttempt<T>(request, AbortSignal.any([signal, deadline]), options)
  } catch (cause) {
    signal.throwIfAborted()
    if (cause === deadline.reason) {
      throw new PdfAiUnconfirmedSubmission(request.client_attempt_id)
    }
    throw cause
  }
}

async function submitPdfAiAttempt<T extends PdfAiTaskReceipt>(
  request: PdfAiSubmission,
  signal: AbortSignal,
  { allowJoinedTaskId = false, delays = PDF_AI_SUBMISSION_DELAYS }: PdfAiSubmissionOptions
): Promise<T> {
  signal.throwIfAborted()
  try {
    return await postPdfAiTask<T>(request, signal, allowJoinedTaskId)
  } catch (cause) {
    if (!uncertainPdfSubmission(cause)) throw cause
    signal.throwIfAborted()
  }
  for (const delay of delays) {
    await recoveryDelay(delay, signal)
    try {
      return await queryPdfAiTask<T>(request.client_attempt_id, signal, request.service_instance_id)
    } catch (cause) {
      signal.throwIfAborted()
      if (pdfAiTaskMissing(cause)) {
        if (!request.service_instance_id) break
        try {
          return await postPdfAiTask<T>(request, signal, allowJoinedTaskId)
        } catch (retryCause) {
          if (pdfAiInstanceChanged(retryCause)) break
          if (!uncertainPdfSubmission(retryCause)) throw retryCause
          signal.throwIfAborted()
        }
      } else {
        if (pdfAiInstanceChanged(cause)) break
        if (!recoverablePdfTransport(cause)) throw cause
      }
    }
  }
  throw new PdfAiUnconfirmedSubmission(request.client_attempt_id)
}
