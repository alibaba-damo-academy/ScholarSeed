import type { ApiFailure, ConversationSearchResult, LiteratureCounts, LiteratureDetail, LiteratureFacets, LiteratureNote, LiteraturePage, LiteratureProjects, LiteratureQuery, LiteratureSearchEvent, LiteratureSearchPaper, LiteratureSearchTask, LiteratureSummary, LiteratureTask, LiteratureUpdate } from '../../contracts/literature'
import type { PaperMetaPayload, PaperMetaQuery } from './metadata'
import type { LiteratureCollection, LiteratureItem, LiteratureTag } from './state'

const API_ROOT = '/api/v1'
const FIRST_PAGE = 1
const DEFAULT_PAGE_SIZE = 50
const PDF_UPLOAD_PROGRESS_LIMIT = 90
const LINK_PROJECT_OPERATION = 'link_project'
const REQUEST_FAILED = 'REQUEST_FAILED'
/** serve 代理端点不在 /api/v1 之下, 与 searches 一样自成一个根。 */
const PAPER_META_ROOT = '/api/literature/papermeta'
const PAPER_META_REQUEST_FAILED = 'PAPER_META_REQUEST_FAILED'
export const ZOTERO_LIBRARY_ROOT_KEY = '__library__'
export class LiteratureApiError extends Error {
  constructor(readonly failure: ApiFailure) { super(failure.message) }
}
const base = (): string => window.scholarseed?.getApiBase() ?? ''
const SEARCH_ROOT = '/api/literature/searches'
function url(path: string, query?: LiteratureQuery): string {
  const value = new URL(`${base()}${API_ROOT}${path}`, window.location.href)
  if (query) for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === '' || raw === false) continue
    for (const item of Array.isArray(raw) ? raw : [raw]) value.searchParams.append(key, String(item))
  }
  return value.toString()
}
interface ApiErrorBody {
  detail?: { code?: string; message?: string; fields?: Record<string, string>; request_id?: string } | string
}

/**
 * 把 serve 的错误体折成稳定身份: 结构化 detail 取它的 code/message, 字符串 detail 只当
 * 诊断文本, 缺失或不可解析时只保留 HTTP 状态与兜底 code。
 */
async function apiFailure(response: Response, fallbackCode: string): Promise<LiteratureApiError> {
  const body = await response.json().catch(() => null) as ApiErrorBody | null
  const detail = body?.detail
  const structured = detail !== null && typeof detail === 'object' ? detail : undefined
  return new LiteratureApiError({
    status: response.status,
    code: structured?.code ?? fallbackCode,
    message: structured?.message ?? (typeof detail === 'string' ? detail : ''),
    fields: structured?.fields,
    request_id: structured?.request_id
  })
}

