import type { LiteratureTask } from '../../contracts/literature'

const LITERATURE_ERROR_KEYS = {
  COLLECTION_NOT_FOUND: 'panel.error.collectionMissing',
  COLLECTION_PARENT_INVALID: 'panel.error.parentInvalid',
  COLLECTION_CYCLE: 'panel.error.cycle',
  COLLECTION_NAME_REQUIRED: 'panel.error.nameRequired',
  COLLECTION_NAME_EXISTS: 'panel.error.nameExists',
  LITERATURE_SEARCH_FAILED: 'search.loadFailed',
  LITERATURE_SEARCH_STREAM_FAILED: 'search.reconnecting',
  invocation_runtime_unavailable: 'operationError.invocation_runtime_unavailable',
  invocation_workspace_unavailable: 'operationError.invocation_workspace_unavailable',
  invocation_skill_not_found: 'operationError.invocation_skill_not_found',
  invocation_skill_unavailable: 'operationError.invocation_skill_unavailable',
  PDF_UPLOAD_NETWORK_FAILED: 'pdfImport.networkFailed',
  PDF_IMPORT_INVALID_RESPONSE: 'pdfImport.invalidResponse',
  ZOTERO_IMPORT_FAILED: 'importTask.failed',
  UNSUPPORTED_IMPORT_SOURCE: 'importTask.unsupported',
  PDF_FILE_REQUIRED: 'operationError.PDF_FILE_REQUIRED',
  PDF_INVALID: 'operationError.PDF_INVALID',
  PDF_METADATA_MISSING: 'operationError.PDF_METADATA_MISSING',
  PDF_TOO_LARGE: 'operationError.PDF_TOO_LARGE',

  ARXIV_INVALID: 'operationError.ARXIV_INVALID',
  ARXIV_NOT_FOUND: 'operationError.ARXIV_NOT_FOUND',
  ARXIV_DOWNLOAD_FAILED: 'operationError.ARXIV_DOWNLOAD_FAILED',
  ARXIV_TOO_LARGE: 'operationError.ARXIV_TOO_LARGE',
  ARXIV_INVALID_PDF: 'operationError.ARXIV_INVALID_PDF',
  ARXIV_ALREADY_ATTACHED: 'operationError.ARXIV_ALREADY_ATTACHED',

  ZOTERO_UNAVAILABLE: 'operationError.ZOTERO_UNAVAILABLE',
  ZOTERO_LOCAL_API_DISABLED: 'operationError.ZOTERO_LOCAL_API_DISABLED',
  ZOTERO_API_ERROR: 'operationError.ZOTERO_API_ERROR',
  ZOTERO_INVALID_RESPONSE: 'operationError.ZOTERO_INVALID_RESPONSE',
  ZOTERO_RESPONSE_TOO_LARGE: 'operationError.ZOTERO_RESPONSE_TOO_LARGE',
  ZOTERO_INVALID_PDF: 'operationError.ZOTERO_INVALID_PDF',
  ZOTERO_LIBRARY_EMPTY: 'operationError.ZOTERO_LIBRARY_EMPTY',
  ZOTERO_INVALID_SELECTION: 'operationError.ZOTERO_INVALID_SELECTION',
  ZOTERO_LIBRARY_CHANGED: 'operationError.ZOTERO_LIBRARY_CHANGED',
} as const

type OperationFailure = 'search.importFailed' | 'search.loadFailed' | 'search.reconnecting' | 'panel.error.nameRequired' | 'panel.error.createFailed' | 'panel.error.deleteFailed' | 'panel.error.queryRequired' | 'panel.error.searchFailed' | 'importTask.failed' | 'references.collectionsFailed' | 'references.noImportResult' | 'references.addFailed' | 'references.createFailed' | 'detail.loadFailed' | 'detail.saveFailed' | 'detail.fulltextFailed' | 'detail.uploadFailed' | 'detail.deleteAttachmentFailed' |  'batch.loadFailed' | 'batch.bulkFailed' | 'batch.importFailed' | 'batch.bibliographyFailed' | 'batch.deleteFailed' | 'batch.saveFailed' | 'relations.nothingToExport' | 'relations.exportFailed' | 'zotero.connectionFailed' | 'zotero.importFailed' | 'pdfImport.onlyPdf' | 'pdfImport.parseFailed'
export interface LiteratureErrorMessage {
  key: typeof LITERATURE_ERROR_KEYS[keyof typeof LITERATURE_ERROR_KEYS] | OperationFailure | 'panel.error.updateFailed'
  detail?: string
}

/** Translate known product failures; preserve unknown upstream diagnostics verbatim. */
export function literatureErrorMessage(
  code: string | undefined,
  detail: string | undefined,
  fallback: OperationFailure | 'panel.error.updateFailed'
): LiteratureErrorMessage {
  if (code && Object.prototype.hasOwnProperty.call(LITERATURE_ERROR_KEYS, code)) {
    return { key: LITERATURE_ERROR_KEYS[code as keyof typeof LITERATURE_ERROR_KEYS] }
  }
  const diagnostic = code && code !== 'REQUEST_FAILED'
    ? detail && detail !== code ? `${code}: ${detail}` : detail || code
    : detail || undefined
  return { key: fallback, detail: diagnostic }
}

/**
 * AI 检索任务终态错误码 → 可直接展示的用户文案 key。
 *
 * 这些码来自检索任务状态（service/literature/persistence/search.py 写入 state.error，
 * 源头是 service/invocation/service/runtime.py 的 record.error_code），不是 HTTP 失败码，
 * 所以与 LITERATURE_ERROR_KEYS 分开登记；新增一个码就是新增一条数据。
 */
const SEARCH_FAILURE_KEYS = {
  invocation_runtime_failed: 'operationError.invocation_runtime_failed',
} as const

export type SearchFailureKey =
  (typeof SEARCH_FAILURE_KEYS)[keyof typeof SEARCH_FAILURE_KEYS]

/** Resolve a known search failure code; unknown codes keep their raw diagnostic. */
export function searchFailureMessageKey(
  error: string | null | undefined
): SearchFailureKey | undefined {
  if (!error || !Object.prototype.hasOwnProperty.call(SEARCH_FAILURE_KEYS, error))
    return undefined
  return SEARCH_FAILURE_KEYS[error as keyof typeof SEARCH_FAILURE_KEYS]
}

const IMPORT_TASK_STATUS_KEYS = {
  queued: 'importTask.status.queued',
  running: 'importTask.status.running',
  completed: 'importTask.status.completed',
  failed: 'importTask.status.failed',
  cancelled: 'importTask.status.cancelled'
} as const

export function literatureTaskStatusMessage(status: string) {
  return Object.prototype.hasOwnProperty.call(IMPORT_TASK_STATUS_KEYS, status)
    ? IMPORT_TASK_STATUS_KEYS[status as keyof typeof IMPORT_TASK_STATUS_KEYS]
    : 'importTask.status.unknown' as const
}

export function literatureTaskErrorMessage(task: Pick<LiteratureTask, 'error_code' | 'error'>): LiteratureErrorMessage {
  const code = task.error_code || undefined
  return literatureErrorMessage(code, task.error || undefined, 'importTask.failed')
}
