import type { ResourceReviewBatch } from './api'

export interface ResourceReviewProgress {
  reviewed: number
  pending: number
  failed: number
}

export interface ResourceReviewOutcome {
  accepted: number
  revised: number
  rejected: number
  failed: number
}

export function reviewProgress(
  batch: ResourceReviewBatch,
  hasDecision: (fileId: string) => boolean
): ResourceReviewProgress {
  let reviewed = 0
  let failed = 0
  for (const member of batch.members) {
    if (member.state === 'failed') failed += 1
    else if (hasDecision(member.file_id)) reviewed += 1
  }
  return { reviewed, pending: batch.members.length - reviewed - failed, failed }
}

export function reviewOutcome(batch: ResourceReviewBatch): ResourceReviewOutcome {
  const outcome: ResourceReviewOutcome = { accepted: 0, revised: 0, rejected: 0, failed: 0 }
  for (const member of batch.members) {
    if (member.state === 'failed') {
      outcome.failed += 1
      continue
    }
    if (member.action === 'accept') outcome.accepted += 1
    if (member.action === 'revise') outcome.revised += 1
    if (member.action === 'reject') outcome.rejected += 1
  }
  return outcome
}
