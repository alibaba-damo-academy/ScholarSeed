import { apiFetch } from '../../../api.ts'
import { postActionStream } from '../../../action.ts'
import { sseData } from '../../../sse.ts'
import {
  ASSISTANT_TRANSLATION_TARGETS,
  type AssistantTranslationTarget,
} from '../../../contracts/assistant.ts'
import { PDF_AI_TASK_UNRESOLVED, pdfAiFailure, type PdfAiFailure } from './failure.ts'

export type PdfAction =
  | 'document_translation'
  | 'interpretation'
  | 'selection_translation'
  | 'selection_explanation'
  | 'figure_explanation'
  | 'formula_latex'
export type PdfVisualRegionKind = 'formula' | 'figure' | 'table'
export interface PdfVisualRegion {
  region_id: string
  kind: PdfVisualRegionKind
  reason: string
  text_policy: 'retain' | 'exclude'
  page: number
  quad: number[]
}
export interface PdfVisualRegionManifest {
  schema_version: number
  detector_version: string
  source_revision: string
  coordinate_space: string
  page_count: number
  unavailable_pages: number[]
  pages: { page: number; unavailable: boolean; regions: PdfVisualRegion[] }[]
}
export interface PdfSelection {
  text: string
  page: number
  quads: number[][]
}
export interface PdfAiContent {
  text: string
  uncertain?: boolean
  evidence?: { page: number; quote: string }[]
}
export const PDF_TRANSLATION_TARGETS = ASSISTANT_TRANSLATION_TARGETS
export type TranslationDirection = AssistantTranslationTarget
export type PdfResponseLanguage = 'zh' | 'en'
export function pdfResponseLanguage(language: string | undefined): PdfResponseLanguage {
  return language?.toLowerCase().startsWith('en') ? 'en' : 'zh'
}
export interface TranslationSentence {
  source_text: string
  translated_text: string
  located: boolean
  paragraph_start?: boolean
  heading?: boolean
}
export interface ReadingSummary extends PdfAiContent {
  paper_type: string
  contribution: PdfAiContent
  claims: PdfAiContent[]
  method: PdfAiContent
  limitations: PdfAiContent
}
export interface PdfAiResult extends PdfAiContent {
  kind: PdfAction
  revision: string
  literature_id: string
  selected_text: string
  page: number
  crop?: string
  rect?: number[]
  quads?: number[][]
  model_key: string
  content?: PdfAiContent
  modules?: Record<string, ReadingSummary>
  source_language?: string
  target_language?: string
  blocks?: TranslationSentence[]
  latex?: string
  region_id?: string
  visual_kind?: PdfVisualRegionKind
  pages?: { page: number; blocks: TranslationSentence[] }[]
  response_language?: PdfResponseLanguage
}
export interface PdfAiRequest {
  literature_id: string
  attachment_id?: string
  path?: string
  asset_id?: string
  project_id: string
  revision: string
  model_key: string
  kind: PdfAction
  module: string
  page: number
  text: string
  rect?: number[]
  quads?: number[][]
  region_id?: string
  visual_kind?: PdfVisualRegionKind
  client_action_id: string
  client_attempt_id: string
  instruction?: string
  target_language?: TranslationDirection
  response_language: PdfResponseLanguage
}
export interface PdfAiProgress {
  phase: 'segment' | 'synthesis'
  current: number
  total: number
  cached: number
}
export interface PdfAiPreview {
  text?: string
  summary?: ReadingSummary
  pages?: { page: number; blocks: TranslationSentence[] }[]
}
export interface PdfAiTask {
  task_id: string
  status: string
  error?: string
  error_code?: string
  error_detail?: string
  result?: PdfAiResult
  crop?: string
  progress?: PdfAiProgress
  preview?: PdfAiPreview
}
export interface FigurePreview {
  crop: string
  text: string
}
interface FigurePrepared {
  source_id: string
  source_revision: string
  title: string
  page: number
  rect: number[]
  crop: string
}
interface FigureStreamResult extends FigurePrepared {
  task_id: string
  invocation_id: string
  status: string
  output: string
  model_key: string
  error_code: string
  error_detail: string
}
export const PDF_AI_PREFIX = '/api/literature/ai'
const PDF_AI_INVALID_RESPONSE = 'pdf_ai_invalid_response'
const PDF_AI_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const PDF_AI_TASK_STATUSES = new Set(['pending', 'running', 'unknown', ...PDF_AI_TERMINAL_STATUSES])
const PDF_AI_RECOVERY_DELAYS = [1000, 2000, 4000, 8000, 16000, 16000, 16000] as const
const PDF_AI_STREAM_INTERRUPTED = 'pdf_ai_stream_interrupted'
const PDF_AI_RECOVERY_REQUEST_TIMEOUT_MS = 10_000
const PDF_AI_TRANSIENT_HTTP = new Set([502, 503, 504])
const PDF_AI_EVENT_STREAM = 'text/event-stream'
export const pdfAiTaskFinished = (task: PdfAiTask): boolean =>
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
  const responseText = await response.text()
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

