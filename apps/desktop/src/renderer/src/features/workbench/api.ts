import { loadBuiltinDocument, type BuiltinDocumentSource } from './builtin.ts'
import type { CitationResolution } from '../../contracts/citations'
import type {
  DocumentCapabilities,
  LiteratureDocumentSource,
  OpenDocumentResult,
  PdfCommentRecord,
  PdfMarkRecord,
  PdfNoteRecord,
  PdfRecordSnapshot,
  PdfRecords,
  RecordOwner,
  RecordTarget
} from '../../contracts/workbench'
import { fetchVersionCapability, type ResourceCapability } from '../../contracts/resources.ts'
import type { PdfMarkColor } from './pdf/records'

export interface ProjectDocumentSource {
  kind: 'project'
  path: string
  project?: string | null
  assetId?: string | null
}

export interface SessionFileSource {
  projectScope?: string
  citation?: { answerId: string; answerRevision: string; handle: string }
  recordTarget?: RecordTarget
  kind: 'session-file'
  sessionId: string
  path: string
  revision?: string
  mediaType?: string
  renderKind?: string
}

export interface SessionArtifactSource {
  kind: 'session-artifact'
  sessionId: string
  artifactId: string
  path: string
  revision?: string
  mediaType?: string
  renderKind?: string
}

export interface RuntimeFileSource {
  kind: 'runtime-file'
  path: string
  revision?: string
  mediaType?: string
  renderKind?: string
}

export interface VersionDocumentSource {
  kind: 'version'
  project: string
  versionId: string
  path: string
  revision: string
  mediaType?: string
  renderKind?: string
}

export interface ReviewBaselineSource {
  kind: 'review-base'
  project: string
  fileId: string
  reviewId: string
  path: string
  revision: string
  mediaType?: string
  renderKind?: string
}

export type DocumentSource =
  | BuiltinDocumentSource
  | ProjectDocumentSource
  | LiteratureDocumentSource
  | SessionFileSource
  | SessionArtifactSource
  | RuntimeFileSource
  | VersionDocumentSource
  | ReviewBaselineSource

export type LocatedDocumentSource = ProjectDocumentSource | LiteratureDocumentSource

export function isLocatedDocumentSource(
  source: DocumentSource
): source is LocatedDocumentSource {
  return source.kind === 'project' || source.kind === 'literature'
}

const PATH_AUTHORIZATION_FAILED = 'desktop_path_authorization_failed'

export async function resolveDocumentLocation(
  source: LocatedDocumentSource
): Promise<{ ok: boolean; error?: string; absolute?: string }> {
  try {
    const literature = source.kind === 'literature'
    const response = await fetch(literature
      ? `${base()}/api/v1/literatures/${encodeURIComponent(source.literatureId)}/attachments/${encodeURIComponent(source.attachmentId)}/location`
      : `${base()}/api/resource/reveal`, literature ? {
        credentials: 'include'
      } : {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: source.path, project: source.project ?? null })
      })
    const payload = await response.json().catch(() => null) as
      | { detail?: string | { code?: string }; absolute?: string }
      | null
    const detail = typeof payload?.detail === 'string'
      ? payload.detail
      : payload?.detail?.code
    if (!response.ok) return { ok: false, error: detail ?? `http_${response.status}` }
    const absolute = payload?.absolute
    if (literature && absolute && window.scholarseed?.addAuthorizedRoot) {
      const authorized = await window.scholarseed.addAuthorizedRoot('external', absolute)
      if (!authorized) return { ok: false, error: PATH_AUTHORIZATION_FAILED }
    }
    return { ok: true, absolute }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'network_error' }
  }
}

export interface LoadedDocument {
  documentId: string
  source: DocumentSource
  viewer: OpenDocumentResult['viewer']
  processor: OpenDocumentResult['processor']
  capabilities: DocumentCapabilities
  revision: string
  mediaType: string
  contentKind?: OpenDocumentResult['content_kind']
  bytes: Uint8Array
  versioning?: ResourceCapability | null
  externalChange?: boolean
}

interface LiteratureAttachmentProjection {
  viewer: OpenDocumentResult['viewer']
  processor: OpenDocumentResult['processor']
  content_kind: OpenDocumentResult['content_kind']
  capabilities: DocumentCapabilities
  media_type: string
  size: number
  revision: string
}

