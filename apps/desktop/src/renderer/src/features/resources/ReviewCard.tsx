import React, { useEffect, useState } from 'react'
import { BookOpenCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  ARTIFACT_BORDERED_ICON_CLASS,
  ARTIFACT_DESCRIPTION_CLASS,
  ARTIFACT_ICON_CLASS,
  ARTIFACT_TITLE_CLASS,
} from '../../components/primitive/Receipt'
import { Button, Card, EllipsisText, cx } from '../../components/ui'
import type { ReviewReadyCard } from '../../model'
import { useApp } from '../../store'
import { openReviewTab, reviewTab } from '../workbench/tabs'
import { fetchResourceReviewBatch } from './api'
import { reviewOutcome } from './status'

export function ReviewCard({ review }: { review: ReviewReadyCard }): React.JSX.Element {
  const { state, set } = useApp()
  const { t } = useTranslation('resources')
  const [batch, setBatch] = useState<Awaited<ReturnType<typeof fetchResourceReviewBatch>>>(null)

  useEffect(() => {
    let cancelled = false
    void fetchResourceReviewBatch(review.projectId, review.batchId).then((next) => {
      if (next && !cancelled) setBatch(next)
    })
    return () => {
      cancelled = true
    }
  }, [review.batchId, review.projectId, state.resourceRevision])

  const count = batch?.members.length ?? review.paths.length
  const completed = batch?.state === 'completed'
  const outcome = batch && completed ? reviewOutcome(batch) : null
  const open = (): void => {
    const tab = reviewTab(review.projectId, review.batchId, count)
    set((current) => ({
      mainView: 'resource',
      modulePanelOpen: true,
      tabs: openReviewTab(current.tabs, review.projectId, review.batchId, count),
      activeTab: tab.id,
      workbenchLayout: {
        ...current.workbenchLayout,
        open: true,
        full: false,
        taskTab: false,
        conversationFull: false,
      },
      aiPanel: { ...current.aiPanel, cover: false },
    }))
  }

  return (
    <Card
      className="my-[var(--vds-space-3)] box-border flex h-[var(--vds-artifact-card-height)] items-center gap-[var(--vds-space-3)] !rounded-[var(--vds-radius-6)] !border-[var(--vds-divider-default)] !bg-[var(--vds-artifact-card-bg)] px-[var(--vds-space-3)]"
      data-state={completed ? 'completed' : 'pending'}
      data-testid={`review-card-${review.batchId}`}
      padding="none"
      variant="flat"
    >
      <span className={cx(ARTIFACT_ICON_CLASS, ARTIFACT_BORDERED_ICON_CLASS)} aria-hidden>
        <BookOpenCheck strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className={cx('!m-0 !font-[var(--vds-fw-medium)]', ARTIFACT_TITLE_CLASS)}>
          {completed
            ? t('reviewCard.completedFiles', { count })
            : t('reviewCard.editedFiles', { count })}
        </h3>
        {outcome ? (
          <EllipsisText
            className={ARTIFACT_DESCRIPTION_CLASS}
            tooltipPortalled
            data-testid="review-outcome-summary"
          >
            {outcome.revised > 0
              ? t('reviewCard.outcomeWithRevisions', {
                  accepted: outcome.accepted,
                  revised: outcome.revised,
                  rejected: outcome.rejected,
                  failed: outcome.failed,
                })
              : t('reviewCard.outcome', {
                  accepted: outcome.accepted,
                  rejected: outcome.rejected,
                  failed: outcome.failed,
                })}
          </EllipsisText>
        ) : null}
      </div>
      {!completed ? (
        <Button
          className="shrink-0"
          size="sm"
          variant="outline"
          data-testid={`review-card-open-${review.batchId}`}
          onClick={open}
        >
          {t('reviewCard.review')}
        </Button>
      ) : null}
    </Card>
  )
}
