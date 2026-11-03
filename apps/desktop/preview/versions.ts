import { createHash, randomUUID } from 'node:crypto'
import type { ResourceCapability, ResourcePending, ResourceSnapshot, ResourceVersion, ResourceVersionQuery } from '../src/renderer/src/features/resources/api.ts'
import { PREVIEW_DOCUMENTS } from './documents.ts'
import type { PreviewFiles, PreviewFileContent } from './files.ts'
import { PreviewFileError, PREVIEW_FILE_ERROR } from './files.ts'
import { previewDocumentFormat } from './samples.ts'

const POLICY = { defaultLimit: 50, maxLimit: 100, maxQuery: 200, maxFileBytes: 1024 * 1024, maxVersions: 50, maxStoredBytes: 64 * 1024 * 1024, maxReceipts: 128 } as const
const ORIGINS = ['initial_scan', 'user', 'external_confirmed', 'agent', 'restore', 'delivery_revert'] as const
const SUPPORTED_SUFFIXES = new Set(PREVIEW_DOCUMENTS.filter(document => !['image', 'unsupported'].includes(document.viewer)).map(document => document.path.split('.').pop()))
export const PREVIEW_VERSION_SETTINGS = {
  mode: 'whitelist', migration_required: false,
  max_versions_per_file: POLICY.maxVersions, max_file_size_kb: POLICY.maxFileBytes / 1024,
  include_patterns: [...SUPPORTED_SUFFIXES].map(suffix => `*.${suffix}`), ignore_patterns: [],
  common_patterns: [...SUPPORTED_SUFFIXES].map(suffix => `*.${suffix}`),
} as const

export function previewVersionRange(value: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || size <= 0 || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffix = BigInt(match[2])
    return suffix > 0 ? [suffix >= BigInt(size) ? 0 : size - Number(suffix), size - 1] : null
  }
  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : BigInt(size - 1)
  if (start >= BigInt(size) || end < start) return null
  return [Number(start), end >= BigInt(size) ? size - 1 : Number(end)]
}

export class PreviewVersionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

interface FileVersions {
  versions: ResourceVersion[]
  workingRevision: string
  pending: ResourcePending | null
  pendingSequence: number
}

interface SealResult { version: ResourceVersion; unchanged: boolean }

export class PreviewVersions {
  private files = new Map<string, FileVersions>()
  private contents = new Map<string, ResourceVersion>()
  private objects = new Map<string, Uint8Array>()
  private receipts = new Map<string, { digest: string; result: SealResult }>()
  private storedBytes = 0

  constructor(private readonly vfs: PreviewFiles, changes: readonly { path: string; bytes: Uint8Array }[] = []) {
    for (const entry of vfs.manifest()) {
      const file = vfs.read(entry.path)
      if (this.supports(file)) this.capture(file, 'initial_scan')
    }
    for (const change of changes) {
      vfs.write(change.path, change.bytes)
      this.capture(vfs.read(change.path), 'user')
    }
  }

  private supports(file: PreviewFileContent): boolean {
    return this.supportsPath(file.path, file.bytes)
  }

  private supportsPath(path: string, bytes: Uint8Array): boolean {
    return SUPPORTED_SUFFIXES.has(path.toLowerCase().split('.').pop()) && previewDocumentFormat(path, bytes).viewer !== 'unsupported'
  }

  write(path: string, bytes: Uint8Array) {
    let identity: string | undefined
    try { identity = this.vfs.fileInfo(path).identity }
    catch (error) { if (!(error instanceof PreviewFileError) || error.code !== PREVIEW_FILE_ERROR.notFound) throw error }
    if (this.supportsPath(path, bytes)) {
      if (bytes.length > POLICY.maxFileBytes) throw new PreviewVersionError(413, 'file_too_large')
      if ((!identity || !this.files.has(identity)) && this.storedBytes + bytes.length > POLICY.maxStoredBytes) throw new PreviewVersionError(503, 'preview_version_capacity')
    }
    const entry = this.vfs.write(path, bytes)
    this.observe(entry.path)
    return entry
  }

