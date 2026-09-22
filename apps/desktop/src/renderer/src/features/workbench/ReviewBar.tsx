import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button
} from '../../components/ui'
import type { ResourceReviewAction } from '../resources/api'

type BulkAction = Extract<ResourceReviewAction, 'accept' | 'reject'>

export function ReviewBar({
  busy,
  decided,
  reviewed,
  pending,
  failed,
  total,
  hasEdits,
  selectedAction,
  reviseEnabled,
  selectedEnabled,
  decisionsEnabled,
  onChoose,
  onUndoAll,
  onBulk,
  onSubmit
}: {
  busy: boolean
  decided: number
  reviewed: number
  pending: number
  failed: number
  total: number
  hasEdits: boolean
  selectedAction: ResourceReviewAction | null
  reviseEnabled: boolean
  selectedEnabled: boolean
  decisionsEnabled: boolean
  onChoose: (action: ResourceReviewAction) => void
  onUndoAll: () => void
  onBulk: (action: BulkAction, scope: 'remaining' | 'all') => void
  onSubmit: () => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const { t: uiText } = useTranslation('ui')
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null)
  const remaining = total - decided
  return (
    <>
      <div
        aria-label={t('review.toolbar')}
        className="grid gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-4)] py-[var(--vds-space-2)]"
        data-testid="review-bar"
        role="toolbar"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]" data-testid="review-batch-actions">
          <span className="mr-auto min-w-0 text-sm font-medium text-[var(--vds-text-primary)]">
            {t('review.toolbar')}
            <span className="ml-[var(--vds-space-2)] text-xs font-normal text-[var(--vds-text-secondary)]">
              {t('review.outcomeProgress', { reviewed, pending, failed })}
            </span>
          </span>
          <Button disabled={busy || !decisionsEnabled || decided === 0} variant="ghost" onClick={onUndoAll}>{t('review.undoAll')}</Button>
          <Button disabled={busy || !decisionsEnabled || total === 0} variant="secondary" onClick={() => { if (decided === 0 && !hasEdits) onBulk('accept', 'all'); else setBulkAction('accept') }}>{t('review.acceptAll')}</Button>
          <Button disabled={busy || !decisionsEnabled || total === 0} variant="secondary" onClick={() => { if (decided === 0 && !hasEdits) onBulk('reject', 'all'); else setBulkAction('reject') }}>{t('review.rejectAll')}</Button>
          <Button disabled={busy || remaining !== 0 || total === 0} loading={busy} onClick={onSubmit}>{t('review.submit')}</Button>
        </div>
        <div className="flex items-center justify-end gap-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-2)]" data-testid="review-file-actions">
          <span className="mr-auto text-xs text-[var(--vds-text-secondary)]">{t('review.currentFile')}</span>
          <Button disabled={busy || !selectedEnabled} variant={selectedAction === 'accept' ? 'primary' : 'secondary'} onClick={() => onChoose('accept')}>{t('review.accept')}</Button>
          <Button disabled={busy || !selectedEnabled || !reviseEnabled} variant={selectedAction === 'revise' ? 'primary' : 'secondary'} onClick={() => onChoose('revise')}>{t('review.revise')}</Button>
          <Button disabled={busy || !selectedEnabled} variant={selectedAction === 'reject' ? 'danger' : 'secondary'} onClick={() => onChoose('reject')}>{t('review.reject')}</Button>
        </div>
      </div>
      <AlertDialog open={bulkAction !== null} onOpenChange={(open) => { if (!open) setBulkAction(null) }}>
        <AlertDialogContent data-testid="review-bulk-confirmation">
          <AlertDialogHeader>
            <AlertDialogTitle>{bulkAction === 'accept' ? t('review.acceptTitle') : t('review.rejectTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {hasEdits ? t('review.descriptionWithEdits', { decided }) : t('review.description', { decided })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{uiText('cancel')}</AlertDialogCancel>
            <Button variant="secondary" onClick={() => { if (bulkAction) onBulk(bulkAction, 'remaining'); setBulkAction(null) }}>
              {bulkAction === 'accept' ? t('review.acceptRemaining') : t('review.rejectRemaining')}
            </Button>
            <AlertDialogAction onClick={() => { if (bulkAction) onBulk(bulkAction, 'all'); setBulkAction(null) }}>
              {bulkAction === 'accept' ? t('review.confirmAcceptAll') : t('review.confirmRejectAll')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
