import { assistantRequestFailure, AssistantRequestError } from './failure.ts'
import type { AssistantFailure } from '../../contracts/assistant'
import type { ContextLabelFallback } from '../../contracts/assistant'
/** HTTP client owned by the Assistant feature. */
import type { TFunction } from 'i18next'
import type { CitationResolution } from '../../contracts/citations'
import { sseData } from '../../sse.ts'

import type {
  ArtifactLibraryLinksResult,
  ArtifactLiteratureLink,
  ArtifactResourceLink,
  ArtifactResourceLinksResult,
  AnswerAnnotation,
  AnswerAnnotationBatchDelete,
  AnswerAnnotationCreate,
  AnswerAnnotationUpdate,
  AnswerAnnotationMutation,
  AssistantContextCandidate,
  AssistantContextPatch,
  AssistantContextSelection,
  AssistantInvocationMutationResult,
  AssistantInvocationResult,
  AssistantSelectionActionInput,
  AssistantSelectionActionMutationResult,
  AssistantSelectionActionResult,
  AssistantSelectionStreamOptions,
  AssistantSelectionEvent,
  AssistantTranslationLanguage,
  AssistantTranslationTarget
} from '../../contracts/assistant'
import type {
  ResourceLocationRef,
  ResourceMutation,
  ResourceNode
} from '../../contracts/resources'

const SESSION_REFERENCE_PREVIEW_FAILED = 'assistant_session_preview_failed'
const CITATION_UNVERIFIABLE_CODES = new Set([
  'answer_revision_conflict',
  'citation_answer_unavailable',
  'citation_evidence_unavailable',
  'citation_link_invalid',
  'citation_snapshot_unavailable'
])
const SELECTION_ACTION_ROUTE = '/api/workbench/selection/actions'
const SSE_MEDIA_TYPE = 'text/event-stream'
const SELECTION_STREAM_ERROR = 'selection_stream_incomplete'
const SELECTION_ACTIVITY_TYPES = new Set(['accepted', 'started', 'output_delta', 'output_completed'])
const base = (): string => window.scholarseed?.getApiBase() ?? ''

export interface SessionReferenceMessage {
  message_id: string
  role: 'user' | 'assistant'
  text: string
}

export interface SessionReferencePreview {
  label_fallback?: ContextLabelFallback
  title: string
  messages: SessionReferenceMessage[]
  changed: boolean
  has_more: boolean
  next_cursor: string
}

/** An application-owned preview failure, distinct from an upstream diagnostic. */
export class SessionReferencePreviewError extends Error {
  readonly code = SESSION_REFERENCE_PREVIEW_FAILED

  constructor() {
    super(SESSION_REFERENCE_PREVIEW_FAILED)
    this.name = 'SessionReferencePreviewError'
  }
}

export class CitationResolveError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CitationResolveError'
  }
}

export function isUnverifiableCitationError(error: unknown): boolean {
  return error instanceof CitationResolveError && CITATION_UNVERIFIABLE_CODES.has(error.code)
}

export async function fetchSessionReferencePreview(
  sessionId: string,
  snapshotId: string,
  sourceId: string,
  cursor = ''
): Promise<SessionReferencePreview> {
  const query = new URLSearchParams({ source_id: sourceId })
  if (cursor) query.set('cursor', cursor)
  const response = await fetch(
    `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}`
      + `/context/${encodeURIComponent(snapshotId)}/session-preview?${query.toString()}`,
    { credentials: 'include' }
  )
  const payload = await response.json().catch(() => null) as SessionReferencePreview | { detail?: string } | null
  if (!response.ok || !payload || typeof payload !== 'object' || !('messages' in payload)) {
    if (payload && typeof payload === 'object' && 'detail' in payload && typeof payload.detail === 'string' && payload.detail) {
      throw new Error(payload.detail)
    }
    throw new SessionReferencePreviewError()
  }
  return payload
}