async function request<T>(path: string, init?: RequestInit, query?: LiteratureQuery): Promise<T> {
  const jsonBody = init?.body !== undefined && !(init.body instanceof FormData)
  const response = await fetch(url(path, query), {
    credentials: 'include', ...init,
    headers: { ...(jsonBody ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!response.ok) throw await apiFailure(response, REQUEST_FAILED)
  return response.status === 204 ? undefined as T : await response.json() as T
}

async function searchRequest<T>(path = '', init?: RequestInit): Promise<T> {
  const response = await fetch(`${base()}${SEARCH_ROOT}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null
    const detail = typeof body?.detail === 'string' ? body.detail : ''
    throw new LiteratureApiError({
      status: response.status,
      code: detail || 'LITERATURE_SEARCH_FAILED',
      message: detail
    })
  }
  return response.status === 204 ? undefined as T : await response.json() as T
}

export async function createLiteratureSearch(query: string): Promise<LiteratureSearchTask> {
  const payload = await searchRequest<{ task: LiteratureSearchTask }>('', {
    method: 'POST',
    body: JSON.stringify({ query })
  })
  return payload.task
}

export async function listLiteratureSearches(): Promise<LiteratureSearchTask[]> {
  const payload = await searchRequest<{ items: LiteratureSearchTask[] }>()
  return payload.items
}

export async function deleteLiteratureSearch(id: string): Promise<void> {
  await searchRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

const SSE_FRAME_SEPARATOR = /\r?\n\r?\n/
export async function streamLiteratureSearch(
  id: string,
  afterSeq: number,
  onEvent: (event: LiteratureSearchEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const endpoint = new URL(`${base()}${SEARCH_ROOT}/${encodeURIComponent(id)}/events`, window.location.href)
  endpoint.searchParams.set('after_seq', String(afterSeq))
  const response = await fetch(endpoint, {
    credentials: 'include',
    headers: { Accept: 'text/event-stream' },
    signal
  })
  if (!response.ok || !response.body) throw new LiteratureApiError({
    status: response.status,
    code: 'LITERATURE_SEARCH_STREAM_FAILED',
    message: ''
  })
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  const consume = (frame: string): void => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return
    const event = JSON.parse(data) as LiteratureSearchEvent
    if (Number.isSafeInteger(event.seq) && event.seq > afterSeq) {
      afterSeq = event.seq
      onEvent(event)
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    buffer += value ?? ''
    const frames = buffer.split(SSE_FRAME_SEPARATOR)
    buffer = frames.pop() ?? ''
    frames.forEach(consume)
    if (done) {
      consume(buffer)
      break
    }
  }
}
export const listLiteratures = (query: LiteratureQuery, signal?: AbortSignal): Promise<LiteraturePage> =>
  request('/literatures', { signal }, query)

export async function listAllLiteratures(query: LiteratureQuery, signal?: AbortSignal): Promise<LiteratureSummary[]> {
  const items: LiteratureSummary[] = []
  let current = FIRST_PAGE
  for (;;) {
    signal?.throwIfAborted()
    const result = await listLiteratures({ ...query, page: current, page_size: DEFAULT_PAGE_SIZE }, signal)
    items.push(...result.items)
    if (result.items.length === 0 || items.length >= result.total || !result.next_cursor) return items
    current = result.page + 1
  }
}
export const getLiterature = (id: string, projectId?: string): Promise<LiteratureDetail> =>
  request(`/literatures/${encodeURIComponent(id)}`, undefined, { project_id: projectId })
export const updateLiterature = (id: string, update: LiteratureUpdate, projectId?: string): Promise<LiteratureDetail> =>
  request(`/literatures/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(update) }, { project_id: projectId })
export const fetchArxivFulltext = (id: string): Promise<LiteratureDetail> =>
  request(`/literatures/${encodeURIComponent(id)}/attachments/arxiv`, { method: 'POST' })
export const uploadLiteratureAttachment = (id: string, file: File, primary = false): Promise<unknown> => {
  const body = new FormData()
  body.append('file', file, file.name)
  return request(`/literatures/${encodeURIComponent(id)}/attachments?primary=${String(primary)}`, { method: 'POST', body })
}
export const deleteLiteratureAttachment = (itemId: string, attachmentId: string): Promise<void> =>
  request(`/literatures/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' })
/**
 * 调 serve 的单条元数据代理, 拿到已经归一化好的更新体。
 *
 * 三条腿 (doi.org BibTeX / arXiv BibTeX / OpenAlex 标题检索) 都是匿名公开端点, 不兑换
 * api-key、也不要求登录; `credentials: 'include'` 只为鉴权强制的独立部署带上会话 cookie,
 * 桌面端恒以 `--auth-mode off` 拉起 serve, 不依赖它。失败一律抛 `LiteratureApiError`,
 * 由 `classifyPaperMetaFailure` 区分上游限流、未命中与其余失败。
 */
export async function fetchPaperMeta(query: PaperMetaQuery): Promise<PaperMetaPayload> {
  const response = await fetch(`${base()}${PAPER_META_ROOT}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [query.dimension]: query.value })
  })
  if (!response.ok) throw await apiFailure(response, PAPER_META_REQUEST_FAILED)
  return await response.json() as PaperMetaPayload
}
export interface AttachmentImportOptions {
  project: string
  parent: string
  name: string
  replace_path?: string
  copy_records: boolean
  replace_records: boolean
}
export interface AttachmentImportPreview {
  status: 'preview'
  path: string
  token: string
  conflict: boolean
  suggested_name?: string
  can_replace?: boolean
  source_record_revision?: string | null
  target_record_revision?: string | null
}
export interface AttachmentImportReceipt {
  status: 'completed'
  path: string
  project: string
  records_copied: boolean
}
export const previewAttachmentImport = (
  itemId: string, attachmentId: string, options: AttachmentImportOptions
): Promise<AttachmentImportPreview> => request(
  `/literatures/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}/import-to-project`,
  { method: 'POST', body: JSON.stringify({ ...options, preview: true }) }
)
export const importLiteratureAttachment = (
  itemId: string, attachmentId: string, options: AttachmentImportOptions,
  preview: AttachmentImportPreview, idempotencyKey: string
): Promise<AttachmentImportReceipt> => request(
  `/literatures/${encodeURIComponent(itemId)}/attachments/${encodeURIComponent(attachmentId)}/import-to-project`,
  { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({
    ...options, preview: false, token: preview.token,
    source_record_revision: preview.source_record_revision,
    target_record_revision: preview.target_record_revision
  }) }
)
export const listLiteratureNotes = async (itemId: string): Promise<LiteratureNote[]> => {
  const response = await request<{ items: LiteratureNote[] }>(`/literatures/${encodeURIComponent(itemId)}/notes`)
  return response.items
}
export const addLiteratureNote = (itemId: string, text: string, title = ''): Promise<LiteratureNote> =>
  request(`/literatures/${encodeURIComponent(itemId)}/notes`, { method: 'POST', body: JSON.stringify({ title, text }) })
