/**
 * 资料库 HTTP 客户端（MVP 0.2）。
 *
 * 归属：资料库负责人。统一走 0.1 既有的 apiBase 约定（由 Electron
 * preload 下发），不自带地址配置。
 *
 * 错误约定：读操作失败返回 null（与「确实为空」区分）；写操作返回
 * `{ ok, error }`，把后端的 detail 码原样带回，让调用方能按码提示，
 * 而不是统一弹一句「操作失败」。
 */

import {
  LITERATURE_EXCERPT_SOURCE_KIND,
  PDF_EXCERPT_LOCATOR_KIND,
  type LiteratureExcerptSelection
} from '../../contracts/resources.ts'
import type { FindTextReveal } from '../../contracts/workbench.ts'
import type {
  AssetOrigin,
  ResourceLinkRoot,
  ResourceManagementState,
  ResourceNode
} from './state'

/** 后端返回的树节点（字段与 service/resources 的资产契约 对齐）。 */
interface ResourceNodePayload {
  source?: 'imported' | 'created' | 'linked' | null
  file_type?: string
  updated_at?: number
  path: string
  name: string
  kind: 'file' | 'dir'
  /** 该目录条目的总数，不是本次返回的条数。 */
  count: number | null
  origin?: AssetOrigin
  git_repository?: boolean
  link_root_id?: string
  children?: ResourceNodePayload[]
  version?: {
    management_state: ResourceManagementState
    drifted: boolean
    snapshot_state: ResourceCapability['snapshot_state'] | null
    pending_origin: ResourcePending['origin'] | null
    manual_admitted?: boolean
    needs_review: boolean
  }
}

interface ResourceTreePayload {
  root: string
  resource_root: string
  nodes: ResourceNodePayload[]
  /** 这一层的条目总数与本页起点。 */
  total: number
  offset: number
  linked_roots?: Record<string, {
    root_id: string
    mount_path: string
    source_path: string
  }>
}

/** 写操作结果。error 为后端 detail 码，便于分支处理。 */
export interface ResourceMutation {
  ok: boolean
  error?: string
  node?: ResourceNode
}

export type ResourceImportDecisionAction = 'rename' | 'replace'

export interface ResourceImportConflict {
  sourceIndex: number
  sourceName: string
  sourceKind: 'file' | 'dir'
  targetPath: string
  targetKind: 'file' | 'dir' | null
  suggestedName: string
  expectedTargetRevision: string | null
  canReplaceWithVersion: boolean
}

export type ResourceImportMutation =
  | { ok: true; status: 'completed'; projectId: string; imported: ResourceNode[] }
  | {
      ok: true
      status: 'needs_resolution'
      planToken: string
      conflicts: ResourceImportConflict[]
    }
  | { ok: false; error: string }

export interface ResourceImportResolution {
  planToken: string
  action: ResourceImportDecisionAction
  sourceIndexes: number[]
  idempotencyKey: string
}

export interface ResourceAgentOrigin {
  sourceKind: 'answer' | 'artifact'
  sessionId: string
  sessionDeleted: boolean
  turnId: string | null
  itemId: string | null
  sourceRange?: { unit: string; start: number; end: number } | null
}

/** 资料搜索命中（对齐 service/content/service/search.py 的 ResourceHit）。 */
export interface ResourceSearchHit {
  path: string
  name: string
  matched: 'name' | 'path' | 'content'
  snippet: string
  reveal: FindTextReveal | null
}

export interface WebImportCandidate {
  title: string
  url: string
  snippet: string
}

export interface WebImportItem {
  title: string
  url: string
  status: 'success' | 'failed'
  finalUrl?: string
  node?: ResourceNode
  error?: string
}

export interface WebImportMutation {
  ok: boolean
  succeeded: number
  failed: number
  items: WebImportItem[]
  error?: string
}

const WEB_IMPORT_CANDIDATE_LIMIT_ERROR = 'web_import_candidate_limit'
const WEB_IMPORT_REJECTED_ERROR = 'web_import_rejected'

/** FastAPI rejects over-limit bodies with a validation-error object array, never a readable string. */
function webImportRequestError(payload: { detail?: unknown } | null, status: number): string {
  const detail = payload?.detail
  if (typeof detail === 'string' && detail.length > 0) return detail
  if (Array.isArray(detail)) {
    const candidateOverflow = detail.some((entry) => {
      if (typeof entry !== 'object' || entry === null) return false
      const record = entry as { loc?: unknown; type?: unknown }
      return Array.isArray(record.loc) && record.loc.includes('candidates') && record.type === 'too_long'
    })
    return candidateOverflow ? WEB_IMPORT_CANDIDATE_LIMIT_ERROR : WEB_IMPORT_REJECTED_ERROR
  }
  return `http_${status}`
}

export interface LiteratureExcerptImportInput {
  project: string
  literatureId: string
  documentRevision?: string
  selections: readonly LiteratureExcerptSelection[]
  parent?: string
  name?: string
}

export type LiteratureExcerptImportMutation =
  | {
      ok: true
      operation: 'created' | 'updated'
      node: ResourceNode
      literatureId: string
      added: number
      skipped: number
      total: number
    }
  | { ok: false; error: string }

/** `POST /api/resource/node` 支持的动作，与后端 NodeAction 一一对应。 */
export type NodeAction = 'create_document' | 'create_folder' | 'rename' | 'move' | 'copy'