export async function listArtifactLibraryLinks(sessionId: string): Promise<ArtifactLibraryLinksResult> {
  const resources = await listArtifactResourceLinks(sessionId)
  if (!resources.ok) return resources
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/literature/links`,
      { credentials: 'include' }
    )
    if (!response.ok) return { ok: false, error: `http_${response.status}` }
    const payload = await response.json() as { links: ArtifactLiteratureLink[] }
    if (!Array.isArray(payload.links)) return { ok: false, error: 'invalid_response' }
    return { ok: true, links: [...resources.links, ...payload.links] }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}

export async function listArtifactResourceLinks(sessionId: string): Promise<ArtifactResourceLinksResult> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/resources/links`,
      { credentials: 'include' }
    )
    if (!response.ok) return { ok: false, error: `http_${response.status}` }
    const payload = await response.json() as { links: ArtifactResourceLink[] }
    if (!Array.isArray(payload.links)) return { ok: false, error: 'invalid_response' }
    return { ok: true, links: payload.links }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}

export async function resolveCitation(sessionId: string, answerId: string, answerRevision: string, start: number, end: number, handle = ''): Promise<CitationResolution> {
  const response = await fetch(`${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/answers/${encodeURIComponent(answerId)}/citation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer_revision: answerRevision, start_utf16: start, end_utf16: end, handle })
  })
  const payload = await response.json()
  if (!response.ok) {
    if (payload && typeof payload === 'object' && typeof payload.detail === 'string') throw new CitationResolveError(payload.detail)
    throw new AssistantRequestError()
  }
  return payload as CitationResolution
}

export function citationPreviewUrl(source: CitationResolution): string {
  if (!source.answer_session_id || !source.answer_id || !source.answer_revision || source.presentation.page == null) return ''
  const root = `${base()}/api/assistant/sessions/${encodeURIComponent(source.answer_session_id)}/answers/${encodeURIComponent(source.answer_id)}/citations/${encodeURIComponent(source.handle)}/preview`
  const query = new URLSearchParams({ answer_revision: source.answer_revision, page: String(source.presentation.page) })
  return `${root}?${query.toString()}`
}

/** `GET /api/resource/tree` 的顶层节点形状（只取本域需要的字段）。 */
interface ResourceFolderNode {
  path: string
  name: string
  kind: 'file' | 'dir'
  count?: number | null
  children?: ResourceFolderNode[]
}

function toResourceNode(node: ResourceFolderNode): ResourceNode {
  return {
    path: node.path,
    name: node.name,
    kind: node.kind,
    count: node.count ?? undefined,
    children: node.children?.map(toResourceNode)
  }
}

interface ResourceFolderTreeResponse {
  root: string
  nodes: ResourceFolderNode[]
  total?: number
  offset?: number
}

interface LiteratureContextItem {
  id: string
  title: string
  creators_display: string
  publication_display: string
  year: number | null
  created_at: string
  last_read_at: string | null
}

interface LiteratureContextResponse {
  items: LiteratureContextItem[]
  next_cursor?: string | null
}

interface ResourceContextItem {
  path: string
  size: number
  created_at: number
}

interface ResourceContextResponse {
  items: ResourceContextItem[]
  next_cursor?: string | null
}

const RESOURCE_FILE_KIND_LABELS: Record<string, string> = {
  csv: 'table',
  doc: 'word',
  docx: 'word',
  md: 'doc',
  pdf: 'pdf',
  txt: 'text',
  xls: 'table',
  xlsx: 'table'
}

const LITERATURE_CONTEXT_CANDIDATE_PAGE_SIZE = 200
const DEFAULT_RESOURCE_FILE_KIND_LABEL = 'file'
const RESOURCE_CANDIDATE_DEPTH = 1

function resourceFileKindLabel(name: string): string {
  const extension = name.includes('.') ? name.split('.').pop()?.toLocaleLowerCase() ?? '' : ''
  return RESOURCE_FILE_KIND_LABELS[extension] ?? DEFAULT_RESOURCE_FILE_KIND_LABEL
}

export interface AssistantContextMutationResult extends AssistantFailure {
  ok: boolean
  context?: AssistantContextSelection
  latest?: AssistantContextSelection
  error?: string
}

export interface AnswerAnnotationApiResult extends AssistantFailure {
  ok: boolean
  annotation?: AnswerAnnotation
  context?: AssistantContextSelection
  latest?: AssistantContextSelection
  latestAnnotation?: AnswerAnnotation
  error?: string
}

interface AnnotationErrorPayload {
  detail?: string | {
    error?: string
    latest?: AssistantContextSelection | AnswerAnnotation
  }
}

function annotationError(
  status: number,
  payload: AnnotationErrorPayload | null
): Pick<AnswerAnnotationApiResult, 'error' | 'latest' | 'latestAnnotation'> {
  const detail = payload?.detail
  const latest = typeof detail === 'object' ? detail.latest : undefined
  return {
    error: typeof detail === 'string' ? detail : detail?.error ?? `http_${status}`,
    ...(
      latest && 'refs' in latest
        ? { latest }
        : latest && 'annotation_id' in latest
          ? { latestAnnotation: latest }
          : {}
    )
  }
}

export async function listAnswerAnnotations(sessionId: string): Promise<AnswerAnnotation[]> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/annotations`,
      { credentials: 'include' }
    )
    if (!response.ok) return []
    const payload = (await response.json()) as { annotations?: AnswerAnnotation[] }
    return payload.annotations ?? []
  } catch {
    return []
  }
}

