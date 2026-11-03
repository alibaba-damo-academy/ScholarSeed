import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, Card, CardContent, CardFooter, CardHeader, CardTitle, Spinner } from '../../components/ui'
import { Icon } from '../../icons'
import type { ReviewReadyCard } from '../../model'
import { useApp } from '../../store'
import { openReviewTab, reviewTab } from '../workbench/tabs'
import {
  fetchResourceReviewBatch,
  fetchReviewMemberContent,
  fetchReviewMemberCurrent,
  type ResourceReviewAction,
  type ResourceReviewMemberState
} from './api'
import { reviewOutcome } from './status'

interface FileSummary {
  path: string
  origin: 'agent' | 'external' | null
  action: ResourceReviewAction | null
  state: ResourceReviewMemberState | null
  added: number | null
  deleted: number | null
  externalModified: boolean
}

const DECODER = new TextDecoder('utf-8', { fatal: true })
const MAX_DIFF_LINES = 4_000

function lines(content: Uint8Array): string[] {
  const value = DECODER.decode(content)
  if (!value) return []
  const result = value.split(/\r?\n/)
  if (result.at(-1) === '') result.pop()
  return result
}

function lineCounts(before: Uint8Array, after: Uint8Array): Pick<FileSummary, 'added' | 'deleted'> {
  try {
    const left = lines(before)
    const right = lines(after)
    if (left.length + right.length > MAX_DIFF_LINES) return { added: null, deleted: null }
    const furthest = new Map<number, number>([[1, 0]])
    const maximum = left.length + right.length
    for (let distance = 0; distance <= maximum; distance += 1) {
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        let x = diagonal === -distance
          || (diagonal !== distance
            && (furthest.get(diagonal - 1) ?? -1) < (furthest.get(diagonal + 1) ?? -1))
          ? (furthest.get(diagonal + 1) ?? 0)
          : (furthest.get(diagonal - 1) ?? 0) + 1
        let y = x - diagonal
        while (x < left.length && y < right.length && left[x] === right[y]) {
          x += 1
          y += 1
        }
        furthest.set(diagonal, x)
        if (x >= left.length && y >= right.length) {
          return {
            added: (distance - left.length + right.length) / 2,
            deleted: (distance + left.length - right.length) / 2
          }
        }
      }
    }
    return { added: null, deleted: null }
  } catch {
    return { added: null, deleted: null }
  }
}

