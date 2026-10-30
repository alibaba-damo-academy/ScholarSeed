import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { ResourceReviewAction, ResourceReviewBatch, ResourceReviewBatchResult, ResourceReviewBatchState, ResourceReviewConflict } from '../src/renderer/src/features/resources/api.ts'
import { PreviewVersionError, PreviewVersions } from './versions.ts'

const POLICY = { maxBatches: 32, maxMembers: 20, maxRequests: 128, defaultLimit: 50, maxLimit: 100, maxDraftBytes: 1024 * 1024 } as const
const ACTIONS: readonly ResourceReviewAction[] = ['accept', 'reject', 'revise']
const STATES: readonly ResourceReviewBatchState[] = ['open', 'applying', 'completed', 'failed']

interface Decision {
  file_id: string
  review_id: string
  pending_revision: number
  action: ResourceReviewAction
  expected_disk_revision: string | null
  revised_content?: Uint8Array
}

interface Result { batch: ResourceReviewBatch; results: ResourceReviewBatchResult[] }

export class PreviewReviewError extends PreviewVersionError {}

function invalid(): never { throw new PreviewReviewError(422, 'invalid_review_batch_request') }

function decision(value: unknown): Decision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const raw = value as Record<string, unknown>
  if (typeof raw.file_id !== 'string' || !raw.file_id || typeof raw.review_id !== 'string' || !raw.review_id
    || !Number.isSafeInteger(raw.pending_revision) || Number(raw.pending_revision) < 1
    || !(ACTIONS as readonly unknown[]).includes(raw.action) || !('expected_disk_revision' in raw)
    || (raw.expected_disk_revision !== null && typeof raw.expected_disk_revision !== 'string')) return invalid()
  let revised: Uint8Array | undefined
  if (raw.revised_content !== undefined) {
    if (raw.action !== 'revise' || typeof raw.revised_content !== 'string' || raw.revised_content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.revised_content)) return invalid()
    const bytes = Buffer.from(raw.revised_content, 'base64')
    if (bytes.toString('base64') !== raw.revised_content || bytes.length > POLICY.maxDraftBytes) return invalid()
    revised = new Uint8Array(bytes)
  }
  return { file_id: raw.file_id, review_id: raw.review_id, pending_revision: Number(raw.pending_revision), action: raw.action as ResourceReviewAction, expected_disk_revision: raw.expected_disk_revision as string | null, ...(revised === undefined ? {} : { revised_content: revised }) }
}

export class PreviewReviews {
  private batches = new Map<string, ResourceReviewBatch>()
  private requests = new Map<string, { digest: string; result?: Result | { ok: true } }>()
  private secret = randomUUID()
  private failNext: boolean

  constructor(private readonly versions: PreviewVersions, options: { failOnce?: boolean } = {}) { this.failNext = options.failOnce ?? false }

  create(input: { session_id: string; turn_id: string; changes: readonly { path: string; bytes: Uint8Array }[] }): ResourceReviewBatch {
    if (!input.session_id || !input.turn_id || !input.changes.length || input.changes.length > POLICY.maxMembers) return invalid()
    if (this.batches.size >= POLICY.maxBatches) throw new PreviewReviewError(503, 'preview_review_capacity')
    const capabilities = input.changes.map(change => this.versions.capability(change.path))
    if (new Set(capabilities.map(capability => capability.file_id)).size !== input.changes.length) throw new PreviewReviewError(409, 'review_batch_members_mismatch')
    if (capabilities.some(capability => !capability.file_id || capability.pending || capability.drifted || !capability.can_version)) throw new PreviewReviewError(409, 'pending_review_requires_decision')
    const id = randomUUID()
    const group = randomUUID()
    const now = Date.now()
    const members = input.changes.map(change => {
      const pending = this.versions.startReview(change.path, change.bytes, { id: randomUUID(), group_id: group, session_id: input.session_id, turn_id: input.turn_id })
      const review = pending.review!
      return { file_id: pending.file_id, review_id: review.id, path: change.path, pending_revision: pending.revision, state: 'pending' as const, origin: review.origin, action: null, error: null, base: review.base, candidate: review.candidate, base_revision: review.base_revision, candidate_revision: review.candidate_revision, edited_by_user: false, result_version_id: null }
    })
    const batch: ResourceReviewBatch = { id, session_id: input.session_id, turn_id: input.turn_id, group_id: group, state: 'open', created_at_ms: now, updated_at_ms: now, members }
    this.batches.set(id, batch)
    return structuredClone(batch)
  }

  private stored(id: string): ResourceReviewBatch {
    const batch = this.batches.get(id)
    if (!batch) throw new PreviewReviewError(404, 'review_batch_not_found')
    for (const member of batch.members) {
      if (member.state === 'completed') continue
      const pending = this.versions.pending(member.file_id)
      if (pending?.review?.id === member.review_id) Object.assign(member, { pending_revision: pending.revision, edited_by_user: pending.review.edited_by_user, base: pending.review.base, candidate: pending.review.candidate, base_revision: pending.review.base_revision, candidate_revision: pending.review.candidate_revision })
    }
    return batch
  }

  batch(id: string): ResourceReviewBatch { return structuredClone(this.stored(id)) }