export async function createAnswerAnnotation(
  sessionId: string,
  answerId: string,
  body: AnswerAnnotationCreate
): Promise<AnswerAnnotationApiResult> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}`
        + `/answers/${encodeURIComponent(answerId)}/annotations`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
    const payload = (await response.json().catch(() => null)) as
      | AnswerAnnotationMutation
      | AnnotationErrorPayload
      | null
    if (!response.ok || !payload || !('annotation' in payload)) {
      return { ok: false, ...annotationError(response.status, payload as AnnotationErrorPayload) }
    }
    return { ok: true, annotation: payload.annotation, context: payload.selection }
  } catch (error) {
    return { ok: false, ...assistantRequestFailure(error) }
  }
}

export async function updateAnswerAnnotation(
  sessionId: string,
  annotationId: string,
  body: AnswerAnnotationUpdate
): Promise<AnswerAnnotationApiResult> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}`
        + `/annotations/${encodeURIComponent(annotationId)}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
    const payload = (await response.json().catch(() => null)) as
      | AnswerAnnotationMutation
      | AnnotationErrorPayload
      | null
    if (!response.ok || !payload || !('annotation' in payload)) {
      return { ok: false, ...annotationError(response.status, payload as AnnotationErrorPayload) }
    }
    return { ok: true, annotation: payload.annotation, context: payload.selection }
  } catch (error) {
    return { ok: false, ...assistantRequestFailure(error) }
  }
}

async function deleteAnswerAnnotationRequest(
  sessionId: string,
  annotationId: string,
  suffix: string,
  body: Record<string, number>
): Promise<AnswerAnnotationApiResult> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}`
        + `/annotations/${encodeURIComponent(annotationId)}${suffix}`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
    const payload = (await response.json().catch(() => null)) as
      | AssistantContextSelection
      | AnnotationErrorPayload
      | null
    if (!response.ok || !payload || !('session_id' in payload)) {
      return { ok: false, ...annotationError(response.status, payload as AnnotationErrorPayload) }
    }
    return { ok: true, context: payload }
  } catch (error) {
    return { ok: false, ...assistantRequestFailure(error) }
  }
}

export async function removeAnswerAnnotationContext(
  sessionId: string,
  annotationId: string,
  expectedContextRevision: number
): Promise<AnswerAnnotationApiResult> {
  return deleteAnswerAnnotationRequest(sessionId, annotationId, '/context', {
    expected_context_revision: expectedContextRevision
  })
}