export const DOCUMENT_LOAD_FAILURE_KIND = 'document-load-failure' as const
const NETWORK_ERROR_CODE = 'document_network_error'
const HTTP_ERROR_CODE = 'document_http_error'
const NOT_FOUND_STATUS = 404
const REQUEST_TIMEOUT_STATUS = 408
const TOO_EARLY_STATUS = 425
const TOO_MANY_REQUESTS_STATUS = 429
const SERVER_ERROR_STATUS = 500
const ARTIFACT_EDITABLE_HEADER = 'x-scholarseed-artifact-editable'

export interface DocumentLoadFailure {
  kind: typeof DOCUMENT_LOAD_FAILURE_KIND
  code: string
  message: string
  retryable: boolean
  status: number | null
}

export type DocumentLoadResult = LoadedDocument | DocumentLoadFailure

export function isDocumentLoadFailure(
  result: DocumentLoadResult
): result is DocumentLoadFailure {
  return 'kind' in result && result.kind === DOCUMENT_LOAD_FAILURE_KIND
}

export function isMissingDocumentFailure(failure: DocumentLoadFailure): boolean {
  return failure.status === NOT_FOUND_STATUS
}

export type CommitResult =
  | { ok: true; revision: string }
  | { ok: false; error: 'conflict' | 'unavailable' | 'failed' }

export type ManagedCopyResult =
  | { ok: true; project: string; path: string; revision: string }
  | { ok: false; error: 'unavailable' | 'failed' }

export type PdfMark = Omit<PdfMarkRecord, 'color'> & { color: PdfMarkColor }
export type PdfComment = PdfCommentRecord

export interface PdfNoteExcerpt {
  id: string
  mark_id: string
  text: string
  page: number
}

export type PdfNote = Omit<PdfNoteRecord, 'excerpts'> & { excerpts: PdfNoteExcerpt[] }
export type { PdfRecordSnapshot, PdfRecords, RecordTarget }

const base = (): string => window.scholarseed?.getApiBase() ?? ''
const READ_ONLY_CAPABILITIES: DocumentCapabilities = {
  can_preview: true,
  can_edit: false,
  can_select: false,
  can_annotate: false,
  can_save: false,
  can_version: false,
  can_diff: false,
  pending: []
}
const EDITABLE_ARTIFACT_CAPABILITIES: DocumentCapabilities = {
  ...READ_ONLY_CAPABILITIES,
  can_edit: true,
  can_save: true
}

function paramsFor(source: ProjectDocumentSource): URLSearchParams {
  const params = new URLSearchParams({ path: source.path })
  if (source.project) params.set('project', source.project)
  return params
}

function rawUrl(source: Exclude<DocumentSource, ProjectDocumentSource>): string {
  if (source.kind === 'literature') return `/api/v1/literatures/${encodeURIComponent(source.literatureId)}/attachments/${encodeURIComponent(source.attachmentId)}/content`
  if (source.kind === 'review-base') {
    const params = new URLSearchParams({ project: source.project })
    return `/api/resource/files/${encodeURIComponent(source.fileId)}/review/${encodeURIComponent(source.reviewId)}/base?${params.toString()}`
  }
  if (source.kind === 'version') {
    const params = new URLSearchParams({ project: source.project })
    return `/api/resource/versions/${encodeURIComponent(source.versionId)}/content?${params.toString()}`
  }
  if (source.kind === 'session-artifact') {
    return `/api/serve/sessions/${encodeURIComponent(source.sessionId)}/artifacts/${encodeURIComponent(source.artifactId)}/raw`
  }
  if (source.kind === 'session-file') {
    if (source.citation) return `/api/assistant/sessions/${encodeURIComponent(source.sessionId)}/answers/${encodeURIComponent(source.citation.answerId)}/citations/${encodeURIComponent(source.citation.handle)}/raw?answer_revision=${encodeURIComponent(source.citation.answerRevision)}`
    return `/api/serve/sessions/${encodeURIComponent(source.sessionId)}/files/raw?path=${encodeURIComponent(source.path)}`
  }
  return `/api/research/workspace/file/raw?path=${encodeURIComponent(source.path)}`
}

function literatureOpenUrl(source: LiteratureDocumentSource): string {
  return `/api/v1/literatures/${encodeURIComponent(source.literatureId)}/attachments/${encodeURIComponent(source.attachmentId)}/open`
}