export interface ResourceCapability {
  file_id: string | null
  version_id: string | null
  working_revision: string | null
  disk_revision: string | null
  manual_admitted?: boolean
  can_version: boolean
  can_diff: boolean
  can_preview_history: boolean
  management_state: 'migration_required' | 'managed' | 'git' | 'ignored' | 'oversized' | 'unsupported' | 'unavailable'
  drifted: boolean
  snapshot_state: 'saved' | 'pending'
  pending: ResourcePending | null
}

export interface ResourceSnapshot {
  object_id: string | null
  state: 'present' | 'tombstone'
  path: string
  mode_bits: number | null
  annotation_object_id: string | null
}

export interface ResourcePending {
  file_id: string
  revision: number
  origin: 'user' | 'agent' | 'external' | 'restore'
  review: {
    id: string
    group_id: string
    session_id: string
    first_turn_id: string
    turn_id: string
    terminal_outcome: 'completed' | 'failed' | 'interrupted'
    origin: 'agent' | 'external'
    base: ResourceSnapshot
    candidate: ResourceSnapshot
    base_revision: string | null
    candidate_revision: string | null
    edited_by_user: boolean
  } | null
}

export type ResourceReviewAction = 'accept' | 'reject' | 'revise'

export type ResourceReviewBatchState = 'open' | 'applying' | 'completed' | 'failed'
export type ResourceReviewMemberState = 'pending' | 'applying' | 'completed' | 'failed'

export interface ResourceReviewBatchMember {
  file_id: string
  review_id: string
  path: string
  pending_revision: number
  state: ResourceReviewMemberState
  origin: 'agent' | 'external'
  action: ResourceReviewAction | null
  error: string | null
  base: ResourceSnapshot
  candidate: ResourceSnapshot
  base_revision: string | null
  candidate_revision: string | null
  edited_by_user: boolean
  result_version_id: string | null
}

export interface ResourceReviewBatch {
  id: string
  session_id: string
  turn_id: string
  group_id: string
  state: ResourceReviewBatchState
  created_at_ms: number
  updated_at_ms: number
  members: ResourceReviewBatchMember[]
}

export interface ResourceReviewBatchPage {
  items: ResourceReviewBatch[]
  next_cursor: string | null
}

export interface ResourceReviewBatchDecision {
  file_id: string
  review_id: string
  pending_revision: number
  action: ResourceReviewAction
  expected_disk_revision: string | null
  revised_content?: Uint8Array
}

const REVIEW_BASE64_CHUNK_SIZE = 8192

function reviewContentBase64(content: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < content.length; offset += REVIEW_BASE64_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...content.subarray(offset, offset + REVIEW_BASE64_CHUNK_SIZE)))
  }
  return btoa(chunks.join(''))
}

export interface ResourceReviewBatchResult {
  file_id: string
  action: ResourceReviewAction
  state: 'completed' | 'failed'
  version_id?: string | null
  error?: string
}

export interface ResourceReviewBatchMutation {
  ok: boolean
  batch?: ResourceReviewBatch
  results?: ResourceReviewBatchResult[]
  error?: string
}

const CONTENT_REVISION_HEADER = 'X-ScholarSeed-Content-Revision'

function reviewBatchError(payload: unknown, status: number): string {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return `http_${status}`
  const error = payload.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string') return error.code
    if ('message' in error && typeof error.message === 'string') return error.message
  }
  return `http_${status}`
}

export async function fetchResourceReviewBatches(
  project: string,
  state: ResourceReviewBatchState = 'open',
  afterBatchId = ''
): Promise<ResourceReviewBatchPage | null> {
  const params = versionParams(project)
  params.set('state', state)
  if (afterBatchId) params.set('after_batch_id', afterBatchId)
  try {
    const response = await fetch(`${base()}/api/resource/review-batches?${params}`, {
      credentials: 'include', cache: 'no-store'
    })
    return response.ok ? await response.json() as ResourceReviewBatchPage : null
  } catch { return null }
}

export async function fetchResourceReviewBatch(
  project: string, batchId: string
): Promise<ResourceReviewBatch | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/review-batches/${encodeURIComponent(batchId)}?${versionParams(project)}`,
      { credentials: 'include', cache: 'no-store' }
    )
    return response.ok ? await response.json() as ResourceReviewBatch : null
  } catch { return null }
}

const ACTIVE_REVIEW_BATCH_STATES: readonly ResourceReviewBatchState[] = ['open', 'applying', 'failed']

export async function fetchResourceReviewBatchForPath(
  project: string,
  path: string
): Promise<ResourceReviewBatch | null> {
  for (const state of ACTIVE_REVIEW_BATCH_STATES) {
    let cursor = ''
    do {
      const page = await fetchResourceReviewBatches(project, state, cursor)
      if (!page) return null
      const batch = page.items.find((candidate) => candidate.members.some((member) => (
        member.path === path && member.state !== 'completed'
      )))
      if (batch) return batch
      cursor = page.next_cursor ?? ''
    } while (cursor)
  }
  return null
}

export async function fetchReviewMemberContent(
  project: string, batchId: string, fileId: string, side: 'base' | 'candidate' | 'current'
): Promise<Uint8Array | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/review-batches/${encodeURIComponent(batchId)}/members/${encodeURIComponent(fileId)}/${side}?${versionParams(project)}`,
      { credentials: 'include', cache: 'no-store' }
    )
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch { return null }
}