export async function deleteAnswerAnnotation(
  sessionId: string,
  annotationId: string,
  expectedAnnotationRevision: number,
  expectedContextRevision: number
): Promise<AnswerAnnotationApiResult> {
  return deleteAnswerAnnotationRequest(sessionId, annotationId, '', {
    expected_annotation_revision: expectedAnnotationRevision,
    expected_context_revision: expectedContextRevision
  })
}

export async function deleteAnswerAnnotations(
  sessionId: string,
  body: AnswerAnnotationBatchDelete
): Promise<AnswerAnnotationApiResult> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/annotations`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
    const payload = (await response.json().catch(() => null)) as
      | AssistantContextSelection
      | AnnotationErrorPayload
      | null
    if (!response.ok || !payload || !('session_id' in payload)) {
      return { ok: false, ...annotationError(response.status, payload as AnnotationErrorPayload) }
    }
    return { ok: true, context: payload }
  } catch (error) {
    return { ok: false, ...assistantRequestFailure(error) }
  }
}

export interface SaveAnswerSelectionInput {
  sessionId: string
  projectId: string
  answerId: string
  answerRevision: string
  startUtf16: number
  endUtf16: number
  selectedTextHash: string
  selectedMarkdown: string
  question: string
  location: ResourceLocationRef
}

export type AssistantResourceMutation = ResourceMutation & AssistantFailure
export type SaveAnswerSelectionResult = AssistantResourceMutation

interface AssistantAnswerResourceSource {
  answer_id: string
  answer_revision: string
  start_utf16: number
  end_utf16: number
  selected_text_hash: string
}

interface CreateAssistantResourceOptions {
  projectId: string
  location?: ResourceLocationRef
  source?: AssistantAnswerResourceSource
}

export interface ImportArtifactOptions {
  projectId: string
  expectedSha256?: string
  location?: ResourceLocationRef
}

const ARTIFACT_REVISION_PREFIX = 'sha256:'
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export async function fetchArtifactSha256(
  sessionId: string,
  artifactId: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${base()}/api/serve/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/raw`,
      { method: 'HEAD', credentials: 'include', cache: 'no-store' }
    )
    if (!response.ok) return null
    const revision = response.headers.get('etag')?.replace(/^"|"$/g, '') ?? ''
    const sha256 = revision.startsWith(ARTIFACT_REVISION_PREFIX)
      ? revision.slice(ARTIFACT_REVISION_PREFIX.length)
      : revision
    return SHA256_PATTERN.test(sha256) ? sha256 : null
  } catch {
    return null
  }
}

export type ArtifactLiteratureImportResult =
  | { ok: true; operation_id: string; item_ids: string[]; added: number; skipped: number }
  | { ok: false; error: string }

export async function importArtifactToLiterature(
  sessionId: string,
  artifactId: string,
  expectedSha256?: string,
  collection = ''
): Promise<ArtifactLiteratureImportResult> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/literature/import`,
      {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ artifact_id: artifactId, expected_sha256: expectedSha256, collection })
      }
    )
    const payload = await response.json() as Exclude<ArtifactLiteratureImportResult, { ok: false }> & { detail?: string }
    if (!response.ok) return { ok: false, error: payload.detail ?? `http_${response.status}` }
    if (!Array.isArray(payload.item_ids) || !payload.operation_id) return { ok: false, error: 'invalid_response' }
    return { ...payload, ok: true }
  } catch {
    return { ok: false, error: 'network_error' }
  }
}

export async function getAssistantContext(
  sessionId: string
): Promise<AssistantContextSelection | null> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/context`,
      { credentials: 'include' }
    )
    if (!response.ok) return null
    return (await response.json()) as AssistantContextSelection
  } catch {
    return null
  }
}

