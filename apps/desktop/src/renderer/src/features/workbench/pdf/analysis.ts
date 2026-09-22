import { apiFetch } from '../../../api.ts'
import { postActionStream } from '../../../action.ts'
import { pdfAiFailure, type PdfAiFailure } from './failure.ts'

export type PdfAction = 'document_translation' | 'interpretation' | 'selection_translation' | 'selection_explanation' | 'figure_explanation'
export interface PdfSelection { text: string; page: number; quads: number[][] }
export interface PdfAiContent { text: string; uncertain?: boolean; evidence?: { page: number; quote: string }[] }
export type TranslationDirection = 'auto' | 'zh' | 'en'
export interface TranslationSentence { source_text: string; translated_text: string; located: boolean; paragraph_start?: boolean; heading?: boolean }
export interface ReadingSummary extends PdfAiContent {
  paper_type: string; contribution: PdfAiContent; claims: PdfAiContent[]; method: PdfAiContent; limitations: PdfAiContent
}
export interface PdfAiResult extends PdfAiContent {
  kind: PdfAction; revision: string; literature_id: string; selected_text: string; page: number
  crop?: string; rect?: number[]; quads?: number[][]; model_key: string; content?: PdfAiContent
  modules?: Record<string, ReadingSummary>
  source_language?: string; target_language?: string; blocks?: TranslationSentence[]
  pages?: { page: number; blocks: TranslationSentence[] }[]
}
export interface PdfAiRequest {
  literature_id: string; path?: string; asset_id?: string; project_id: string; revision: string; model_key: string
  kind: PdfAction; module: string; page: number; text: string; rect?: number[]; quads?: number[][]
  client_action_id: string; client_attempt_id: string
  instruction?: string
  target_language?: TranslationDirection
}
export interface PdfAiProgress { phase: 'segment' | 'synthesis'; current: number; total: number; cached: number }
export interface PdfAiTask { task_id: string; status: string; error?: string; error_code?: string; error_detail?: string; result?: PdfAiResult; crop?: string; progress?: PdfAiProgress }
export interface FigurePreview { crop: string; text: string }
interface FigurePrepared {
  source_id: string; source_revision: string; title: string; page: number; rect: number[]; crop: string
}
interface FigureStreamResult extends FigurePrepared {
  task_id: string; invocation_id: string; status: string; output: string; model_key: string
  error_code: string; error_detail: string
}
export const PDF_AI_PREFIX = '/api/literature/ai'
export class PdfAiRequestError extends Error {
  readonly code?: string
  readonly diagnostic: string
  constructor(failure: PdfAiFailure) {
    super(failure.diagnostic || failure.code || '')
    this.code = failure.code
    this.diagnostic = failure.diagnostic
    this.name = 'PdfAiRequestError'
  }
}
export async function pdfAiApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const payload = await response.json()
  if (!response.ok) throw new PdfAiRequestError(pdfAiFailure(payload.detail) ?? { diagnostic: '' })
  return payload as T
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function numericRect(value: unknown): number[] | null {
  return Array.isArray(value) && value.length === 4 && value.every(item => typeof item === 'number')
    ? value
    : null
}

function figurePrepared(value: unknown): FigurePrepared | null {
  const candidate = record(value)
  const rect = numericRect(candidate?.rect)
  return candidate
    && typeof candidate.source_id === 'string'
    && typeof candidate.source_revision === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.page === 'number'
    && typeof candidate.crop === 'string'
    && rect
    ? { ...candidate, rect } as FigurePrepared
    : null
}

function figureResult(value: unknown): FigureStreamResult | null {
  const prepared = figurePrepared(value)
  const candidate = record(value)
  return prepared
    && candidate
    && typeof candidate.task_id === 'string'
    && typeof candidate.invocation_id === 'string'
    && typeof candidate.status === 'string'
    && typeof candidate.output === 'string'
    && typeof candidate.model_key === 'string'
    && typeof candidate.error_code === 'string'
    && typeof candidate.error_detail === 'string'
    ? { ...candidate, ...prepared } as FigureStreamResult
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
    onEvent: event => {
      if (event.type !== 'prepared') return false
      prepared = figurePrepared(event)
      if (!prepared) return false
      onPreview({ crop: prepared.crop, text })
      return true
    },
    onActivity: event => {
      if (event.type === 'output_delta') text += event.text
      else if (event.type === 'output_completed') text = event.text
      if (prepared && (event.type === 'output_delta' || event.type === 'output_completed')) {
        onPreview({ crop: prepared.crop, text })
      }
    }
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
    text: result.output
  }
}