export async function fetchReviewMemberCurrent(
  project: string, batchId: string, fileId: string
): Promise<{ content: Uint8Array; revision: string | null } | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/review-batches/${encodeURIComponent(batchId)}/members/${encodeURIComponent(fileId)}/current?${versionParams(project)}`,
      { credentials: 'include', cache: 'no-store' }
    )
    return response.ok
      ? {
          content: new Uint8Array(await response.arrayBuffer()),
          revision: response.headers.get(CONTENT_REVISION_HEADER)
        }
      : null
  } catch { return null }
}

export async function decideResourceReviewBatch(
  project: string,
  batchId: string,
  decisions: readonly ResourceReviewBatchDecision[],
  idempotencyKey: string
): Promise<ResourceReviewBatchMutation> {
  try {
    const response = await fetch(
      `${base()}/api/resource/review-batches/${encodeURIComponent(batchId)}/commit?${versionParams(project)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ decisions: decisions.map((decision) => ({
          ...decision,
          revised_content: decision.revised_content ? reviewContentBase64(decision.revised_content) : undefined
        })) })
      }
    )
    const payload = await response.json().catch(() => null) as Omit<ResourceReviewBatchMutation, 'ok'> | null
    return response.ok
      ? { ok: true, batch: payload?.batch, results: payload?.results }
      : { ok: false, error: reviewBatchError(payload, response.status) }
  } catch { return { ok: false, error: NETWORK_ERROR } }
}

export interface ResourceVersionedFile {
  file_id: string
  path: string
  state: 'present' | 'tombstone'
  version_id: string
}

export interface ResourceVersionedPage {
  items: ResourceVersionedFile[]
  next_cursor: string | null
}

export async function fetchVersionedFiles(project: string, state: ResourceVersionedFile['state'],
  cursor?: string): Promise<ResourceVersionedPage | null> {
  const params = versionParams(project)
  params.set('state', state)
  if (cursor) params.set('after_file_id', cursor)
  try {
    const response = await fetch(`${base()}/api/resource/files?${params}`, { credentials: 'include', cache: 'no-store' })
    return response.ok ? await response.json() as ResourceVersionedPage : null
  } catch { return null }
}

export async function decideResourceReview(
  project: string, path: string, pending: ResourcePending, action: ResourceReviewAction,
  expectedDiskRevision: string | null, idempotencyKey: string
): Promise<ResourceMutation> {
  if (!pending.review) return { ok: false, error: 'review_not_found' }
  try {
    const response = await fetch(
      `${base()}/api/resource/files/${encodeURIComponent(pending.file_id)}/review/${action}?${versionParams(project)}`,
      { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ path, review_id: pending.review.id, pending_revision: pending.revision,
          expected_disk_revision: expectedDiskRevision }) }
    )
    const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null
    return response.ok ? { ok: true } : { ok: false, error: payload?.error?.code ?? `http_${response.status}` }
  } catch { return { ok: false, error: NETWORK_ERROR } }
}

export type ResourceReviewResolution = 'keep_current' | 'restore_candidate'
export interface ResourceReviewConflict {
  file_id: string
  review_id: string
  pending_revision: number
  disk: ResourceSnapshot
  token: string
}

export async function fetchResourceReviewConflict(project: string, fileId: string): Promise<ResourceReviewConflict | null> {
  try {
    const response = await fetch(`${base()}/api/resource/files/${encodeURIComponent(fileId)}/review/conflict?${versionParams(project)}`, { credentials: 'include', cache: 'no-store' })
    return response.ok ? await response.json() as ResourceReviewConflict : null
  } catch { return null }
}