export async function patchAssistantContext(
  sessionId: string,
  patch: AssistantContextPatch
): Promise<AssistantContextMutationResult> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/context`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      }
    )
    const payload = (await response.json().catch(() => null)) as
      | AssistantContextSelection
      | {
          detail?: {
            error?: string
            latest?: AssistantContextSelection
          } | string
        }
      | null
    if (!response.ok) {
      const detail = payload && 'detail' in payload ? payload.detail : undefined
      return {
        ok: false,
        error: typeof detail === 'string'
          ? detail
          : detail?.error ?? `http_${response.status}`,
        latest: typeof detail === 'object' ? detail.latest : undefined
      }
    }
    return { ok: true, context: payload as AssistantContextSelection }
  } catch (error) {
    return {
      ok: false,
      ...assistantRequestFailure(error)
    }
  }
}

interface AssistantResourceNodePayload {
  path: string
  name: string
  kind: 'file' | 'dir'
  origin?: ResourceNode['origin']
}

async function postAssistantResource(
  sessionId: string,
  action: 'create' | 'import' | 'attachment',
  body: Record<string, unknown>
): Promise<AssistantResourceMutation> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/resources/${action}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string; node?: AssistantResourceNodePayload }
      | null
    if (!response.ok) {
      return { ok: false, error: payload?.detail ?? `http_${response.status}` }
    }
    return { ok: true, node: payload?.node }
  } catch (error) {
    return {
      ok: false,
      ...assistantRequestFailure(error)
    }
  }
}

interface InvocationIdentity {
  client_action_id: string
  client_attempt_id: string
  retry_of_attempt_id?: string | null
  project_id: string
  model_key?: string
}

export interface StartOneShotRequest extends InvocationIdentity {
  input_text: string
  instructions?: string
}

export interface StartTranslationRequest extends InvocationIdentity {
  text: string
  source_language: AssistantTranslationLanguage
  target_language: AssistantTranslationTarget
  source_id?: string
  source_revision?: string | null
}

export interface StartSelectionActionRequest
  extends InvocationIdentity, AssistantSelectionActionInput {}

async function postInvocation(
  path: string,
  body: StartOneShotRequest | StartTranslationRequest
): Promise<AssistantInvocationMutationResult> {
  try {
    const response = await fetch(`${base()}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const payload = (await response.json().catch(() => null)) as
      | AssistantInvocationResult
      | { detail?: string }
      | null
    if (payload && 'invocation_id' in payload) {
      return {
        ok: payload.status === 'completed',
        invocation: payload,
        error: payload.error?.code
      }
    }
    return {
      ok: false,
      error: payload?.detail ?? `http_${response.status}`
    }
  } catch (error) {
    return {
      ok: false,
      ...assistantRequestFailure(error)
    }
  }
}

/** 把 AI 回答内容以一次请求新建为 Markdown 资料。 */
export const createResourceFromAssistant = (
  sessionId: string,
  name: string,
  content: string,
  options: CreateAssistantResourceOptions
): Promise<AssistantResourceMutation> => {
  const body: Record<string, unknown> = { project_id: options.projectId, name, content }
  if (options.source) body.source = options.source
  if (options.location) {
    body.location = {
      parent: options.location.parent.trim(),
      name: options.location.name.trim()
    }
  }
  return postAssistantResource(sessionId, 'create', body)
}

/** 把回答选区连同可校验来源信息新建为独立 Markdown 资料。 */
export function saveAnswerSelectionToResource(
  input: SaveAnswerSelectionInput,
  t: TFunction<'assistant'>
): Promise<SaveAnswerSelectionResult> {
  const title = input.location.name.trim().replace(/\.md$/i, '')
  const content = [
    `# ${title}`,
    '',
    `> ${t('excerptTemplate.description')}`,
    '',
    `## ${t('excerptTemplate.question')}`,
    '',
    input.question.trim(),
    '',
    `## ${t('excerptTemplate.excerpt')}`,
    '',
    input.selectedMarkdown,
    ''
  ].join('\n')
  return createResourceFromAssistant(input.sessionId, title, content, {
    projectId: input.projectId,
    location: input.location,
    source: {
      answer_id: input.answerId,
      answer_revision: input.answerRevision,
      start_utf16: input.startUtf16,
      end_utf16: input.endUtf16,
      selected_text_hash: input.selectedTextHash
    }
  })
}