export function viewerFromProjection(source: Exclude<DocumentSource, ProjectDocumentSource>): OpenDocumentResult['viewer'] {
  const kind = source.renderKind
  const mediaType = (source.mediaType ?? '').split(';', 1)[0].trim().toLocaleLowerCase()
  if (kind === 'markdown' || mediaType === 'text/markdown' || mediaType === 'text/x-markdown') return 'markdown'
  if (kind === 'image' || mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf') return 'pdf'
  if (mediaType.includes('wordprocessingml')) return 'office'
  if (mediaType.includes('spreadsheetml') || mediaType === 'text/csv') return 'spreadsheet'
  if (mediaType.includes('presentationml')) return 'office'
  if (kind === 'code' || kind === 'json' || kind === 'html' || kind === 'text') return 'code'
  if (mediaType.startsWith('text/') || mediaType === 'application/json') return 'code'
  return 'unsupported'
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes)
  const hashed = await crypto.subtle.digest('SHA-256', copy.buffer)
  return `sha256:${Array.from(new Uint8Array(hashed), (value) => value.toString(16).padStart(2, '0')).join('')}`
}

export async function digestText(text: string): Promise<string> {
  return digest(new TextEncoder().encode(text))
}

export function documentIdFor(source: DocumentSource): string {
  if (source.kind === 'builtin') return `builtin:${source.id}`
  if (source.kind === 'literature') return `literature:${source.literatureId}:attachment:${source.attachmentId}`
  if (source.kind === 'project') return source.assetId
    ? `project:${source.project ?? 'current'}:asset:${source.assetId}`
    : `project:${source.project ?? 'current'}:${source.path}`
  if (source.kind === 'session-artifact') return `artifact:${source.sessionId}:${source.artifactId}`
  if (source.kind === 'session-file') return `session:${source.sessionId}:${source.path}`
  if (source.kind === 'version') return `version:${source.project}:${source.versionId}`
  if (source.kind === 'review-base') return `review-base:${source.project}:${source.fileId}:${source.reviewId}:${source.revision}`
  return `runtime:${source.path}`
}

export async function loadVersionCapability(
  source: DocumentSource
): Promise<ResourceCapability | null> {
  if (source.kind !== 'project') return null
  return fetchVersionCapability(source.project ?? 'current', source.path)
}

function statusRetryable(status: number): boolean {
  return status === REQUEST_TIMEOUT_STATUS
    || status === TOO_EARLY_STATUS
    || status === TOO_MANY_REQUESTS_STATUS
    || status >= SERVER_ERROR_STATUS
}

async function responseFailure(response: Response): Promise<DocumentLoadFailure> {
  let code = HTTP_ERROR_CODE
  let message = `${HTTP_ERROR_CODE}:${response.status}`
  let retryable = statusRetryable(response.status)
  try {
    const payload = await response.json() as {
      detail?: string | { code?: string; message?: string; retryable?: boolean }
    }
    if (typeof payload.detail === 'string' && payload.detail) {
      code = payload.detail
      message = payload.detail
    } else if (payload.detail && typeof payload.detail === 'object') {
      code = payload.detail.code || code
      message = payload.detail.message || code
      retryable = payload.detail.retryable ?? retryable
    }
  } catch {
    // Preserve the stable HTTP fallback when an upstream returns a non-JSON body.
  }
  return {
    kind: DOCUMENT_LOAD_FAILURE_KIND,
    code,
    message,
    retryable,
    status: response.status
  }
}