export async function reconcileResourceReview(project: string, fileId: string,
  action: ResourceReviewResolution, token: string, key: string): Promise<ResourceMutation> {
  try {
    const response = await fetch(`${base()}/api/resource/files/${encodeURIComponent(fileId)}/review/reconcile?${versionParams(project)}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ action, token })
    })
    const result = await response.json().catch(() => null) as { error?: { code?: string } } | null
    return response.ok ? { ok: true } : { ok: false, error: result?.error?.code ?? `http_${response.status}` }
  } catch { return { ok: false, error: NETWORK_ERROR } }
}

export function reviewConflictMatches(preview: ResourceReviewConflict, pending: ResourcePending): boolean {
  return preview.file_id === pending.file_id && preview.review_id === pending.review?.id
    && preview.pending_revision === pending.revision
}

export async function fetchReviewBaseline(project: string, pending: ResourcePending): Promise<number[] | null> {
  if (!pending.review) return null
  try {
    const response = await fetch(`${base()}/api/resource/files/${encodeURIComponent(pending.file_id)}/review/${encodeURIComponent(pending.review.id)}/base?${versionParams(project)}`,
      { credentials: 'include', cache: 'no-store' })
    return response.ok ? Array.from(new Uint8Array(await response.arrayBuffer())) : null
  } catch { return null }
}

export interface ResourceVersion {
  id: string
  file_id: string
  sequence: number
  object_id: string | null
  annotation_object_id?: string | null
  state: 'present' | 'tombstone'
  path: string
  origin: string
  review_backup?: boolean
  created_at_ms: number
  session_id?: string | null
  turn_id?: string | null
  source_delivery_id: string | null
  restored_from_id?: string | null
  restored_from_sequence?: number | null
  alias?: string | null
  metadata_revision?: number
}

export interface ResourceVersionDeletePreview {
  version_id: string
  file_id: string
  sequence: number
  deletable: boolean
  blockers: string[]
  affected_delivery_ids: string[]
  preflight_token: string
}

export interface ResourceVersionAnnotations {
  schema_version: number
  annotations: Record<string, unknown>[]
}

export interface ResourceRestorePreview {
  version_id: string
  file_id: string
  path: string
  expected_revision: string | null
  observed_revision: string | null
  preflight_token: string
  conflict: boolean
  path_conflict?: boolean
}

export type ResourceRestoreMutation<T> =
  | { ok: true; result: T }
  | { ok: false; error: string }

export interface ResourceDelivery {
  id: string
  session_id: string
  turn_id: string
  created_at_ms: number
}

export interface ResourceDeliveryMember {
  file_id: string
  path: string
  change_kind: string
  before_version_id: string | null
  before_object_id: string | null
  after_version_id: string
  attribution: 'agent' | 'unknown'
}

export interface ResourceDeliveryEntry {
  delivery: ResourceDelivery
  members: ResourceDeliveryMember[]
}

export interface ResourceDeliveryRestoreMember {
  file_id: string
  path: string
  target_path: string
  expected_revision: string | null
  observed_revision: string | null
  conflict: boolean
}

export interface ResourceDeliveryRestorePreview {
  delivery_id: string
  members: ResourceDeliveryRestoreMember[]
  preflight_token: string
}

export interface ResourceDeliveryRestoreResult {
  versions: ResourceVersion[]
  skipped_file_ids: string[]
}

const base = (): string => window.scholarseed?.getApiBase() ?? ''
const WEB_SEARCH_SITE_ICON_PATH = '/api/resource/web-icon'

/** Build the local controlled-proxy URL used by search-result Avatar images. */
export function webSearchSiteIconUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    const params = new URLSearchParams({ url: parsed.origin })
    return `${base()}${WEB_SEARCH_SITE_ICON_PATH}?${params.toString()}`
  } catch {
    return undefined
  }
}

function versionParams(project: string, path?: string): URLSearchParams {
  const params = new URLSearchParams({ project })
  if (path) params.set('path', path)
  return params
}

export async function fetchVersionCapability(
  project: string,
  path: string
): Promise<ResourceCapability | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/capability?${versionParams(project, path)}`,
      { credentials: 'include', cache: 'no-store' }
    )
    return response.ok ? await response.json() as ResourceCapability : null
  } catch {
    return null
  }
}

export interface ResourceVersionPage {
  versions: ResourceVersion[]
  next_cursor: number | null
  total: number
}

export interface ResourceVersionQuery {
  cursor?: number
  q?: string
  origin?: string
  order?: 'newest' | 'oldest'
}

export async function fetchResourceVersions(
  project: string,
  fileId: string,
  cursorOrQuery?: number | ResourceVersionQuery
): Promise<ResourceVersionPage | null> {
  try {
    const params = versionParams(project)
    const query = typeof cursorOrQuery === 'number'
      ? { cursor: cursorOrQuery }
      : cursorOrQuery ?? {}
    if (query.cursor !== undefined) params.set('cursor', String(query.cursor))
    if (query.q) params.set('q', query.q)
    if (query.origin) params.set('origin', query.origin)
    if (query.order) params.set('order', query.order)
    const response = await fetch(
      `${base()}/api/resource/files/${encodeURIComponent(fileId)}/versions?${params}`,
      { credentials: 'include' }
    )
    if (!response.ok) return null
    return await response.json() as ResourceVersionPage
  } catch {
    return null
  }
}

export async function updateResourceVersionAlias(
  project: string,
  version: Pick<ResourceVersion, 'id' | 'metadata_revision'>,
  alias: string | null,
  idempotencyKey: string
): Promise<ResourceRestoreMutation<ResourceVersion>> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(version.id)}/metadata?${versionParams(project)}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ alias, expected_revision: version.metadata_revision ?? 0 })
      }
    )
    const payload = await response.json() as { version?: ResourceVersion; error?: { code?: string } }
    return response.ok && payload.version
      ? { ok: true, result: payload.version }
      : { ok: false, error: payload.error?.code ?? VERSION_ALIAS_FAILED }
  } catch { return { ok: false, error: NETWORK_ERROR } }
}

export async function previewResourceVersionDelete(
  project: string,
  versionId: string
): Promise<ResourceVersionDeletePreview | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(versionId)}/delete/preview?${versionParams(project)}`,
      { method: 'POST', credentials: 'include' }
    )
    return response.ok ? await response.json() as ResourceVersionDeletePreview : null
  } catch { return null }
}

export async function deleteResourceVersion(
  project: string,
  versionId: string,
  preflightToken: string,
  idempotencyKey: string
): Promise<ResourceRestoreMutation<{ remaining_count: number }>> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(versionId)}?${versionParams(project)}`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ preflight_token: preflightToken })
      }
    )
    const payload = await response.json() as { remaining_count?: number; error?: { code?: string } }
    return response.ok && typeof payload.remaining_count === 'number'
      ? { ok: true, result: { remaining_count: payload.remaining_count } }
      : { ok: false, error: payload.error?.code ?? VERSION_DELETE_FAILED }
  } catch { return { ok: false, error: NETWORK_ERROR } }
}