/** 把当前 Session 的结构化产物复制进资料库，可校验版本并指定资料库相对位置。 */
export const importArtifactToResources = (
  sessionId: string,
  artifactId: string,
  options: ImportArtifactOptions
): Promise<AssistantResourceMutation> => {
  const body: Record<string, unknown> = { project_id: options.projectId, artifact_id: artifactId }
  if (options.expectedSha256) body.expected_sha256 = options.expectedSha256
  if (options.location) {
    body.location = {
      parent: options.location.parent.trim(),
      name: options.location.name.trim()
    }
  }
  return postAssistantResource(sessionId, 'import', body)
}

export const importAttachmentToResources = (
  sessionId: string,
  projectId: string,
  referenceId: string,
  location: ResourceLocationRef
): Promise<AssistantResourceMutation> => postAssistantResource(sessionId, 'attachment', {
  project_id: projectId,
  reference_id: referenceId,
  location: { parent: location.parent.trim(), name: location.name.trim() }
})

export function startAssistantInvocation(
  body: StartOneShotRequest
): Promise<AssistantInvocationMutationResult> {
  return postInvocation('/api/assistant/invocations', body)
}

export function startAssistantTranslation(
  body: StartTranslationRequest
): Promise<AssistantInvocationMutationResult> {
  return postInvocation('/api/assistant/translations', body)
}