  private capture(file: PreviewFileContent, origin: string): ResourceVersion {
    const record = this.files.get(file.identity)
    if (file.bytes.length > POLICY.maxFileBytes) throw new PreviewVersionError(413, 'file_too_large')
    if ((record?.versions.length ?? 0) >= POLICY.maxVersions) throw new PreviewVersionError(503, 'preview_version_capacity')
    this.storeSnapshot(file.path, file.bytes)
    const version: ResourceVersion = {
      id: randomUUID(), file_id: file.identity, sequence: (record?.versions.length ?? 0) + 1,
      object_id: file.revision, annotation_object_id: null, state: 'present', path: file.path,
      origin, created_at_ms: Date.now(), source_delivery_id: null, session_id: null, turn_id: null,
      alias: null, metadata_revision: 0, review_backup: false,
    }
    this.contents.set(version.id, version)
    this.files.set(file.identity, { versions: [...(record?.versions ?? []), version], workingRevision: file.revision, pending: null, pendingSequence: record?.pendingSequence ?? 0 })
    return { ...version }
  }

  capability(path: string): ResourceCapability & { path: string; managed: boolean; max_size_bytes: number } {
    const file = this.vfs.read(path)
    const record = this.files.get(file.identity)
    const version = record?.versions[record.versions.length - 1]
    const supported = this.supports(file)
    const format = previewDocumentFormat(path, file.bytes)
    return {
      path: file.path, managed: !!record, max_size_bytes: POLICY.maxFileBytes,
      file_id: record ? file.identity : null, version_id: version?.id ?? null,
      working_revision: record?.workingRevision ?? null, disk_revision: file.revision,
      manual_admitted: false, can_version: supported,
      can_diff: supported && (format.viewer === 'markdown' || format.viewer === 'code'),
      can_preview_history: supported && !!record, management_state: supported ? 'managed' : 'unsupported',
      drifted: !!record && file.revision !== record.workingRevision,
      snapshot_state: record && !record.pending ? 'saved' : 'pending', pending: record?.pending ? structuredClone(record.pending) : null,
    }
  }

  observe(path: string): void {
    const file = this.vfs.read(path)
    if (!this.supports(file)) return
    const record = this.files.get(file.identity)
    if (!record) { this.capture(file, 'initial_scan'); return }
    if (record.workingRevision === file.revision) return
    record.workingRevision = file.revision
    record.pendingSequence++
    if (record.pending?.review) {
      record.pending = { ...record.pending, revision: record.pendingSequence, review: { ...record.pending.review, edited_by_user: true } }
      return
    }
    record.pending = record.versions[record.versions.length - 1].object_id === file.revision ? null
      : { file_id: file.identity, revision: record.pendingSequence, origin: 'user', review: null }
  }