export async function fetchResourceVersionContent(
  project: string,
  versionId: string
): Promise<Uint8Array | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(versionId)}/content?${versionParams(project)}`,
      { credentials: 'include' }
    )
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null
  } catch {
    return null
  }
}

export async function fetchResourceVersionAnnotations(
  project: string,
  versionId: string
): Promise<ResourceVersionAnnotations | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(versionId)}/annotations?${versionParams(project)}`,
      { credentials: 'include' }
    )
    return response.ok ? await response.json() as ResourceVersionAnnotations : null
  } catch {
    return null
  }
}

export async function fetchResourceDeliveries(
  project: string
): Promise<ResourceDeliveryEntry[] | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/deliveries?${versionParams(project)}`,
      { credentials: 'include' }
    )
    if (!response.ok) return null
    const payload = await response.json() as { deliveries?: ResourceDeliveryEntry[] }
    return payload.deliveries ?? []
  } catch {
    return null
  }
}

export async function previewDeliveryRestore(
  project: string,
  deliveryId: string
): Promise<ResourceDeliveryRestorePreview | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/deliveries/${encodeURIComponent(deliveryId)}/revert/preview?${versionParams(project)}`,
      { method: 'POST', credentials: 'include' }
    )
    return response.ok ? await response.json() as ResourceDeliveryRestorePreview : null
  } catch {
    return null
  }
}

export async function restoreResourceDelivery(
  project: string,
  deliveryId: string,
  policy: 'strict' | 'force' | 'skip_conflicts',
  preflightToken: string
): Promise<ResourceRestoreMutation<ResourceDeliveryRestoreResult>> {
  try {
    const response = await fetch(
      `${base()}/api/resource/deliveries/${encodeURIComponent(deliveryId)}/revert?${versionParams(project)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ policy, preflight_token: preflightToken })
      }
    )
    const payload = await response.json().catch(() => null) as
      | ResourceDeliveryRestoreResult
      | { error?: { code?: string; message?: string } }
      | null
    if (!response.ok) {
      const error = payload && 'error' in payload ? payload.error : undefined
      return { ok: false, error: error?.code || error?.message || `http_${response.status}` }
    }
    return { ok: true, result: payload as ResourceDeliveryRestoreResult }
  } catch {
    return { ok: false, error: NETWORK_ERROR }
  }
}

export async function previewResourceRestore(
  project: string,
  versionId: string
): Promise<ResourceRestorePreview | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(versionId)}/restore/preview?${versionParams(project)}`,
      { method: 'POST', credentials: 'include' }
    )
    return response.ok ? await response.json() as ResourceRestorePreview : null
  } catch {
    return null
  }
}

export async function restoreResourceVersion(
  project: string,
  versionId: string,
  policy: 'strict' | 'force',
  preflightToken: string
): Promise<ResourceRestoreMutation<ResourceVersion>> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(versionId)}/restore?${versionParams(project)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ policy, preflight_token: preflightToken })
      }
    )
    const payload = await response.json().catch(() => null) as
      | { version?: ResourceVersion; error?: { code?: string; message?: string } }
      | null
    if (!response.ok) {
      return { ok: false, error: payload?.error?.code || payload?.error?.message || `http_${response.status}` }
    }
    return payload?.version
      ? { ok: true, result: payload.version }
      : { ok: false, error: 'invalid_restore_response' }
  } catch {
    return { ok: false, error: NETWORK_ERROR }
  }
}

export async function saveResourceVersionAs(
  project: string,
  versionId: string,
  name: string
): Promise<ResourceVersion | null> {
  try {
    const response = await fetch(
      `${base()}/api/resource/versions/${encodeURIComponent(versionId)}/save-as?${versionParams(project)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ target_dir: '', name })
      }
    )
    if (!response.ok) return null
    const payload = await response.json() as { version?: ResourceVersion }
    return payload.version ?? null
  } catch {
    return null
  }
}

export async function sealResourceVersion(
  project: string,
  path: string,
  origin: 'user' | 'external_confirmed' = 'user'
): Promise<boolean> {
  const capability = await fetchVersionCapability(project, path)
  if (!capability) return false
  return (await sealResourceSnapshot(project, path, capability, crypto.randomUUID(), origin)).ok
}

export async function sealResourceSnapshot(
  project: string, path: string, capability: ResourceCapability, idempotencyKey: string,
  origin: 'user' | 'external_confirmed' = 'user'
): Promise<ResourceMutation> {
  if (!capability.file_id || !capability.can_version) return { ok: false, error: 'version_management_disabled' }
  if (capability.drifted) return { ok: false, error: 'revision_conflict' }
  if (capability.pending?.review) return { ok: false, error: 'pending_review_requires_decision' }
  try {
    const response = await fetch(
      `${base()}/api/resource/files/${encodeURIComponent(capability.file_id)}/versions?${versionParams(project)}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          path,
          origin,
          expected_disk_revision: capability.disk_revision,
          expected_version_id: capability.version_id,
          expected_pending_revision: capability.pending?.revision ?? null
        })
      }
    )
    const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null
    return response.ok ? { ok: true } : { ok: false, error: payload?.error?.code ?? `http_${response.status}` }
  } catch {
    return { ok: false, error: NETWORK_ERROR }
  }
}

export async function sealExternalResourceVersion(project: string, path: string): Promise<boolean> {
  return sealResourceVersion(project, path, 'external_confirmed')
}

/** 浏览器/IPC 网络异常统一成稳定码，UI 不展示运行时英文异常。 */
const NETWORK_ERROR = 'network_error'
const VERSION_ALIAS_FAILED = 'version_alias_failed'
const VERSION_DELETE_FAILED = 'version_delete_failed'
const INVALID_IMPORT_RESPONSE = 'invalid_import_response'

