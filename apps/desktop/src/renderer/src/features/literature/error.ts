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
  key: typeof LITERATURE_ERROR_KEYS[keyof typeof LITERATURE_ERROR_KEYS] | OperationFailure | FulltextFailureKey | 'panel.error.updateFailed'
  detail?: string
}

/** Translate known failures and use the operation fallback for unknown diagnostics. */
export function literatureErrorMessage(
  code: string | undefined,
  _detail: string | undefined,
  fallback: OperationFailure | 'panel.error.updateFailed'
): LiteratureErrorMessage {
  if (code && Object.prototype.hasOwnProperty.call(LITERATURE_ERROR_KEYS, code)) {
    return { key: LITERATURE_ERROR_KEYS[code as keyof typeof LITERATURE_ERROR_KEYS] }
  }
  return { key: fallback, detail: undefined }
}

/**
 * 「获取全文」只允许三种结果, 文案固定 (产品口径):
 * 未找到全文 / Not found、无法访问 / Unable to access、请求被限流 / Rate limited。
 *
 * serve 侧两条腿 (arXiv / DOI) 共用 `service/literature/service/outcome.py` 的三个码, 所以
 * 这里只认这三个。任何未知码 —— 前置校验失败 (标识无效/缺标识)、渲染层自己的网络错误、
 * 以后新增的服务端码 —— 一律落到「未找到全文」: 宁可少说, 也不能把原始 code 或服务端中文
 * 诊断直接甩给用户, 否则这条链路的报错就不止三种了。
 */
const FULLTEXT_FAILURE_KEYS = {
  FULLTEXT_NO_ACCESS: 'detail.fulltextNoAccess',
  FULLTEXT_RATE_LIMITED: 'detail.fulltextRateLimited'
} as const

export const FULLTEXT_NOT_FOUND_KEY = 'detail.fulltextNotFound'

export type FulltextFailureKey =
  | typeof FULLTEXT_NOT_FOUND_KEY
  | (typeof FULLTEXT_FAILURE_KEYS)[keyof typeof FULLTEXT_FAILURE_KEYS]

/** Map a full-text failure code onto the only three messages this UI may show. */
export function fulltextFailureMessageKey(code: string | null | undefined): FulltextFailureKey {
  if (code && Object.prototype.hasOwnProperty.call(FULLTEXT_FAILURE_KEYS, code))
    return FULLTEXT_FAILURE_KEYS[code as keyof typeof FULLTEXT_FAILURE_KEYS]
  return FULLTEXT_NOT_FOUND_KEY
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
