import { apiFetch } from '../../../api.ts'
import { postActionStream } from '../../../action.ts'
import {
  ASSISTANT_TRANSLATION_TARGETS,
  type AssistantTranslationTarget
} from '../../../contracts/assistant.ts'
import { pdfAiFailure, type PdfAiFailure } from './failure.ts'

export type PdfAction = 'document_translation' | 'interpretation' | 'selection_translation' | 'selection_explanation' | 'figure_explanation' | 'formula_latex'
export type PdfVisualRegionKind = 'formula' | 'figure' | 'table'
export interface PdfVisualRegion {
  region_id: string; kind: PdfVisualRegionKind; reason: string; text_policy: 'retain' | 'exclude'; page: number; quad: number[]
}
export interface PdfVisualRegionManifest {
  schema_version: number; detector_version: string; source_revision: string
  coordinate_space: string; page_count: number; unavailable_pages: number[]
  pages: { page: number; unavailable: boolean; regions: PdfVisualRegion[] }[]
}
export interface PdfSelection { text: string; page: number; quads: number[][] }
export interface PdfAiContent { text: string; uncertain?: boolean; evidence?: { page: number; quote: string }[] }
export const PDF_TRANSLATION_TARGETS = ASSISTANT_TRANSLATION_TARGETS
export type TranslationDirection = AssistantTranslationTarget
export type PdfResponseLanguage = 'zh' | 'en'
export function pdfResponseLanguage(language: string | undefined): PdfResponseLanguage {
  return language?.toLowerCase().startsWith('en') ? 'en' : 'zh'
}
export interface TranslationSentence { source_text: string; translated_text: string; located: boolean; paragraph_start?: boolean; heading?: boolean }
export interface ReadingSummary extends PdfAiContent {
  paper_type: string; contribution: PdfAiContent; claims: PdfAiContent[]; method: PdfAiContent; limitations: PdfAiContent
}
export interface PdfAiResult extends PdfAiContent {
  kind: PdfAction; revision: string; literature_id: string; selected_text: string; page: number
  crop?: string; rect?: number[]; quads?: number[][]; model_key: string; content?: PdfAiContent
  modules?: Record<string, ReadingSummary>
  source_language?: string; target_language?: string; blocks?: TranslationSentence[]
  latex?: string; region_id?: string; visual_kind?: PdfVisualRegionKind
  pages?: { page: number; blocks: TranslationSentence[] }[]
  response_language?: PdfResponseLanguage
}
export interface PdfAiRequest {
  literature_id: string; attachment_id?: string; path?: string; asset_id?: string; project_id: string; revision: string; model_key: string
  kind: PdfAction; module: string; page: number; text: string; rect?: number[]; quads?: number[][]
  region_id?: string; visual_kind?: PdfVisualRegionKind
  client_action_id: string; client_attempt_id: string
  instruction?: string
  target_language?: TranslationDirection
  response_language: PdfResponseLanguage
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

interface PdfVisualRegionSource {
  literatureId: string; attachmentId: string; path: string; projectId: string; revision: string
}

function visualRegionPrefix(source: PdfVisualRegionSource): string {
  if (source.literatureId) {
    return `/api/v1/literatures/${encodeURIComponent(source.literatureId)}/attachments/${encodeURIComponent(source.attachmentId)}/regions`
  }
  const query = new URLSearchParams({ path: source.path, project: source.projectId })
  return `/api/workbench/pdf/regions?${query}`
}

export async function loadPdfVisualRegions(source: PdfVisualRegionSource, startPage: number, endPage: number): Promise<PdfVisualRegionManifest> {
  const separator = visualRegionPrefix(source).includes('?') ? '&' : '?'
  const query = new URLSearchParams({ revision: source.revision, start_page: String(startPage), end_page: String(endPage) })
  const response = await apiFetch(`${visualRegionPrefix(source)}${separator}${query}`)
  if (!response.ok) throw new Error(`pdf_visual_regions_${response.status}`)
  return await response.json() as PdfVisualRegionManifest
}

export async function loadPdfVisualRegionImage(source: PdfVisualRegionSource, region: PdfVisualRegion): Promise<Blob> {
  const prefix = visualRegionPrefix(source)
  const base = prefix.includes('?') ? prefix.replace('?', `/${encodeURIComponent(region.region_id)}/image?`) : `${prefix}/${encodeURIComponent(region.region_id)}/image`
  const separator = base.includes('?') ? '&' : '?'
  const response = await apiFetch(`${base}${separator}${new URLSearchParams({ revision: source.revision, page: String(region.page) })}`)
  if (!response.ok) throw new Error(`pdf_visual_region_image_${response.status}`)
  return await response.blob()
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