/** payload → 前端模型，剥掉 null 以匹配可选字段语义。 */
function toLinkRoots(payload: ResourceTreePayload['linked_roots']): Record<string, ResourceLinkRoot> {
  return Object.fromEntries(Object.entries(payload ?? {}).map(([rootId, root]) => [rootId, {
    rootId: root.root_id,
    mountPath: root.mount_path,
    sourcePath: root.source_path
  }]))
}

function toNode(
  payload: ResourceNodePayload,
  linkedRoots: Record<string, ResourceLinkRoot> = {}
): ResourceNode {
  return {
    path: payload.path,
    source: payload.source,
    fileType: payload.file_type,
    updatedAt: payload.updated_at,
    name: payload.name,
    kind: payload.kind,
    count: payload.count ?? undefined,
    origin: payload.origin,
    ...(payload.git_repository ? { gitRepository: true } : {}),
    ...(payload.link_root_id && linkedRoots[payload.link_root_id]
      ? { linkRoot: linkedRoots[payload.link_root_id] }
      : {}),
    ...(payload.version
      ? { version: {
          managementState: payload.version.management_state,
          drifted: payload.version.drifted,
          snapshotState: payload.version.snapshot_state,
          pendingOrigin: payload.version.pending_origin,
          manualAdmitted: payload.version.manual_admitted ?? false,
          needsReview: payload.version.needs_review
        } }
      : {}),
    children: payload.children?.map((child) => toNode(child, linkedRoots))
  }
}

export async function fetchResourceAgentOrigin(
  project: string,
  path: string
): Promise<ResourceAgentOrigin | null> {
  const query = new URLSearchParams({ project, path })
  try {
    const response = await fetch(`${base()}/api/resource/agent-origin?${query.toString()}`, {
      credentials: 'include'
    })
    if (!response.ok) return null
    const payload = await response.json() as {
      source_kind: 'answer' | 'artifact'
      session_id: string
      session_deleted?: boolean
      turn_id: string | null
      item_id: string | null
      source_range?: ResourceAgentOrigin['sourceRange']
    } | null
    if (!payload?.session_id || !['answer', 'artifact'].includes(payload.source_kind)) return null
    return {
      sourceKind: payload.source_kind,
      sessionId: payload.session_id,
      sessionDeleted: payload.session_deleted === true,
      turnId: payload.turn_id,
      itemId: payload.item_id,
      ...(payload.source_range ? { sourceRange: payload.source_range } : {})
    }
  } catch {
    return null
  }
}