export async function loadDocument(source: DocumentSource): Promise<DocumentLoadResult> {
  try {
    if (source.kind === 'builtin') return await loadBuiltinDocument(source)
    if (source.kind === 'project') {
      const params = paramsFor(source)
      const opened = await fetch(`${base()}/api/workbench/open?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store'
      })
      if (!opened.ok) return responseFailure(opened)
      const projection = (await opened.json()) as OpenDocumentResult
      let bytes = new Uint8Array()
      if (projection.viewer !== 'unsupported') {
        if (projection.viewer === 'spreadsheet' && !projection.capabilities.can_edit) {
          params.set('preview', 'true')
        }
        const content = await fetch(`${base()}/api/workbench/content?${params.toString()}`, {
          credentials: 'include',
          cache: 'no-store'
        })
        if (!content.ok) return responseFailure(content)
        bytes = new Uint8Array(await content.arrayBuffer())
      }
      const resolvedSource = {
        ...source,
        project: projection.project_id,
        assetId: projection.asset_id,
        recordTarget: projection.asset_id ? {
          owner: 'project_asset' as const,
          scope_id: projection.project_id,
          subject_id: projection.asset_id
        } : undefined
      }
      const versionState = projection.versioning
      return {
        documentId: documentIdFor(resolvedSource),
        source: resolvedSource,
        viewer: projection.viewer,
        processor: projection.processor,
        capabilities: projection.capabilities,
        revision: projection.revision,
        mediaType: projection.media_type,
        contentKind: projection.content_kind,
        bytes,
        versioning: versionState ?? undefined,
        externalChange: Boolean(versionState?.drifted)
      }
    }
    if (source.kind === 'literature') {
      const opened = await fetch(`${base()}${literatureOpenUrl(source)}`, {
        credentials: 'include',
        cache: 'no-store'
      })
      if (!opened.ok) return responseFailure(opened)
      const projection = await opened.json() as LiteratureAttachmentProjection
      let bytes = new Uint8Array()
      if (projection.capabilities.can_preview) {
        const preview = projection.viewer === 'spreadsheet' && !projection.capabilities.can_edit
          ? '?preview=true'
          : ''
        const content = await fetch(`${base()}${rawUrl(source)}${preview}`, {
          credentials: 'include',
          cache: 'no-store'
        })
        if (!content.ok) return responseFailure(content)
        bytes = new Uint8Array(await content.arrayBuffer())
      }
      const resolvedSource = {
        ...source,
        revision: projection.revision,
        mediaType: projection.media_type
      }
      return {
        documentId: documentIdFor(source),
        source: resolvedSource,
        viewer: projection.viewer,
        processor: projection.processor,
        capabilities: projection.capabilities,
        revision: projection.revision,
        mediaType: projection.media_type,
        contentKind: projection.content_kind,
        bytes,
        versioning: null
      }
    }
    const response = await fetch(`${base()}${rawUrl(source)}`, { credentials: 'include' })
    if (!response.ok) return responseFailure(response)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const mediaType = response.headers.get('content-type') || source.mediaType || 'application/octet-stream'
    const viewer = viewerFromProjection({ ...source, mediaType })
    const artifactEditable = source.kind === 'session-artifact'
      && response.headers.get(ARTIFACT_EDITABLE_HEADER) === 'true'
    return {
      documentId: documentIdFor(source),
      source,
      viewer,
      processor: null,
      capabilities: artifactEditable
        ? EDITABLE_ARTIFACT_CAPABILITIES
        : recordTargetFor(source)
        ? { ...READ_ONLY_CAPABILITIES, can_select: viewer === 'pdf', can_annotate: viewer === 'pdf' }
        : READ_ONLY_CAPABILITIES,
      revision: artifactEditable ? await digest(bytes) : source.revision || await digest(bytes),
      mediaType,
      contentKind: viewer === 'code' ? 'text' : 'binary',
      bytes,
      versioning: null
    }
  } catch (error) {
    return {
      kind: DOCUMENT_LOAD_FAILURE_KIND,
      code: NETWORK_ERROR_CODE,
      message: error instanceof Error ? error.message : NETWORK_ERROR_CODE,
      retryable: true,
      status: null
    }
  }
}

export async function commitDocument(
  source: DocumentSource,
  bytes: Uint8Array,
  revision: string
): Promise<CommitResult> {
  if (source.kind !== 'project' && source.kind !== 'literature' && source.kind !== 'session-artifact') {
    return { ok: false, error: 'unavailable' }
  }
  try {
    const target = source.kind === 'project'
      ? `/api/workbench/content?${paramsFor(source).toString()}`
      : rawUrl(source)
    const response = await fetch(`${base()}${target}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'If-Match': `"${revision}"`
      },
      body: new Uint8Array(bytes)
    })
    if (response.status === 412) return { ok: false, error: 'conflict' }
    if (!response.ok) return { ok: false, error: 'failed' }
    const next = response.headers.get('etag')?.replace(/^"|"$/g, '')
    return next ? { ok: true, revision: next } : { ok: false, error: 'failed' }
  } catch {
    return { ok: false, error: 'failed' }
  }
}