  list(query: { state?: string; after_batch_id?: string; limit?: number } = {}) {
    const limit = query.limit ?? POLICY.defaultLimit
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > POLICY.maxLimit || (query.state !== undefined && !(STATES as readonly string[]).includes(query.state))) throw new PreviewReviewError(422, 'invalid_review_batch_request')
    const matching = [...this.batches.keys()].sort().map(id => this.batch(id)).filter(batch => (!query.state || batch.state === query.state) && (!query.after_batch_id || batch.id > query.after_batch_id))
    const items = matching.slice(0, limit)
    return { items, next_cursor: matching.length > limit ? items[items.length - 1].id : null }
  }

  content(batchId: string, fileId: string, kind: string) {
    const member = this.stored(batchId).members.find(member => member.file_id === fileId)
    if (!member) throw new PreviewReviewError(404, 'review_batch_member_not_found')
    if (kind === 'current') return this.versions.current(fileId)
    if (kind !== 'base' && kind !== 'candidate') throw new PreviewReviewError(422, 'invalid_review_content')
    return this.versions.readSnapshot(member[kind])
  }

  private request(key: string, digest: string) {
    if (!key) throw new PreviewReviewError(400, 'idempotency_key_required')
    const previous = this.requests.get(key)
    if (previous) {
      if (previous.digest !== digest) throw new PreviewReviewError(409, 'idempotency_conflict')
      return previous
    }
    if (this.requests.size >= POLICY.maxRequests) throw new PreviewReviewError(503, 'preview_review_capacity')
    const request = { digest } as { digest: string; result?: Result | { ok: true } }
    this.requests.set(key, request)
    return request
  }

  commit(batchId: string, body: Record<string, unknown>, key: string): Result {
    if (!Array.isArray(body.decisions) || !body.decisions.length || body.decisions.length > POLICY.maxMembers) return invalid()
    const decisions = body.decisions.map(decision).sort((left, right) => left.file_id.localeCompare(right.file_id))
    const batch = this.stored(batchId)
    if (new Set(decisions.map(item => item.file_id)).size !== decisions.length || decisions.length !== batch.members.length || decisions.some(item => !batch.members.some(member => member.file_id === item.file_id))) throw new PreviewReviewError(409, 'review_batch_members_mismatch')
    const digest = createHash('sha256').update(JSON.stringify(['commit', batchId, decisions])).digest('hex')
    const request = this.request(key, digest)
    if (request.result) return structuredClone(request.result as Result)
    for (const item of decisions) {
      const member = batch.members.find(member => member.file_id === item.file_id)!
      if (member.state === 'completed') {
        if (member.action !== item.action) throw new PreviewReviewError(409, 'review_batch_decision_conflict')
        continue
      }
      if (member.review_id !== item.review_id || member.pending_revision !== item.pending_revision) throw new PreviewReviewError(409, 'review_batch_member_conflict')
      const current = this.versions.current(item.file_id)
      if (current.snapshot.path !== member.path) throw new PreviewReviewError(409, 'restore_conflict')
      if (current.revision !== item.expected_disk_revision) throw new PreviewReviewError(409, 'review_disk_revision_conflict')
    }
    batch.state = 'applying'
    for (const item of decisions) {
      const member = batch.members.find(member => member.file_id === item.file_id)!
      if (member.state === 'completed') continue
      member.state = 'applying'; member.action = item.action; member.error = null
      try {
        if (this.failNext) { this.failNext = false; throw new PreviewReviewError(503, 'preview_review_apply_failed') }
        const version = this.versions.resolveReview(item.file_id, item.review_id, item.pending_revision, item.action, item.expected_disk_revision, item.revised_content)
        member.result_version_id = version?.id ?? null
        member.state = 'completed'
      } catch (error) {
        if (!(error instanceof PreviewVersionError)) throw error
        member.state = 'failed'; member.error = error.code
      }
    }
    batch.state = batch.members.every(member => member.state === 'completed') ? 'completed' : 'failed'
    batch.updated_at_ms = Date.now()
    const results: ResourceReviewBatchResult[] = batch.members.map(member => ({ file_id: member.file_id, action: member.action!, state: member.state === 'completed' ? 'completed' : 'failed', version_id: member.result_version_id, ...(member.error ? { error: member.error } : {}) }))
    const result = { batch: this.batch(batch.id), results }
    if (batch.state === 'completed') request.result = structuredClone(result)
    return result
  }

  conflict(fileId: string): ResourceReviewConflict {
    const pending = this.versions.pending(fileId)
    if (!pending?.review) throw new PreviewReviewError(404, 'review_not_found')
    const current = this.versions.current(fileId)
    if (current.revision === pending.review.candidate_revision && current.snapshot.path === pending.review.candidate.path && !pending.review.edited_by_user) throw new PreviewReviewError(409, 'review_not_conflicted')
    const token = createHmac('sha256', this.secret).update(JSON.stringify([fileId, pending, current.snapshot])).digest('hex')
    return { file_id: fileId, review_id: pending.review.id, pending_revision: pending.revision, disk: current.snapshot, token }
  }

  reconcile(fileId: string, body: Record<string, unknown>, key: string): { ok: true } {
    if ((body.action !== 'keep_current' && body.action !== 'restore_candidate') || typeof body.token !== 'string' || !body.token) throw new PreviewReviewError(422, 'invalid_review_resolution')
    const digest = createHash('sha256').update(JSON.stringify(['reconcile', fileId, body.action, body.token])).digest('hex')
    const request = this.request(key, digest)
    if (request.result) return structuredClone(request.result as { ok: true })
    const actual = this.conflict(fileId)
    if (body.token !== actual.token) throw new PreviewReviewError(409, 'preflight_stale')
    if (actual.disk.path !== this.versions.pending(fileId)?.review?.candidate.path) throw new PreviewReviewError(409, 'restore_conflict')
    this.versions.reconcileReview(fileId, actual.review_id, actual.pending_revision, body.action, actual.disk.object_id)
    request.result = { ok: true }
    return { ok: true }
  }
}