export function ReviewCard({ review }: { review: ReviewReadyCard }): React.JSX.Element {
  const { state, set } = useApp()
  const { t } = useTranslation('resources')
  const [batch, setBatch] = useState<Awaited<ReturnType<typeof fetchResourceReviewBatch>>>(null)
  const [summaries, setSummaries] = useState<FileSummary[]>(
    review.paths.map((path) => ({ path, origin: null, action: null, state: null, added: null, deleted: null, externalModified: false }))
  )
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const batch = await fetchResourceReviewBatch(review.projectId, review.batchId)
      if (!batch || cancelled) {
        if (!cancelled) setLoading(false)
        return
      }
      setBatch(batch)
      if (batch.state === 'completed') {
        setSummaries(batch.members.map((member) => ({
          path: member.path,
          origin: member.origin,
          action: member.action,
          state: member.state,
          added: null,
          deleted: null,
          externalModified: false
        })))
        setLoading(false)
        return
      }
      const loaded = await Promise.all(batch.members.map(async (member) => {
        const [base, candidate, current] = await Promise.all([
          fetchReviewMemberContent(review.projectId, review.batchId, member.file_id, 'base'),
          fetchReviewMemberContent(review.projectId, review.batchId, member.file_id, 'candidate'),
          fetchReviewMemberCurrent(review.projectId, review.batchId, member.file_id)
        ])
        return {
          path: member.path,
          origin: member.origin,
          action: member.action,
          state: member.state,
          externalModified: Boolean(current && current.revision !== member.candidate_revision),
          ...(base && candidate ? lineCounts(base, candidate) : { added: null, deleted: null })
        }
      }))
      if (!cancelled) {
        setSummaries(loaded)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [review.batchId, review.projectId, state.resourceRevision])

  const count = summaries.length
  const added = summaries.reduce((total, item) => total + (item.added ?? 0), 0)
  const deleted = summaries.reduce((total, item) => total + (item.deleted ?? 0), 0)
  const completed = batch?.state === 'completed'
  const outcome = batch ? reviewOutcome(batch) : null
  const open = (): void => {
    const tab = reviewTab(review.projectId, review.batchId, count)
    set({
      mainView: 'resource',
      modulePanelOpen: true,
      tabs: openReviewTab(state.tabs, review.projectId, review.batchId, count),
      activeTab: tab.id
    })
  }
  return (
    <Card className="my-[var(--vds-space-4)] overflow-hidden !p-0" data-state={completed ? 'completed' : 'pending'} data-testid={`review-card-${review.batchId}`} padding="sm">
      <CardHeader className="m-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center border-b border-[var(--vds-divider-default)] p-[var(--vds-space-4)]">
        <span className="grid size-9 place-items-center rounded-[var(--vds-radius-8)] bg-[var(--vds-surface-muted)] text-[var(--vds-text-primary)]" aria-hidden>
          <Icon name="edit-square" size={18} />
        </span>
        <div className="min-w-0">
          <CardTitle>{completed
            ? t('reviewCard.completedFiles', { count })
            : t('reviewCard.editedFiles', { count })}</CardTitle>
          {completed && outcome
            ? <p className="m-0 mt-[var(--vds-space-1)] text-sm text-[var(--vds-text-secondary)]" data-testid="review-outcome-summary">
                {outcome.revised > 0
                  ? t('reviewCard.outcomeWithRevisions', {
                      accepted: outcome.accepted,
                      revised: outcome.revised,
                      rejected: outcome.rejected,
                      failed: outcome.failed
                    })
                  : t('reviewCard.outcome', {
                      accepted: outcome.accepted,
                      rejected: outcome.rejected,
                      failed: outcome.failed
                    })}
              </p>
            : <p className="m-0 mt-[var(--vds-space-1)] text-sm"><span className="text-[var(--vds-success-default)]">+{added}</span> <span className="text-[var(--vds-error-default)]">-{deleted}</span></p>}
        </div>
        {loading ? <Spinner aria-label={t('reviewCard.calculatingDiff')} /> : null}
      </CardHeader>
      <CardContent className="grid gap-[var(--vds-space-2)] p-[var(--vds-space-4)]">
        {summaries.map((summary) => (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-[var(--vds-space-3)] text-sm" key={summary.path}>
            <span className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
              <span className="truncate text-[var(--vds-text-secondary)]" title={summary.path}>{summary.path}</span>
              {completed && summary.state
                ? <Badge size="sm" tone={summary.state === 'failed' || summary.action === 'reject' ? 'danger' : 'success'}>
                    {summary.state === 'failed'
                      ? t('reviewBatch.failedStatus')
                      : summary.action === 'accept'
                        ? t('reviewBatch.accepted')
                        : summary.action === 'revise'
                          ? t('reviewBatch.revised')
                          : t('reviewBatch.rejected')}
                  </Badge>
                : summary.origin
                  ? <Badge size="sm" tone={summary.origin === 'agent' ? 'brand' : 'neutral'}>{summary.origin === 'agent' ? t('reviewOrigin.agent') : t('reviewOrigin.external')}</Badge>
                  : null}
              {!completed && summary.externalModified ? <Badge size="sm" tone="warning">{t('reviewBatch.changedBadge')}</Badge> : null}
            </span>
            {!completed && (summary.added === null || summary.deleted === null
              ? <span className="text-[var(--vds-text-tertiary)]">{t('reviewCard.modified')}</span>
              : <span><span className="text-[var(--vds-success-default)]">+{summary.added}</span> <span className="text-[var(--vds-error-default)]">-{summary.deleted}</span></span>)}
          </div>
        ))}
      </CardContent>
      {!completed
        ? <CardFooter className="m-0 border-t border-[var(--vds-divider-default)] p-[var(--vds-space-3)]">
            <Button data-testid={`review-card-open-${review.batchId}`} icon={<Icon name="chevron-right" size={14} />} onClick={open}>{t('reviewCard.review')}</Button>
          </CardFooter>
        : null}
    </Card>
  )
}