  history(fileId: string, query: Omit<ResourceVersionQuery, 'order'> & { limit?: number; order?: string } = {}) {
    const limit = query.limit ?? POLICY.defaultLimit
    const order = query.order ?? 'newest'
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > POLICY.maxLimit || (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || query.cursor < 1)) || Array.from(query.q ?? '').length > POLICY.maxQuery) throw new PreviewVersionError(422, 'invalid_version_query')
    if (!['newest', 'oldest'].includes(order)) throw new PreviewVersionError(422, 'invalid_version_order')
    if (query.origin && !(ORIGINS as readonly string[]).includes(query.origin)) throw new PreviewVersionError(422, 'invalid_version_origin')
    const search = query.q?.trim().toLowerCase()
    const matching = (this.files.get(fileId)?.versions ?? []).filter(version => (!query.origin || version.origin === query.origin) && (!search || [version.path, version.origin, version.alias, version.turn_id, `v${version.sequence}`].some(value => value?.toLowerCase().includes(search))))
    const selected = matching.filter(version => query.cursor === undefined || (order === 'oldest' ? version.sequence > query.cursor : version.sequence < query.cursor)).sort((left, right) => order === 'oldest' ? left.sequence - right.sequence : right.sequence - left.sequence).slice(0, limit)
    return { file_id: fileId, versions: selected.map(version => ({ ...version })), next_cursor: selected.length === limit ? selected[selected.length - 1].sequence : null, total: matching.length }
  }

  content(versionId: string) {
    const stored = this.contents.get(versionId)
    if (!stored) throw new PreviewVersionError(404, 'version_not_found')
    const snapshot = this.readSnapshot({ object_id: stored.object_id, state: stored.state, path: stored.path, mode_bits: null, annotation_object_id: null })
    return { version: { ...stored }, bytes: snapshot.bytes, mediaType: snapshot.mediaType }
  }

  private storeSnapshot(path: string, bytes: Uint8Array): ResourceSnapshot {
    const objectId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (bytes.length > POLICY.maxFileBytes) throw new PreviewVersionError(413, 'file_too_large')
    if (!this.objects.has(objectId)) {
      if (this.storedBytes + bytes.length > POLICY.maxStoredBytes) throw new PreviewVersionError(503, 'preview_version_capacity')
      this.objects.set(objectId, new Uint8Array(bytes))
      this.storedBytes += bytes.length
    }
    return { object_id: objectId, state: 'present', path, mode_bits: null, annotation_object_id: null }
  }

  readSnapshot(snapshot: ResourceSnapshot): { bytes: Uint8Array; mediaType: string; revision: string | null } {
    if (snapshot.state === 'tombstone' || snapshot.object_id === null) return { bytes: new Uint8Array(), mediaType: 'application/octet-stream', revision: null }
    const bytes = this.objects.get(snapshot.object_id)
    if (!bytes) throw new PreviewVersionError(404, 'version_not_found')
    return { bytes: new Uint8Array(bytes), mediaType: previewDocumentFormat(snapshot.path, bytes).mediaType, revision: snapshot.object_id }
  }

  pending(fileId: string): ResourcePending | null {
    return structuredClone(this.files.get(fileId)?.pending ?? null)
  }

  current(fileId: string): { snapshot: ResourceSnapshot; bytes: Uint8Array; mediaType: string; revision: string | null } {
    const record = this.files.get(fileId)
    if (!record) throw new PreviewVersionError(404, 'file_not_managed')
    const entry = this.vfs.manifest().find(entry => entry.identity === fileId)
    if (!entry) {
      const path = record.pending?.review?.candidate.path ?? record.versions[record.versions.length - 1].path
      return { snapshot: { object_id: null, state: 'tombstone', path, mode_bits: null, annotation_object_id: null }, bytes: new Uint8Array(), mediaType: 'application/octet-stream', revision: null }
    }
    const file = this.vfs.read(entry.path)
    return { snapshot: { object_id: file.revision, state: 'present', path: file.path, mode_bits: null, annotation_object_id: null }, bytes: file.bytes, mediaType: previewDocumentFormat(file.path, file.bytes).mediaType, revision: file.revision }
  }

  startReview(path: string, bytes: Uint8Array, context: { id: string; group_id: string; session_id: string; turn_id: string; origin?: 'agent' | 'external' }): ResourcePending {
    const file = this.vfs.read(path)
    const record = this.files.get(file.identity)
    if (!record) throw new PreviewVersionError(404, 'file_not_managed')
    if (record.pending || record.workingRevision !== file.revision) throw new PreviewVersionError(409, 'pending_review_requires_decision')
    const base = { object_id: file.revision, state: 'present' as const, path: file.path, mode_bits: null, annotation_object_id: null }
    const candidate = this.storeSnapshot(file.path, bytes)
    const written = this.vfs.write(file.path, bytes)
    record.workingRevision = written.revision
    record.pendingSequence++
    record.pending = { file_id: file.identity, revision: record.pendingSequence, origin: context.origin ?? 'agent', review: {
      id: context.id, group_id: context.group_id, session_id: context.session_id, first_turn_id: context.turn_id, turn_id: context.turn_id,
      terminal_outcome: 'completed', origin: context.origin ?? 'agent', base, candidate,
      base_revision: base.object_id, candidate_revision: candidate.object_id, edited_by_user: false,
    } }
    return structuredClone(record.pending)
  }

  reconcileReview(fileId: string, reviewId: string, revision: number, action: 'keep_current' | 'restore_candidate', expected: string | null): ResourcePending {
    const pending = this.pending(fileId)
    if (!pending?.review || pending.review.id !== reviewId || pending.revision !== revision) throw new PreviewVersionError(409, 'review_batch_member_conflict')
    const current = this.current(fileId)
    if (current.revision !== expected) throw new PreviewVersionError(409, 'preflight_stale')
    if (current.revision === null) throw new PreviewVersionError(409, 'restore_conflict')
    const record = this.files.get(fileId)!
    if (action === 'restore_candidate') {
      const candidate = this.readSnapshot(pending.review.candidate)
      this.vfs.write(current.snapshot.path, candidate.bytes)
      record.workingRevision = pending.review.candidate_revision!
    } else record.workingRevision = current.revision
    record.pendingSequence++
    record.pending = { ...pending, revision: record.pendingSequence, review: { ...pending.review, edited_by_user: action === 'keep_current' } }
    return structuredClone(record.pending)
  }

  resolveReview(fileId: string, reviewId: string, revision: number, action: 'accept' | 'reject' | 'revise', expected: string | null, revised?: Uint8Array): ResourceVersion | null {
    const pending = this.pending(fileId)
    if (!pending?.review || pending.review.id !== reviewId || pending.revision !== revision) throw new PreviewVersionError(409, 'review_batch_member_conflict')
    const current = this.current(fileId)
    if (current.revision !== expected) throw new PreviewVersionError(409, 'review_disk_revision_conflict')
    if (current.revision === null) throw new PreviewVersionError(409, 'restore_conflict')
    const record = this.files.get(fileId)!
    const bytes = action === 'reject' ? this.readSnapshot(pending.review.base).bytes : action === 'accept' ? this.readSnapshot(pending.review.candidate).bytes : revised ?? current.bytes
    if (action !== 'reject' && record.versions.length >= POLICY.maxVersions) throw new PreviewVersionError(503, 'preview_version_capacity')
    this.storeSnapshot(current.snapshot.path, bytes)
    const written = this.vfs.write(current.snapshot.path, bytes)
    if (action === 'reject') { record.workingRevision = written.revision; record.pending = null; return null }
    return this.capture(this.vfs.read(current.snapshot.path), 'user')
  }

  seal(fileId: string, input: Record<string, unknown>, key: string): SealResult {
    if (!key) throw new PreviewVersionError(400, 'idempotency_key_required')
    const fields = ['expected_disk_revision', 'expected_version_id', 'expected_pending_revision'] as const
    if (typeof input.path !== 'string' || !input.path || fields.some(field => !(field in input))
      || fields.slice(0, 2).some(field => input[field] !== null && (typeof input[field] !== 'string' || !input[field]))
      || (input.expected_pending_revision !== null && (!Number.isSafeInteger(input.expected_pending_revision) || Number(input.expected_pending_revision) < 1))) throw new PreviewVersionError(400, 'invalid_snapshot_fence')
    const origin = input.origin ?? 'user'
    if (origin !== 'user' && origin !== 'external_confirmed') throw new PreviewVersionError(400, 'invalid_origin')
    const requestDigest = JSON.stringify([fileId, input.path, origin, ...fields.map(field => input[field])])
    const receipt = this.receipts.get(key)
    if (receipt) {
      if (receipt.digest !== requestDigest) throw new PreviewVersionError(409, 'idempotency_conflict')
      return { ...receipt.result, version: { ...receipt.result.version } }
    }
    const file = this.vfs.read(input.path)
    const record = this.files.get(fileId)
    if (file.identity !== fileId || !record) throw new PreviewVersionError(404, 'file_not_managed')
    if (!this.supports(file)) throw new PreviewVersionError(409, 'version_management_disabled')
    if (record.pending?.review) throw new PreviewVersionError(409, 'pending_review_requires_decision')
    if (input.expected_disk_revision !== file.revision) throw new PreviewVersionError(412, 'revision_conflict')
    if (input.expected_version_id !== record.versions[record.versions.length - 1].id || input.expected_pending_revision !== (record.pending?.revision ?? null)) throw new PreviewVersionError(412, 'version_head_conflict')
    if (this.receipts.size >= POLICY.maxReceipts) throw new PreviewVersionError(503, 'preview_version_capacity')
    const unchanged = record.versions[record.versions.length - 1].object_id === file.revision
    const result = { version: unchanged ? { ...record.versions[record.versions.length - 1] } : this.capture(file, origin), unchanged }
    this.receipts.set(key, { digest: requestDigest, result })
    return { ...result, version: { ...result.version } }
  }
}