export const updateLiteratureNote = (
  itemId: string,
  noteId: string,
  update: Pick<LiteratureNote, 'title' | 'text' | 'version'>
): Promise<LiteratureNote> => request(
  `/literatures/${encodeURIComponent(itemId)}/notes/${encodeURIComponent(noteId)}`,
  { method: 'PATCH', body: JSON.stringify(update) }
)
export const deleteLiteratureNote = (itemId: string, noteId: string): Promise<void> =>
  request(`/literatures/${encodeURIComponent(itemId)}/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' })
export const getLiteratureCounts = (projectId?: string): Promise<LiteratureCounts> => request('/literatures/counts', undefined, { project_id: projectId })
export const getLiteratureFacets = (query: LiteratureQuery): Promise<LiteratureFacets> => request('/literatures/facets', undefined, query)
export const getLiteratureProjects = (): Promise<LiteratureProjects> => request('/literatures/projects')
export interface LibraryCollection { id: string; name: string; project_id?: string | null; parent_id?: string | null }
export const listLiteratureCollections = (projectId?: string): Promise<LibraryCollection[]> =>
  request('/collections', undefined, { project_id: projectId })
export const createLiteratureCollection = (
  name: string,
  projectId?: string,
  parentId?: string
): Promise<LibraryCollection> =>
  request('/collections', {
    method: 'POST',
    body: JSON.stringify({
      name,
      project_id: projectId ?? '',
      parent_id: parentId ?? ''
    })
  })
export const createLiteratureTag = (name: string): Promise<void> => request('/tags', { method: 'POST', body: JSON.stringify({ name }) })
export const deleteLiteratureCollection = (id: string, projectId?: string): Promise<void> =>
  request(`/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }, { project_id: projectId })
