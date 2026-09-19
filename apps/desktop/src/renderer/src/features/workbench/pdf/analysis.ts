import { apiFetch } from '../../../api'
import { pdfAiFailure, type PdfAiFailure } from './failure'

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
