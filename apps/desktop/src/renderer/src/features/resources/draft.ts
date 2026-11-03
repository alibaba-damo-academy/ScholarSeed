import type {
  ResourceReviewAction,
  ResourceReviewBatch,
  ResourceReviewBatchDecision,
  ResourceReviewBatchMember
} from './api'

export interface ReviewDraftChoice {
  action: ResourceReviewAction
  reviewId: string
  pendingRevision: number
  candidateRevision: string | null
  expectedDiskRevision: string | null
}

export enum ReviewUndoSource {
  Candidate = 'candidate',
  Memory = 'memory'
}

export function resolveReviewAction(
  action: ResourceReviewAction,
  _member: ResourceReviewBatchMember,
  _expectedDiskRevision: string | null
): ResourceReviewAction {
  return action
}

export function resolveExpectedDiskRevision(
  member: ResourceReviewBatchMember,
  currentRevision: string | null | undefined,
  sessionRevision: string | null | undefined
): string | null {
  return currentRevision ?? sessionRevision ?? member.candidate_revision
}

export function shouldSaveReviewDraft(action: ResourceReviewAction, dirty: boolean): boolean {
  return action === 'revise' && dirty
}

export function shouldRestoreReviewCandidate(
  choice: ReviewDraftChoice | null,
  member: ResourceReviewBatchMember
): boolean {
  return choice?.action === 'revise'
    && choice.expectedDiskRevision !== member.candidate_revision
}

export function resolveReviewUndoSource(
  choice: ReviewDraftChoice | null,
  member: ResourceReviewBatchMember,
  dirty: boolean,
  currentRevision: string | null
): ReviewUndoSource | null {
  if (currentRevision !== member.candidate_revision || shouldRestoreReviewCandidate(choice, member)) return ReviewUndoSource.Candidate
  return dirty ? ReviewUndoSource.Memory : null
}

function batchKey(project: string, batchId: string): string {
  return `${project}\0${batchId}`
}

export class ReviewDraftStore {
  private readonly batches = new Map<string, Map<string, ReviewDraftChoice>>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  hydrate(project: string, batch: ResourceReviewBatch): void {
    const key = batchKey(project, batch.id)
    const choices = this.batches.get(key) ?? new Map<string, ReviewDraftChoice>()
    let changed = false
    const members = new Map(batch.members.map((member) => [member.file_id, member]))
    for (const [fileId, choice] of choices) {
      const member = members.get(fileId)
      if (
        !member
        || member.review_id !== choice.reviewId
        || member.candidate_revision !== choice.candidateRevision
      ) {
        choices.delete(fileId)
        changed = true
      } else if (member.pending_revision !== choice.pendingRevision) {
        choices.set(fileId, { ...choice, pendingRevision: member.pending_revision })
        changed = true
      }
    }
    for (const member of batch.members) {
      if (member.state !== 'completed' || !member.action || choices.has(member.file_id)) continue
      choices.set(member.file_id, {
        action: member.action,
        reviewId: member.review_id,
        pendingRevision: member.pending_revision,
        candidateRevision: member.candidate_revision,
        expectedDiskRevision: member.candidate_revision
      })
      changed = true
    }
    if (choices.size > 0) this.batches.set(key, choices)
    if (choices.size === 0) this.batches.delete(key)
    if (changed) this.emit()
  }

  choose(
    project: string,
    batchId: string,
    member: ResourceReviewBatchMember,
    action: ResourceReviewAction,
    expectedDiskRevision: string | null
  ): void {
    const key = batchKey(project, batchId)
    const choices = this.batches.get(key) ?? new Map<string, ReviewDraftChoice>()
    choices.set(member.file_id, {
      action,
      reviewId: member.review_id,
      pendingRevision: member.pending_revision,
      candidateRevision: member.candidate_revision,
      expectedDiskRevision
    })
    this.batches.set(key, choices)
    this.emit()
  }

  choice(project: string, batchId: string, fileId: string): ReviewDraftChoice | null {
    return this.batches.get(batchKey(project, batchId))?.get(fileId) ?? null
  }

  clearBatch(project: string, batchId: string): void {
    if (this.batches.delete(batchKey(project, batchId))) this.emit()
  }

  clearChoice(project: string, batchId: string, fileId: string): void {
    const key = batchKey(project, batchId)
    const choices = this.batches.get(key)
    if (!choices?.delete(fileId)) return
    if (choices.size === 0) this.batches.delete(key)
    this.emit()
  }

  decidedCount(project: string, batchId: string): number {
    return this.batches.get(batchKey(project, batchId))?.size ?? 0
  }

  decisions(project: string, batch: ResourceReviewBatch): ResourceReviewBatchDecision[] | null {
    const choices = this.batches.get(batchKey(project, batch.id))
    if (!choices || choices.size !== batch.members.length) return null
    const result: ResourceReviewBatchDecision[] = []
    for (const member of batch.members) {
      const choice = choices.get(member.file_id)
      if (!choice) return null
      result.push({
        file_id: member.file_id,
        review_id: choice.reviewId,
        pending_revision: choice.pendingRevision,
        action: choice.action,
        expected_disk_revision: choice.expectedDiskRevision
      })
    }
    return result
  }

  getSnapshot = (): number => this.revision

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }
}

export const reviewDraftStore = new ReviewDraftStore()