export async function startAssistantSelectionAction(
  body: StartSelectionActionRequest,
  stream?: AssistantSelectionStreamOptions
): Promise<AssistantSelectionActionMutationResult> {
  try {
    const response = await fetch(`${base()}${SELECTION_ACTION_ROUTE}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...(stream ? { Accept: SSE_MEDIA_TYPE } : {}) },
      signal: stream?.signal,
      body: JSON.stringify({
        action: body.action,
        client_action_id: body.client_action_id,
        client_attempt_id: body.client_attempt_id,
        retry_of_attempt_id: body.retry_of_attempt_id ?? null,
        selection: {
          project_id: body.project_id,
          source_id: body.source_id,
          source_revision: body.source_revision,
          locator_kind: body.selection.locator.kind,
          selected_text_hash: body.selection.selected_text_hash,
          locator: body.selection.locator
        },
        ...(body.draft ? { draft: body.draft } : {}),
        question: body.question ?? '',
        target_language: body.target_language ?? ''
      })
    })
    if (stream && response.ok) {
      if (!response.body || !response.headers.get('content-type')?.includes(SSE_MEDIA_TYPE)) {
        return { ok: false, error: SELECTION_STREAM_ERROR }
      }
      let invocationId = ''
      for await (const frame of sseData(response.body)) {
        const event = JSON.parse(frame)
        if (event?.type === 'error' && typeof event.error === 'string') {
          return { ok: false, error: event.error }
        }
        if (event?.type === 'result') {
          const result = event.result as AssistantSelectionActionResult
          if (!result || typeof result.output !== 'string' || !result.invocation_id
            || result.client_attempt_id !== body.client_attempt_id
            || result.action !== body.action || (invocationId && result.invocation_id !== invocationId)) {
            return { ok: false, error: SELECTION_STREAM_ERROR }
          }
          return { ok: true, result }
        }
        if (!SELECTION_ACTIVITY_TYPES.has(event?.type) || typeof event.invocation_id !== 'string'
          || !event.invocation_id || typeof event.text !== 'string' || typeof event.item_id !== 'string'
          || (invocationId && event.invocation_id !== invocationId)) {
          return { ok: false, error: SELECTION_STREAM_ERROR }
        }
        invocationId = event.invocation_id
        stream.onEvent(event as AssistantSelectionEvent)
      }
      return { ok: false, error: SELECTION_STREAM_ERROR }
    }
    const payload = await response.json().catch(() => null) as
      | AssistantSelectionActionResult
      | { detail?: string }
      | null
    if (!response.ok || !payload || !('invocation_id' in payload)) {
      return {
        ok: false,
        error: payload && 'detail' in payload
          ? payload.detail ?? `http_${response.status}`
          : `http_${response.status}`
      }
    }
    return { ok: true, result: payload }
  } catch (error) {
    return {
      ok: false,
      ...assistantRequestFailure(error)
    }
  }
}

export async function stopAssistantSelection(invocationId: string): Promise<boolean> {
  try {
    const response = await fetch(`${base()}${SELECTION_ACTION_ROUTE}/${encodeURIComponent(invocationId)}/interrupt`, {
      method: 'POST', credentials: 'include'
    })
    return response.ok && (await response.json()).accepted === true
  } catch {
    return false
  }
}

/** One folder page from the Resources public API; paths remain project-relative. */
export async function fetchResourceCandidatePage(
  projectId: string | null,
  path = '',
  offset = 0
): Promise<{ items: AssistantContextCandidate[]; nextOffset: number | null } | null> {
  if (!projectId) return null
  const params = new URLSearchParams()
  params.set('project', projectId)
  if (path) params.set('path', path)
  params.set('depth', String(RESOURCE_CANDIDATE_DEPTH))
  if (offset > 0) params.set('offset', String(offset))
  try {
    const response = await fetch(`${base()}/api/resource/tree?${params.toString()}`, {
      credentials: 'include'
    })
    if (!response.ok) return null
    const payload = (await response.json()) as ResourceFolderTreeResponse
    const nodes = payload.nodes ?? []
    const nextOffset = (payload.offset ?? offset) + nodes.length
    return {
      items: nodes.map((node) => ({
        kind: node.kind === 'dir' ? ('dir' as const) : ('file' as const),
        source_id: node.path,
        label: node.name,
        hint: node.kind === 'dir' ? 'folder' : resourceFileKindLabel(node.name),
        retention: 'next_turn' as const,
        origin: 'explicit' as const
      })),
      nextOffset: nodes.length > 0 && nextOffset < (payload.total ?? nextOffset)
        ? nextOffset : null
    }
  } catch {
    return null
  }
}

export const RESOURCE_CONTEXT_KIND = 'resource'
const RESOURCE_ROOT_SOURCE_ID = 'resources'

function resourceContextQuery(query: string): { path: string; term: string } {
  const normalized = query.trim()
  const slash = normalized.lastIndexOf('/')
  const relativePath = slash >= 0 ? normalized.slice(0, slash) : ''
  return {
    path: relativePath,
    term: slash >= 0 ? normalized.slice(slash + 1) : normalized
  }
}

/** Visible leaf filter while @resource navigates a project-relative directory. */
export function resourceContextSearchTerm(query: string): string {
  return resourceContextQuery(query).term
}

/** Convert a stable Resources source id into the path shown after @resource:. */
export function resourceContextTriggerPath(sourceId: string): string {
  const prefix = `${RESOURCE_ROOT_SOURCE_ID}/`
  return sourceId.startsWith(prefix) ? sourceId.slice(prefix.length) : sourceId
}

/** Current-directory candidates for the Assistant picker and @resource navigation. */
export async function fetchResourceFolderCandidates(
  projectId: string | null,
  query: string
): Promise<AssistantContextCandidate[]> {
  const { path, term } = resourceContextQuery(query)
  const page = await fetchResourceCandidatePage(projectId, path)
  const normalized = term.toLocaleLowerCase()
  return (page?.items ?? []).filter(
    (item) => !normalized || item.label.toLocaleLowerCase().includes(normalized)
  )
}

/** Complete flat resource candidates for search and global quick filters. */
export async function fetchResourceCandidates(
  projectId: string | null,
  query: string
): Promise<AssistantContextCandidate[]> {
  if (!projectId) return []
  const normalized = query.trim().toLocaleLowerCase()
  const items: AssistantContextCandidate[] = []
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ project: projectId })
    if (cursor) params.set('cursor', cursor)
    try {
      const response = await fetch(`${base()}/api/resource/candidates?${params.toString()}`, {
        credentials: 'include'
      })
      if (!response.ok) return []
      const payload = (await response.json()) as ResourceContextResponse
      items.push(...(payload.items ?? [])
        .filter((item) => !normalized || item.path.slice(item.path.lastIndexOf('/') + 1).toLocaleLowerCase().includes(normalized))
        .map((item) => ({
          kind: 'file' as const,
          source_id: item.path,
          label: item.path.slice(item.path.lastIndexOf('/') + 1),
          hint: item.path,
          created_at: item.created_at,
          retention: 'next_turn' as const,
          origin: 'explicit' as const
        })))
      cursor = payload.next_cursor ?? null
    } catch {
      return []
    }
  } while (cursor)
  return items
}

/** Session 关联项目的资料目录树，供保存弹窗选择目标目录。 */
export async function fetchResourceDirectoryTree(projectId: string): Promise<ResourceNode[]> {
  const params = new URLSearchParams({ project: projectId })
  try {
    const response = await fetch(`${base()}/api/resource/tree?${params.toString()}`, {
      credentials: 'include'
    })
    if (!response.ok) return []
    const payload = (await response.json()) as ResourceFolderTreeResponse
    return (payload.nodes ?? []).map(toResourceNode)
  } catch {
    return []
  }
}

/** 文献库条目候选；只消费文献域公开 HTTP 契约，不读取其 Feature Store。 */
export async function fetchLiteratureCandidates(
  projectId: string | null,
  query: string
): Promise<AssistantContextCandidate[]> {
  const items: AssistantContextCandidate[] = []
  let page = 1
  let nextCursor: string | null = null
  do {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(LITERATURE_CONTEXT_CANDIDATE_PAGE_SIZE)
    })
    if (projectId) params.set('project_id', projectId)
    if (query.trim()) params.set('q', query.trim())
    try {
      const response = await fetch(`${base()}/api/v1/literatures?${params.toString()}`, {
        credentials: 'include'
      })
      if (!response.ok) return []
      const payload = (await response.json()) as LiteratureContextResponse
      items.push(...(payload.items ?? []).map((item) => {
        const createdAt = Date.parse(item.created_at)
        const openedAt = item.last_read_at ? Date.parse(item.last_read_at) : Number.NaN
        return {
          kind: 'literature' as const,
          source_id: item.id,
          label: item.title.trim() || item.id,
          hint: [item.creators_display, item.year ? String(item.year) : item.publication_display]
            .filter(Boolean)
            .join(' · '),
          ...(Number.isFinite(createdAt) ? { created_at: createdAt / 1000 } : {}),
          ...(Number.isFinite(openedAt) ? { opened_at: openedAt / 1000 } : {}),
          retention: 'next_turn' as const,
          origin: 'explicit' as const
        }
      }))
      nextCursor = payload.next_cursor ?? null
      page += 1
    } catch {
      return []
    }
  } while (nextCursor)
  return items
}

export async function getAssistantInvocation(
  invocationId: string
): Promise<AssistantInvocationResult | null> {
  try {
    const response = await fetch(
      `${base()}/api/assistant/invocations/${encodeURIComponent(invocationId)}`,
      { credentials: 'include' }
    )
    return response.ok ? (await response.json()) as AssistantInvocationResult : null
  } catch {
    return null
  }
}

export async function citationSources(sessionId: string, answerId: string, revision: string, range?: { start: number; end: number }): Promise<{ count: number; sources: CitationResolution[] }> {
  const params = new URLSearchParams({ answer_revision: revision })
  if (range) { params.set('start_utf16', String(range.start)); params.set('end_utf16', String(range.end)) }
  const response = await fetch(`${base()}/api/assistant/sessions/${encodeURIComponent(sessionId)}/answers/${encodeURIComponent(answerId)}/sources?${params}`, { credentials: 'include' })
  if (!response.ok) throw new Error('citation_sources_unavailable')
  return response.json()
}
