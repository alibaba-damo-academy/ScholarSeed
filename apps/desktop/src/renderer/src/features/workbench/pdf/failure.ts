import type { TFunction } from 'i18next'

export interface PdfAiFailure {
  code?: string
  diagnostic: string
}

export interface PdfAiFailureRecovery {
  configure: boolean
  reselect: boolean
  retry: boolean
}

const MODEL_CONFIGURATION_CODES = new Set([
  'pdf_ai_preparation_failed',
  'pdf_ai_pdf_input_unsupported',
  'pdf_ai_image_input_unsupported',
])

const SELECTION_CORRECTION_CODES = new Set([
  'pdf_ai_selection_unlocated',
  'pdf_ai_selection_too_large',
])

const ERROR_KEYS = {
  pdf_ai_source_invalid: 'reading.errors.source_invalid',
  pdf_ai_selection_unlocated: 'reading.errors.selection_unlocated',
  pdf_ai_selection_too_large: 'reading.errors.selection_too_large',
  pdf_ai_literature_missing: 'reading.errors.literature_missing',
  pdf_ai_document_too_large: 'reading.errors.document_too_large',
  pdf_ai_source_changed: 'reading.errors.source_changed',
  pdf_ai_page_out_of_range: 'reading.errors.page_out_of_range',
  pdf_ai_region_required: 'reading.errors.region_required',
  pdf_ai_region_out_of_range: 'reading.errors.region_out_of_range',
  pdf_ai_region_too_small: 'reading.errors.region_too_small',
  pdf_ai_module_unsupported: 'reading.errors.module_unsupported',
  pdf_ai_result_rejected: 'reading.errors.result_rejected',
  pdf_ai_translation_language_invalid: 'reading.errors.translation_language_invalid',
  pdf_ai_translation_direction_mismatch: 'reading.errors.translation_direction_mismatch',
  pdf_ai_translation_incomplete: 'reading.errors.translation_incomplete',
  pdf_ai_translation_content_missing: 'reading.errors.translation_content_missing',
  pdf_ai_interpretation_incomplete: 'reading.errors.interpretation_incomplete',
  pdf_ai_summary_fields_missing: 'reading.errors.summary_fields_missing',
  pdf_ai_summary_structure_invalid: 'reading.errors.summary_structure_invalid',
  pdf_ai_result_empty: 'reading.errors.result_empty',
  pdf_ai_translation_alignment_missing: 'reading.errors.translation_alignment_missing',
  pdf_ai_translation_sentence_incomplete: 'reading.errors.translation_sentence_incomplete',
  pdf_ai_task_missing: 'reading.errors.task_missing',
  pdf_ai_pdf_input_unsupported: 'reading.errors.pdf_input_unsupported',
  pdf_ai_image_input_unsupported: 'reading.errors.image_input_unsupported',
  pdf_ai_generation_failed: 'reading.errors.generation_failed',
  pdf_ai_literature_deleted: 'reading.errors.literature_deleted',
  pdf_ai_source_changed_during_generation: 'reading.errors.source_changed_during_generation',
  pdf_ai_execution_failed: 'reading.errors.execution_failed',
  pdf_ai_preparation_failed: 'reading.errors.preparation_failed',
  pdf_ai_operation_busy: 'reading.errors.operation_busy',
  pdf_ai_figure_stream_required: 'reading.errors.figure_stream_required',
} as const

/** HTTP details, live tasks and restored tasks retain error identity independently of language. */
export function pdfAiFailure(value: unknown): PdfAiFailure | undefined {
  if (typeof value === 'string') return value ? { diagnostic: value } : undefined
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const code = typeof source.error_code === 'string' && source.error_code
    ? source.error_code : typeof source.code === 'string' ? source.code : ''
  const detail = typeof source.error_detail === 'string' ? source.error_detail
    : typeof source.diagnostic === 'string' ? source.diagnostic
    : typeof source.message === 'string' ? source.message : ''
  const legacy = typeof source.error === 'string' ? source.error : ''
  const diagnostic = detail || (legacy && legacy !== code ? legacy : '')
  return code || diagnostic ? { ...(code ? { code } : {}), diagnostic } : undefined
}

/** Catch boundaries retain legacy String(cause) diagnostics without treating normal empty tasks as errors. */
export function pdfAiCaughtFailure(cause: unknown): PdfAiFailure {
  return pdfAiFailure(cause) ?? { diagnostic: String(cause) }
}

export function pdfAiFailureText(failure: PdfAiFailure, t: TFunction<'pdf'>): string {
  const key = failure.code && Object.prototype.hasOwnProperty.call(ERROR_KEYS, failure.code)
    ? ERROR_KEYS[failure.code as keyof typeof ERROR_KEYS] : undefined
  const message = key ? t(key) : t('reading.failed')
  const detail = [!key && failure.code !== failure.diagnostic ? failure.code : '', failure.diagnostic].filter(Boolean).join('\n')
  return detail ? t('reading.errorDiagnostic', { message, detail }) : message
}

export function pdfAiFailureRecovery(failure?: PdfAiFailure): PdfAiFailureRecovery {
  const code = failure?.code ?? ''
  const reselect = SELECTION_CORRECTION_CODES.has(code)
  return {
    configure: MODEL_CONFIGURATION_CODES.has(code),
    reselect,
    retry: !reselect,
  }
}