export async function createManagedCopy(
  source: DocumentSource,
  bytes: Uint8Array,
  name: string
): Promise<ManagedCopyResult> {
  if (source.kind !== 'project') return { ok: false, error: 'unavailable' }
  try {
    const params = new URLSearchParams({ project: source.project ?? 'current', name })
    const response = await fetch(`${base()}/api/workbench/managed-copy?${params.toString()}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: new Uint8Array(bytes)
    })
    if (!response.ok) return { ok: false, error: 'failed' }
    const payload = await response.json() as { project?: string; path?: string; revision?: string }
    return payload.project && payload.path && payload.revision
      ? { ok: true, project: payload.project, path: payload.path, revision: payload.revision }
      : { ok: false, error: 'failed' }
  } catch {
    return { ok: false, error: 'failed' }
  }
}

const PDF_RECORD_REFRESH_MS = 2_000
const PDF_RECORD_FOCUS_EVENT = 'focus'
const pdfRecordSubscribers = new Map<string, Set<(records: PdfRecordSnapshot) => void>>()
const pdfRecordSnapshots = new Map<string, PdfRecordSnapshot>()
let pdfRecordSaveGeneration = 0

function recordIdentity(target: RecordTarget): string {
  return JSON.stringify([target.owner, target.scope_id, target.subject_id])
}

function publishPdfRecords(snapshot: PdfRecordSnapshot): void {
  const canonical = recordIdentity(snapshot.record_target)
  for (const [document, listeners] of pdfRecordSubscribers) {
    const current = pdfRecordSnapshots.get(document)
    if (!current || recordIdentity(current.record_target) !== canonical) continue
    pdfRecordSnapshots.set(document, snapshot)
    for (const listener of listeners) listener(snapshot)
  }
}

export function subscribePdfRecords(source: DocumentSource, listener: (records: PdfRecordSnapshot) => void): () => void {
  const key = documentIdFor(source)
  const subscribers = pdfRecordSubscribers.get(key) ?? new Set()
  subscribers.add(listener)
  pdfRecordSubscribers.set(key, subscribers)
  let active = true
  let refreshing = false
  const refresh = async (): Promise<void> => {
    if (!active || refreshing) return
    refreshing = true
    const previous = pdfRecordSnapshots.get(key)
    const generation = pdfRecordSaveGeneration
    try {
      const current = await loadPdfRecords(source)
      if (active && generation === pdfRecordSaveGeneration && current &&
        (current.record_revision !== previous?.record_revision || current.source_revision !== previous?.source_revision)) publishPdfRecords(current)
    } finally { refreshing = false }
  }
  const timer = setInterval(() => { void refresh() }, PDF_RECORD_REFRESH_MS)
  const focused = (): void => { void refresh() }
  window.addEventListener?.(PDF_RECORD_FOCUS_EVENT, focused)
  return () => {
    active = false
    clearInterval(timer)
    window.removeEventListener?.(PDF_RECORD_FOCUS_EVENT, focused)
    subscribers.delete(listener)
    if (!subscribers.size) {
      pdfRecordSubscribers.delete(key)
      pdfRecordSnapshots.delete(key)
    }
  }
}

export async function loadPdfRecords(
  source: DocumentSource
): Promise<PdfRecordSnapshot | null> {
  const target = recordTargetFor(source)
  if (!target) return null
  try {
    const generation = pdfRecordSaveGeneration
    const response = await fetch(`${base()}${recordEndpoint(target, source)}`, { credentials: 'include' })
    if (!response.ok) return null
    const snapshot = await response.json() as PdfRecordSnapshot
    if (generation === pdfRecordSaveGeneration) pdfRecordSnapshots.set(documentIdFor(source), snapshot)
    return snapshot
  } catch {
    return null
  }
}

export async function commitPdfRecords(
  source: DocumentSource,
  records: PdfRecords,
  recordRevision: string,
  sourceRevision: string
): Promise<PdfRecordSnapshot | 'conflict' | null> {
  const target = recordTargetFor(source)
  if (!target) return null
  try {
    const response = await fetch(`${base()}${recordEndpoint(target, source)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${recordRevision}"` },
        body: JSON.stringify({ records, expected_source_revision: sourceRevision })
      })
    if (response.status === 412) return 'conflict'
    if (!response.ok) return null
    const saved = await response.json() as PdfRecordSnapshot
    pdfRecordSaveGeneration++
    pdfRecordSnapshots.set(documentIdFor(source), saved)
    publishPdfRecords(saved)
    return saved
  } catch {
    return null
  }
}

const RECORD_ENDPOINTS: Record<RecordOwner, (target: RecordTarget, project: string) => string> = {
  project_asset: (target, project) => `/api/workbench/assets/${encodeURIComponent(target.subject_id)}/pdf/records?${new URLSearchParams({ project })}`,
  literature_attachment: (target, _project) => `/api/v1/literatures/${encodeURIComponent(target.scope_id)}/attachments/${encodeURIComponent(target.subject_id)}/records`
}