/** 统一的 POST + detail 码提取。 */
async function postJson(path: string, body: Record<string, unknown>): Promise<ResourceMutation> {
  try {
    const response = await fetch(`${base()}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string; node?: ResourceNodePayload }
      | null
    if (!response.ok) {
      return { ok: false, error: payload?.detail ?? `http_${response.status}` }
    }
    return { ok: true, node: payload?.node ? toNode(payload.node) : undefined }
  } catch {
    return { ok: false, error: NETWORK_ERROR }
  }
}

/**
 * 拉取资料树的一页。
 *
 * `path` 为空取资料库根，给了目录则取该目录下的子树；`offset` 取同一层的下一页。
 * 两个上限（深度、单层条数）都是取数分页，所以回来的 `total` 必须一起用上，
 * 否则没投影的条目在界面上就等于不存在。
 *
 * 失败返回 null（而不是空数组）——空数组会被 UI 当作「项目里确实没有资料」，
 * 与「请求失败」是两种不同状态，必须区分，否则用户看不出是网络问题。
 */
export async function fetchResourceListing(project: string): Promise<ResourceNode[] | null> {
  try {
    const response = await fetch(`${base()}/api/resource/list?${new URLSearchParams({ project })}`, {
      credentials: 'include', cache: 'no-store'
    })
    if (!response.ok) return null
    const payload = await response.json() as { items: ResourceNodePayload[]; linked_roots?: ResourceTreePayload['linked_roots'] }
    const roots = toLinkRoots(payload.linked_roots)
    return payload.items.map((item) => toNode(item, roots))
  } catch {
    return null
  }
}

export async function fetchResourceTree(
  project?: string | null,
  path?: string,
  offset = 0
): Promise<{ root: string; resourceRoot: string; nodes: ResourceNode[]; total: number; offset: number } | null> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (path) params.set('path', path)
  if (offset > 0) params.set('offset', String(offset))
  const query = params.toString()
  try {
    const response = await fetch(`${base()}/api/resource/tree${query ? `?${query}` : ''}`, {
      credentials: 'include',
      cache: 'no-store'
    })
    if (!response.ok) return null
    const payload = (await response.json()) as ResourceTreePayload
    const linkedRoots = toLinkRoots(payload.linked_roots)
    return {
      root: payload.root,
      resourceRoot: payload.resource_root,
      nodes: payload.nodes.map((node) => toNode(node, linkedRoots)),
      total: payload.total ?? payload.nodes.length,
      offset: payload.offset ?? 0
    }
  } catch {
    return null
  }
}

/**
 * 取一个项目的资料文件总数（首页项目卡上的「资料」计数）。
 *
 * 计数口径由后端的完整枚举给出，与资料库面板看到的集合同源。不要拿 `/tree` 的
 * 投影自己数：那个投影带深度与单层分页两个上限，数出来的是「本页看见多少」。
 *
 * 失败返回 null（而不是 0）——0 是「项目里确实没有资料」，与「没取到」是两种状态。
 */
export async function fetchResourceCount(project?: string | null): Promise<number | null> {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  const query = params.toString()
  try {
    const response = await fetch(`${base()}/api/resource/count${query ? `?${query}` : ''}`, {
      credentials: 'include'
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { files?: number }
    return typeof payload.files === 'number' ? payload.files : null
  } catch {
    return null
  }
}

/** 读取文本资料内容，供 Markdown 双视图使用。失败返回 null。 */
export async function fetchResourceContent(
  path: string,
  project?: string | null
): Promise<string | null> {
  const params = new URLSearchParams({ path })
  if (project) params.set('project', project)
  try {
    const response = await fetch(`${base()}/api/resource/read?${params.toString()}`, {
      credentials: 'include'
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { content: string }
    return payload.content
  } catch {
    return null
  }
}

/** 保存文本资料（PRD「源码/渲染编辑视图」的落盘）。 */
export const saveResourceContent = (
  path: string,
  content: string,
  project?: string | null
): Promise<ResourceMutation> =>
  postJson('/api/resource/write', { path, content, project: project ?? null })

/**
 * 项目内文件的字节流 URL（PDF / 图片预览用）。
 *
 * 给 `<iframe>` / `<img>` 的 src 直接用，不走 fetch：
 * PDF 交由 Chromium 内置插件渲染，它需要一个真实 URL 而不是 blob。
 */
export function resourceRawUrl(path: string, project?: string | null): string {
  const params = new URLSearchParams({ path })
  if (project) params.set('project', project)
  return `${base()}/api/resource/raw?${params.toString()}`
}

/** 资料搜索（PRD「资料搜索」：文件名或关键词）。失败返回 null。 */
export async function searchResources(
  query: string,
  project?: string | null
): Promise<ResourceSearchHit[] | null> {
  const params = new URLSearchParams({ q: query })
  if (project) params.set('project', project)
  try {
    const response = await fetch(`${base()}/api/resource/search?${params.toString()}`, {
      credentials: 'include'
    })
    if (!response.ok) return null
    const payload = (await response.json()) as { hits: ResourceSearchHit[] }
    return payload.hits
  } catch {
    return null
  }
}

/** 新建/重命名/移动/复制（PRD「资料新建」「资料管理」）。 */
export const mutateResourceNode = (
  action: NodeAction,
  input: {
    path?: string
    parent?: string
    name?: string
    targetDir?: string | null
    content?: string
  },
  project?: string | null
): Promise<ResourceMutation> =>
  postJson('/api/resource/node', {
    action,
    path: input.path ?? '',
    parent: input.parent ?? '',
    name: input.name ?? '',
    target_dir: input.targetDir ?? null,
    ...(input.content === undefined ? {} : { content: input.content }),
    project: project ?? null
  })

/** 导入本地文件/文件夹（PRD「资料导入」：复制 or 关联）。 */
export async function importResources(
  mode: 'copy' | 'link',
  sources: string[],
  targetDir: string,
  project?: string | null,
  resolution?: ResourceImportResolution
): Promise<ResourceImportMutation> {
  try {
    const response = await fetch(`${base()}/api/resource/import`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(resolution ? { 'Idempotency-Key': resolution.idempotencyKey } : {})
      },
      body: JSON.stringify({
        mode,
        sources,
        target_dir: targetDir,
        project: project ?? null,
        ...(resolution
          ? {
              plan_token: resolution.planToken,
              decisions: resolution.sourceIndexes.map((sourceIndex) => ({
                source_index: sourceIndex,
                action: resolution.action
              }))
            }
          : {})
      })
    })
    const payload = (await response.json().catch(() => null)) as
      | {
          detail?: string
          status?: 'completed' | 'needs_resolution'
          project_id?: string
          plan_token?: string
          conflicts?: Array<{
            source_index: number
            source_name: string
            source_kind: 'file' | 'dir'
            target_path: string
            target_kind: 'file' | 'dir' | null
            suggested_name: string
            expected_target_revision: string | null
            can_replace_with_version: boolean
          }>
          imported?: ResourceNodePayload[]
        }
      | null
    if (!response.ok) return { ok: false, error: payload?.detail ?? `http_${response.status}` }
    if (payload?.status === 'needs_resolution' && payload.plan_token) {
      return {
        ok: true,
        status: 'needs_resolution',
        planToken: payload.plan_token,
        conflicts: (payload.conflicts ?? []).map((item) => ({
          sourceIndex: item.source_index,
          sourceName: item.source_name,
          sourceKind: item.source_kind,
          targetPath: item.target_path,
          targetKind: item.target_kind,
          suggestedName: item.suggested_name,
          expectedTargetRevision: item.expected_target_revision,
          canReplaceWithVersion: item.can_replace_with_version
        }))
      }
    }
    if (!payload?.project_id) return { ok: false, error: INVALID_IMPORT_RESPONSE }
    return {
      ok: true,
      status: 'completed',
      projectId: payload.project_id,
      imported: (payload?.imported ?? []).map((node) => toNode(node))
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : NETWORK_ERROR }
  }
}

/** 抓取选中的 HTML 网页，逐项转换为 Markdown 并写入当前项目资料库。 */
export async function importWebResources(
  project: string,
  query: string,
  candidates: WebImportCandidate[],
  parent = ''
): Promise<WebImportMutation> {
  try {
    const response = await fetch(`${base()}/api/resource/web-import`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, query, parent, candidates })
    })
    const payload = (await response.json().catch(() => null)) as
      | {
          detail?: unknown
          succeeded?: number
          failed?: number
          items?: Array<{
            title: string
            url: string
            status: 'success' | 'failed'
            final_url?: string
            node?: ResourceNodePayload
            error?: string
          }>
        }
      | null
    if (!response.ok) {
      return {
        ok: false,
        succeeded: 0,
        failed: candidates.length,
        items: [],
        error: webImportRequestError(payload, response.status)
      }
    }
    const items = (payload?.items ?? []).map((item): WebImportItem => ({
      title: item.title,
      url: item.url,
      status: item.status,
      finalUrl: item.final_url,
      node: item.node ? toNode(item.node) : undefined,
      error: item.error
    }))
    return {
      ok: true,
      succeeded: payload?.succeeded ?? items.filter((item) => item.status === 'success').length,
      failed: payload?.failed ?? items.filter((item) => item.status === 'failed').length,
      items
    }
  } catch (error) {
    return {
      ok: false,
      succeeded: 0,
      failed: candidates.length,
      items: [],
      error: error instanceof Error ? error.message : 'network_error'
    }
  }
}

/** 把同一文献的一批 PDF 选区聚合写入一份可溯源 Markdown 资料。 */
export async function importLiteratureExcerpts(
  input: LiteratureExcerptImportInput
): Promise<LiteratureExcerptImportMutation> {
  const location = input.parent || input.name
    ? {
        ...(input.parent ? { parent: input.parent } : {}),
        ...(input.name ? { name: input.name } : {})
      }
    : undefined
  try {
    const response = await fetch(`${base()}/api/resource/excerpts`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: input.project,
        ...(location ? { location } : {}),
        source: {
          kind: LITERATURE_EXCERPT_SOURCE_KIND,
          literature_id: input.literatureId,
          ...(input.documentRevision ? { document_revision: input.documentRevision } : {})
        },
        selections: input.selections.map((selection) => ({
          text: selection.text,
          locator: {
            kind: PDF_EXCERPT_LOCATOR_KIND,
            page: selection.locator.page,
            ...(selection.locator.quads?.length
              ? { quads: selection.locator.quads.map((quad) => [...quad]) }
              : {})
          }
        }))
      })
    })
    const payload = (await response.json().catch(() => null)) as
      | {
          detail?: string
          operation?: 'created' | 'updated'
          node?: ResourceNodePayload
          literature_id?: string
          added?: number
          skipped?: number
          total?: number
        }
      | null
    if (!response.ok) return { ok: false, error: payload?.detail ?? `http_${response.status}` }
    if (
      !payload?.operation
      || !payload.node
      || !payload.literature_id
      || typeof payload.added !== 'number'
      || typeof payload.skipped !== 'number'
      || typeof payload.total !== 'number'
    ) return { ok: false, error: 'invalid_excerpt_response' }
    return {
      ok: true,
      operation: payload.operation,
      node: toNode(payload.node),
      literatureId: payload.literature_id,
      added: payload.added,
      skipped: payload.skipped,
      total: payload.total
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'network_error'
    }
  }
}

/**
 * 删除前向后端签发一次性删除令牌（PRD「删除」+ proposal 47 §6.6）。
 *
 * 渲染层只拿令牌：绝对路径不经过它，兑换只有 Electron 主进程能做。真正的删除
 * 走系统废纸篓，保证可恢复。
 */
export async function issueTrashToken(
  path: string,
  project?: string | null
): Promise<{ ok: boolean; error?: string; token?: string }> {
  try {
    const response = await fetch(`${base()}/api/content/trash-token`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, project: project ?? null })
    })
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string; token?: string }
      | null
    if (!response.ok) return { ok: false, error: payload?.detail ?? `http_${response.status}` }
    return { ok: true, token: payload?.token }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network_error' }
  }
}

/** 取「在访达中打开」所需的绝对路径（PRD「在访达中打开」）。 */
export async function resolveRevealTarget(
  path: string,
  project?: string | null
): Promise<{ ok: boolean; error?: string; absolute?: string }> {
  try {
    const response = await fetch(`${base()}/api/resource/reveal`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, project: project ?? null })
    })
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string; absolute?: string }
      | null
    if (!response.ok) return { ok: false, error: payload?.detail ?? `http_${response.status}` }
    return { ok: true, absolute: payload?.absolute }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network_error' }
  }
}

const VERSION_ADMISSION_FAILED = 'version_admission_failed'
const VERSION_ADMISSION_NETWORK_ERROR = 'network_error'

export async function admitResourceVersion(project: string, path: string, diskRevision: string, idempotencyKey: string): Promise<{ ok: true; capability: ResourceCapability } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${base()}/api/serve/resources/version-admission?${new URLSearchParams({ project })}`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ path, expected_disk_revision: diskRevision })
    })
    const payload = await response.json() as { capability?: ResourceCapability; error?: { code?: string } }
    return response.ok && payload.capability ? { ok: true, capability: payload.capability } : { ok: false, error: payload.error?.code ?? VERSION_ADMISSION_FAILED }
  } catch { return { ok: false, error: VERSION_ADMISSION_NETWORK_ERROR } }
}