export const updateLiteratureCollection = (
  id: string, changes: { name?: string; parent_id?: string | null }, projectId?: string
): Promise<LibraryCollection> =>
  request(`/collections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) }, { project_id: projectId })
export const deleteLiteratureTag = (id: string): Promise<void> =>
  request(`/tags/${encodeURIComponent(id)}`, { method: 'DELETE' })
export async function bulkLiteratures(literatureIds: string[], operation: string, parameters: Record<string, unknown> = {}): Promise<{ succeeded: string[]; failed: Array<{ id: string; code: string }> }> {
  return request('/literatures/bulk', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ literature_ids: literatureIds, operation, parameters }) })
}
export async function linkLiteraturesToProject(literatureIds: string[], projectId: string): Promise<{ succeeded: string[]; failed: Array<{ id: string; code: string }> }> {
  return bulkLiteratures(literatureIds, LINK_PROJECT_OPERATION, { project_id: projectId })
}
export async function deleteLiteratures(ids: string[]): Promise<void> {
  await request('/literatures/bulk-delete', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ literature_ids: ids, confirm_referenced: false }) })
}
export interface ZoteroSelectionDirective {
  key: string
  selected: boolean
}
export interface ZoteroCollectionNode {
  key: string
  name: string
  parent_key: string | null
  direct_item_count: number
  subtree_item_count: number
  children: ZoteroCollectionNode[]
}
export interface ZoteroPreview {
  items: number
  pdfs: number
  collections: number
  revision: string
  library: ZoteroCollectionNode
  unfiled: { count: number }
}
export interface ZoteroImportOptions {
  project_id?: string
  /** 导入落点分类; 与 project_id 同作用域, 空串表示落在作用域根部。 */
  collection_id?: string
  selection: ZoteroSelectionDirective[]
  include_unfiled: boolean
  import_collections: boolean
  preview_revision: string
}
/**
 * 受理一次导入任务。
 *
 * `idempotencyKey` 必须由调用方按「一次导入意图」持有并在重试时复用: 每次调用都新
 * 生成一个的话, 连点两下就是两个 key、两次受理, 而文献库是追加语义 —— 结果是两份
 * 条目。缺省仍生成新 key, 供一次性调用方使用。
 */
export async function createImportTask(
  source: string,
  options?: ZoteroImportOptions,
  idempotencyKey: string = crypto.randomUUID()
): Promise<LiteratureTask> {
  return request('/imports', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ source, ...(options ? { options } : {}) })
  })
}
export type PdfImportPhase = 'uploading' | 'parsing'

export async function importPdf(
  file: File,
  onProgress?: (progress: number, phase: PdfImportPhase) => void,
  projectId = '',
  collectionId = ''
): Promise<LiteratureSummary> {
  return new Promise((resolve, reject) => {
    const body = new FormData()
    body.append('file', file, file.name)
    const xhr = new XMLHttpRequest()
    // 落点跟着左侧当前选择走: 项目与分类成对交出, 空值由 url() 自己省掉。
    xhr.open('POST', url('/imports/pdf', { project_id: projectId, collection_id: collectionId ? [collectionId] : undefined }))
    xhr.withCredentials = true
    xhr.setRequestHeader('Idempotency-Key', crypto.randomUUID())
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(
          Math.min(
            PDF_UPLOAD_PROGRESS_LIMIT,
            Math.round((event.loaded / event.total) * PDF_UPLOAD_PROGRESS_LIMIT)
          ),
          'uploading'
        )
      }
    }
    xhr.upload.onload = () => onProgress?.(PDF_UPLOAD_PROGRESS_LIMIT, 'parsing')
    xhr.onerror = () => reject(new LiteratureApiError({ status: xhr.status, code: 'PDF_UPLOAD_NETWORK_FAILED', message: '' }))
    xhr.onload = () => {
      const payload = (() => {
        try { return JSON.parse(xhr.responseText) as LiteratureSummary & { detail?: { code?: string; message?: string; fields?: Record<string, string>; request_id?: string } | string } }
        catch { return null }
      })()
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail = payload?.detail
        reject(new LiteratureApiError({
          status: xhr.status,
          code: typeof detail === 'object' && detail ? detail.code ?? 'REQUEST_FAILED' : 'REQUEST_FAILED',
          message: typeof detail === 'object' && detail ? detail.message ?? '' : detail ?? '',
          fields: typeof detail === 'object' && detail ? detail.fields : undefined,
          request_id: typeof detail === 'object' && detail ? detail.request_id : undefined
        }))
        return
      }
      if (!payload?.id || typeof payload.title !== 'string') {
        reject(new LiteratureApiError({ status: xhr.status, code: 'PDF_IMPORT_INVALID_RESPONSE', message: '' }))
        return
      }
      onProgress?.(100, 'parsing')
      resolve(payload)
    }
    onProgress?.(0, 'uploading')
    xhr.send(body)
  })
}
export interface BibliographyResult {
  items: LiteraturePage['items']
  count: number
}

/** 追加式入库：服务端不判重，同一份文件导入两次就是两批新文献（proposal 91）。 */
export async function importBibliography(files: File[], options: { collectionId?: string; projectId?: string } = {}): Promise<BibliographyResult> {
  const body = new FormData()
  for (const file of files) body.append('files', file, file.name)
  const query = new URLSearchParams()
  if (options.collectionId) query.set('collection_id', options.collectionId)
  if (options.projectId) query.set('project_id', options.projectId)
  return request(`/imports/bibliography?${query}`, { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body })
}
export const previewZotero = (): Promise<ZoteroPreview> => request('/imports/zotero/preview')
export const getLiteratureTask = (id: string): Promise<LiteratureTask> => request(`/tasks/${encodeURIComponent(id)}`)

/* Compatibility surface for the immutable root store. The new page does not use it. */
export type ImportSourceKind = 'local' | 'zotero' | 'doi' | 'resource'
export interface LiteratureMutation {
  ok: boolean
  error?: string
  bibtex?: string
  count?: number
  added?: number
  skipped?: number
}
export type { LiteratureQuery }
export interface LiteratureView {
  items: LiteratureItem[]
  total: number
  recentTotal: number
  collections: LiteratureCollection[]
  tags: LiteratureTag[]
  years: number[]
  fulltextCounts: Record<string, number>
}
function legacyItem(item: import('../../contracts/literature').LiteratureSummary): LiteratureItem {
  return {
    id: item.id, pubtype: 'misc', title: item.title, authors: item.creators_display,
    journal: item.publication_display, venue: item.publication_display, url: '', year: item.year,
    pages: '', volume: '', arxiv: '', publisher: '', address: '', tags: item.tags.map((tag) => tag.name),
    fulltext: item.primary_attachment ? 'ready' : 'none', collection: item.collections[0]?.name ?? '',
    added_at: Date.parse(item.created_at), hasPdf: item.primary_attachment?.kind === 'pdf',
  }
}
export async function fetchLiterature(query: Record<string, unknown>, project?: string | null): Promise<LiteratureView | null> {
  try {
    const page = await listLiteratures({ q: typeof query.search === 'string' ? query.search : undefined, project_id: project ?? undefined, page_size: DEFAULT_PAGE_SIZE })
    return { items: page.items.map(legacyItem), total: page.total, recentTotal: 0, collections: [], tags: [], years: [], fulltextCounts: {} }
  } catch { return null }
}
export async function batchLiterature(operation: string, ids: string[], value = '', project?: string | null, collection = ''): Promise<LiteratureMutation> {
  try { await bulkLiteratures(ids, operation, { value, project_id: project, collection }); return { ok: true } }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'request_failed' } }
}
export async function exportBibtex(ids: string[], project?: string | null): Promise<LiteratureMutation> {
  try {
    const result = await request<{ bibtex?: string; count?: number }>('/exports', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ literature_ids: ids, project_id: project, format: 'bibtex' }) })
    return { ok: true, ...result }
  }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'request_failed' } }
}
export async function fetchFulltext(id: string, project?: string | null): Promise<LiteratureMutation> { return batchLiterature('fetch_fulltext', [id], '', project) }
export async function importLiterature(source: ImportSourceKind, paths: string[] = [], project?: string | null): Promise<LiteratureMutation> {
  try { await createImportTask(source); return { ok: true, added: paths.length } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'request_failed' } }
}
export async function markFulltext(id: string, status: string, project?: string | null): Promise<LiteratureMutation> { return batchLiterature('mark_fulltext', [id], status, project) }
export async function mutateCollection(operation: string, name: string, project?: string | null, options: { target?: string; parent?: string } = {}): Promise<LiteratureMutation> { return batchLiterature(operation, [], name, project, options.target ?? options.parent ?? '') }
export async function mutateNote(literatureId: string, operation: string, options: { text?: string; noteId?: string } = {}, project?: string | null): Promise<LiteratureMutation> { return batchLiterature(operation, [literatureId], options.text ?? '', project, options.noteId ?? '') }


const RESULT_STATUS_BATCH = 20
interface ResultLibraryStatus { library: 'matched' | 'absent' | 'ambiguous' | 'unavailable' }

/** Load the saved result; library lookup failure must never discard retrieved papers. */
export async function loadConversationSearch(session: string, card: string, signal: AbortSignal, projectId?: string): Promise<{
  result: ConversationSearchResult; saved: string[]; warning: boolean
}> {
  const endpoint = `${base()}/api/sessions/${encodeURIComponent(session)}/literature`
  const response = await fetch(`${endpoint}/results/${encodeURIComponent(card)}`, { credentials: 'include', signal })
  if (!response.ok) throw new Error('literature_result_unavailable')
  const result = await response.json() as ConversationSearchResult
  if (result.session_id !== session || !Array.isArray(result.papers)) throw new Error('literature_result_invalid')
  const saved: string[] = []
  let warning = false
  for (let start = 0; start < result.papers.length; start += RESULT_STATUS_BATCH) {
    const papers = result.papers.slice(start, start + RESULT_STATUS_BATCH)
    try {
      const response = await fetch(`${endpoint}/result-status`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ project_id: projectId ?? '', papers: papers.map(({ id, title, doi, year }) => ({ id, title, doi, year })) })
      })
      if (!response.ok) throw new Error('literature_status_unavailable')
      const status = await response.json() as { items: Record<string, ResultLibraryStatus> }
      for (const paper of papers) {
        const item = status.items?.[paper.id]
        if (item?.library === 'matched') saved.push(paper.id)
        else if (item?.library !== 'absent') warning = true
      }
    } catch (error) {
      if (signal.aborted) throw error
      warning = true
    }
  }
  return { result, saved, warning }
}

/** Resolve which search papers already exist in the literature library; best effort. */
export async function loadSearchLibraryStatus(papers: readonly LiteratureSearchPaper[], projectId?: string): Promise<string[]> {
  const saved: string[] = []
  for (let start = 0; start < papers.length; start += RESULT_STATUS_BATCH) {
    const batch = papers.slice(start, start + RESULT_STATUS_BATCH)
    try {
      const payload = await searchRequest<{ items: Record<string, ResultLibraryStatus> }>('/result-status', {
        method: 'POST',
        body: JSON.stringify({ project_id: projectId ?? '', papers: batch.map(({ paper_id, title, doi, year }) => ({ id: paper_id, title, doi, year })) })
      })
      for (const paper of batch) {
        if (payload.items?.[paper.paper_id]?.library === 'matched') saved.push(paper.paper_id)
      }
    } catch {
      break
    }
  }
  return saved
}