export function recordTargetFor(source: DocumentSource): RecordTarget | null {
  if (source.kind === 'literature') return source.recordTarget
  if (source.kind === 'session-file') return source.recordTarget ?? null
  if (source.kind === 'project' && source.assetId) {
    return { owner: 'project_asset', scope_id: source.project ?? '', subject_id: source.assetId }
  }
  return null
}

function recordEndpoint(target: RecordTarget, source: DocumentSource): string {
  const project = source.kind === 'project' ? source.project ?? '' : ''
  return RECORD_ENDPOINTS[target.owner](target, project)
}

export type ImageOperationCode = 'stageUnsupported' | 'stageFailed' | 'releaseFailed' | 'saveUnsupported' | 'saveFailed' | 'readFailed'
export class ImageOperationError extends Error {
  constructor(readonly code: ImageOperationCode, readonly status?: number) {
    super(code)
    this.name = 'ImageOperationError'
  }
}

export interface OfficeImageLease { lease: string; path: string; revision: string }

export async function stageOfficeImage(source: DocumentSource, bytes: Uint8Array): Promise<OfficeImageLease> {
  if (source.kind !== 'project') throw new ImageOperationError('stageUnsupported')
  const response = await fetch(`${base()}/api/workbench/office-images?${paramsFor(source)}`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'image/png' },
    body: new Blob([new Uint8Array(bytes)])
  })
  if (!response.ok) throw new ImageOperationError('stageFailed', response.status)
  return response.json() as Promise<OfficeImageLease>
}

export async function releaseOfficeImage(source: DocumentSource, lease: OfficeImageLease): Promise<void> {
  if (source.kind !== 'project') throw new ImageOperationError('stageUnsupported')
  const params = paramsFor(source)
  params.set('lease', lease.lease)
  const response = await fetch(`${base()}/api/workbench/office-images?${params}`, {
    method: 'DELETE', credentials: 'include', headers: { 'If-Match': `"${lease.revision}"` }
  })
  if (!response.ok && response.status !== 404) throw new ImageOperationError('releaseFailed', response.status)
}

/** Persist first; the editor stores only this portable, URI-encoded relative path. */
export async function persistMarkdownImage(source: DocumentSource, file: File): Promise<string> {
  if (source.kind !== 'project') throw new ImageOperationError('saveUnsupported')
  const response = await fetch(`${base()}/api/workbench/images?${paramsFor(source)}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': file.type }, body: file
  })
  if (!response.ok) throw new ImageOperationError('saveFailed', response.status)
  const result = await response.json() as { path: string }
  return result.path.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
}

/** Resolve display only; never replace the Markdown node's persisted src. */
export function markdownImageUrl(source: DocumentSource, url: string): string {
  if (source.kind !== 'project' || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) return url
  const parent = source.path.slice(0, source.path.lastIndexOf('/') + 1)
  try {
    return `${base()}/api/workbench/content?${paramsFor({ ...source, path: parent + decodeURIComponent(url) })}`
  } catch {
    return url
  }
}

/** Document-scoped display resources; serialized Markdown keeps its relative paths. */
export function createMarkdownImageResolver(source: DocumentSource): {
  resolve: (url: string) => string | Promise<string>
  dispose: () => void
} {
  const requests = new Map<string, Promise<string>>()
  const objectUrls = new Set<string>()
  const controller = new AbortController()
  return {
    resolve: (url) => {
      const endpoint = markdownImageUrl(source, url)
      if (endpoint === url) return url
      const cached = requests.get(endpoint)
      if (cached) return cached
      const pending = (async () => {
        const response = await fetch(endpoint, { credentials: 'include', signal: controller.signal })
        if (!response.ok) throw new ImageOperationError('readFailed', response.status)
        const blob = await response.blob()
        controller.signal.throwIfAborted()
        const objectUrl = URL.createObjectURL(blob)
        objectUrls.add(objectUrl)
        return objectUrl
      })().catch((error) => {
        requests.delete(endpoint)
        throw error
      })
      requests.set(endpoint, pending)
      return pending
    },
    dispose: () => {
      controller.abort()
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
      objectUrls.clear()
      requests.clear()
    }
  }
}

/** Resolve only a citation retained by the resource's persisted import receipt. */
export async function resolveSavedCitation(source: ProjectDocumentSource, handle: string): Promise<CitationResolution> {
  const params = new URLSearchParams({ project: source.project ?? '', path: source.path, handle })
  const response = await fetch(`${base()}/api/assistant/resources/citation?${params}`, { credentials: 'include' })
  if (!response.ok) throw new Error('saved_citation_unavailable')
  return response.json()
}