export async function subscribePdfAiTask(
  taskId: string,
  signal: AbortSignal,
  onTask: (task: PdfAiTask) => void
): Promise<void> {
  const response = await apiFetch(`${PDF_AI_PREFIX}/tasks/${encodeURIComponent(taskId)}/events`, {
    signal,
  })
  if (
    !response.ok ||
    !response.body ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== PDF_AI_EVENT_STREAM
  ) {
    throw new PdfAiRequestError(
      { code: PDF_AI_INVALID_RESPONSE, diagnostic: `HTTP ${response.status}` },
      response.status
    )
  }
  for await (const data of sseData(response.body)) {
    let task: PdfAiTask
    try {
      task = JSON.parse(data) as PdfAiTask
    } catch {
      throw new PdfAiRequestError({ code: PDF_AI_INVALID_RESPONSE, diagnostic: '' })
    }
    if (!task || task.task_id !== taskId || !PDF_AI_TASK_STATUSES.has(task.status)) {
      throw new PdfAiRequestError({ code: PDF_AI_INVALID_RESPONSE, diagnostic: '' })
    }
    if (signal.aborted) return
    onTask(task)
    if (pdfAiTaskFinished(task) || task.status === 'unknown') return
  }
  if (!signal.aborted)
    throw new PdfAiRequestError({ code: PDF_AI_STREAM_INTERRUPTED, diagnostic: '' })
}

function recoverablePdfTransport(cause: unknown): boolean {
  return (
    cause instanceof TypeError ||
    (cause instanceof DOMException && cause.name === 'TimeoutError') ||
    (cause instanceof PdfAiRequestError &&
      (cause.code === PDF_AI_STREAM_INTERRUPTED ||
        PDF_AI_TRANSIENT_HTTP.has(cause.httpStatus ?? 0)))
  )
}

async function recoveryDelay(delay: number, signal: AbortSignal): Promise<void> {
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

async function queryPdfAiTask(taskId: string, signal: AbortSignal): Promise<PdfAiTask> {
  const task = await pdfAiApi<PdfAiTask>(
    `${PDF_AI_PREFIX}/tasks/${encodeURIComponent(taskId)}`,
    undefined,
    AbortSignal.any([signal, AbortSignal.timeout(PDF_AI_RECOVERY_REQUEST_TIMEOUT_MS)])
  )
  if (!task || task.task_id !== taskId || !PDF_AI_TASK_STATUSES.has(task.status)) {
    throw new PdfAiRequestError({ code: PDF_AI_INVALID_RESPONSE, diagnostic: '' })
  }
  return task
}

export async function recoverPdfAiTask(
  taskId: string,
  signal: AbortSignal,
  onTask: (task: PdfAiTask) => void,
  delays: readonly number[] = PDF_AI_RECOVERY_DELAYS,
  recovery = { attempts: 0, reconnecting: false }
): Promise<void> {
  let observed: PdfAiTask | undefined
  const publish = (task: PdfAiTask): void => {
    observed = task
    if (!signal.aborted && task.status !== 'unknown') onTask(task)
  }
  if (!recovery.reconnecting) {
    try {
      await subscribePdfAiTask(taskId, signal, publish)
      if (signal.aborted || (observed && pdfAiTaskFinished(observed))) return
    } catch (cause) {
      if (signal.aborted) return
      if (!recoverablePdfTransport(cause)) throw cause
    }
    recovery.reconnecting = true
  }
  while (recovery.attempts < delays.length) {
    await recoveryDelay(delays[recovery.attempts++], signal)
    try {
      const task = await queryPdfAiTask(taskId, signal)
      if (signal.aborted) return
      publish(task)
      if (pdfAiTaskFinished(task)) return
      if (task.status === 'unknown') continue
      await subscribePdfAiTask(taskId, signal, publish)
      if (signal.aborted || (observed && pdfAiTaskFinished(observed))) return
    } catch (cause) {
      if (signal.aborted) return
      if (!recoverablePdfTransport(cause)) throw cause
    }
  }
  throw new PdfAiRequestError({ code: PDF_AI_TASK_UNRESOLVED, diagnostic: '' })
}

export async function submitPdfAiTask(
  request: PdfAiRequest,
  signal: AbortSignal,
  delays: readonly number[] = PDF_AI_RECOVERY_DELAYS
): Promise<PdfAiTask> {
  const cancel = (): void => {
    void cancelPdfAiTask(request.client_attempt_id, delays).catch((cause) =>
      console.warn('PDF task cancellation unresolved', cause)
    )
  }
  signal.throwIfAborted()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    return await submitPdfAiAttempt(request, signal, delays)
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function cancelPdfAiTask(
  taskId: string,
  delays: readonly number[] = PDF_AI_RECOVERY_DELAYS
): Promise<void> {
  const signal = new AbortController().signal
  for (const delay of [0, ...delays]) {
    await recoveryDelay(delay, signal)
    try {
      const task = await queryPdfAiTask(taskId, signal)
      if (pdfAiTaskFinished(task)) return
      if (task.status === 'unknown') continue
      const cancelled = await pdfAiApi<PdfAiTask>(
        `${PDF_AI_PREFIX}/tasks/${encodeURIComponent(taskId)}/cancel`,
        {},
        AbortSignal.timeout(PDF_AI_RECOVERY_REQUEST_TIMEOUT_MS)
      )
      if (pdfAiTaskFinished(cancelled)) return
    } catch (cause) {
      if (
        cause instanceof PdfAiRequestError &&
        cause.httpStatus === 404 &&
        cause.code === 'pdf_ai_task_missing'
      )
        continue
      if (!recoverablePdfTransport(cause)) throw cause
    }
  }
  throw new PdfAiRequestError({ code: PDF_AI_TASK_UNRESOLVED, diagnostic: '' })
}

async function submitPdfAiAttempt(
  request: PdfAiRequest,
  signal: AbortSignal,
  delays: readonly number[]
): Promise<PdfAiTask> {
  signal.throwIfAborted()
  try {
    return await pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks`, request)
  } catch (cause) {
    if (!recoverablePdfTransport(cause)) throw cause
  }
  for (const delay of delays) {
    await recoveryDelay(delay, signal)
    try {
      return await queryPdfAiTask(request.client_attempt_id, signal)
    } catch (cause) {
      signal.throwIfAborted()
      if (
        cause instanceof PdfAiRequestError &&
        cause.httpStatus === 404 &&
        cause.code === 'pdf_ai_task_missing'
      ) {
        try {
          return await pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks`, request)
        } catch (retryCause) {
          if (!recoverablePdfTransport(retryCause)) throw retryCause
        }
      } else if (!recoverablePdfTransport(cause)) throw cause
    }
  }
  throw new PdfAiRequestError({ code: PDF_AI_TASK_UNRESOLVED, diagnostic: '' })
}

interface PdfVisualRegionSource {
  literatureId: string
  attachmentId: string
  path: string
  projectId: string
  revision: string
}

function visualRegionPrefix(source: PdfVisualRegionSource): string {
  if (source.literatureId) {
    return `/api/v1/literatures/${encodeURIComponent(source.literatureId)}/attachments/${encodeURIComponent(source.attachmentId)}/regions`
  }
  const query = new URLSearchParams({ path: source.path, project: source.projectId })
  return `/api/workbench/pdf/regions?${query}`
}

export async function loadPdfVisualRegionImage(
  source: PdfVisualRegionSource,
  region: PdfVisualRegion
): Promise<Blob> {
  const prefix = visualRegionPrefix(source)
  const base = prefix.includes('?')
    ? prefix.replace('?', `/${encodeURIComponent(region.region_id)}/image?`)
    : `${prefix}/${encodeURIComponent(region.region_id)}/image`
  const separator = base.includes('?') ? '&' : '?'
  const query = new URLSearchParams({ revision: source.revision, page: String(region.page) })
  for (const coordinate of region.quad) query.append('quad', String(coordinate))
  const response = await apiFetch(`${base}${separator}${query}`)
  if (!response.ok) throw new Error(`pdf_visual_region_image_${response.status}`)
  return await response.blob()
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numericRect(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === 'number')
    ? value
    : null
}

function figurePrepared(value: unknown): FigurePrepared | null {
  const candidate = record(value)
  const rect = numericRect(candidate?.rect)
  return candidate &&
    typeof candidate.source_id === 'string' &&
    typeof candidate.source_revision === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.page === 'number' &&
    typeof candidate.crop === 'string' &&
    rect
    ? ({ ...candidate, rect } as FigurePrepared)
    : null
}

function figureResult(value: unknown): FigureStreamResult | null {
  const prepared = figurePrepared(value)
  const candidate = record(value)
  return prepared &&
    candidate &&
    typeof candidate.task_id === 'string' &&
    typeof candidate.invocation_id === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.output === 'string' &&
    typeof candidate.model_key === 'string' &&
    typeof candidate.error_code === 'string' &&
    typeof candidate.error_detail === 'string'
    ? ({ ...candidate, ...prepared } as FigureStreamResult)
    : null
}

export async function invokeFigure(
  request: PdfAiRequest,
  signal: AbortSignal,
  onPreview: (preview: FigurePreview) => void
): Promise<PdfAiResult> {
  let prepared: FigurePrepared | null = null
  let text = ''
  const result = await postActionStream({
    path: `${PDF_AI_PREFIX}/figure`,
    body: request,
    signal,
    protocolError: 'figure_stream_incomplete',
    parseResult: figureResult,
    onEvent: (event) => {
      if (event.type !== 'prepared') return false
      prepared = figurePrepared(event)
      if (!prepared) return false
      onPreview({ crop: prepared.crop, text })
      return true
    },
    onActivity: (event) => {
      if (event.type === 'output_delta') text += event.text
      else if (event.type === 'output_completed') text = event.text
      if (prepared && (event.type === 'output_delta' || event.type === 'output_completed')) {
        onPreview({ crop: prepared.crop, text })
      }
    },
  })
  if (result.status !== 'completed') throw new Error(result.error_code || 'figure_model_failed')
  return {
    kind: 'figure_explanation',
    revision: result.source_revision,
    literature_id: request.literature_id,
    selected_text: '',
    page: result.page,
    rect: result.rect,
    crop: result.crop,
    model_key: result.model_key,
    text: result.output,
  }
}
