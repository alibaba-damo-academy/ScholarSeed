import { CheckCheck } from 'lucide-react'
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
  Badge,
  Button,
  Divider,
  EllipsisText,
  IconButton,
  Tooltip
} from '../../components/ui'
import { Icon } from '../../icons'
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
  filePath,
  previewLabel,
  acceptEnabled,
  reviseEnabled,
  selectedEnabled,
  decisionsEnabled,
  onChoose,
  onUndo,
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
  filePath?: string
  previewLabel: string
  acceptEnabled: boolean
  reviseEnabled: boolean
  selectedEnabled: boolean
  decisionsEnabled: boolean
  onChoose: (action: ResourceReviewAction) => void
  onUndo: (scope: 'current' | 'all') => void
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
        className="@container/review shrink-0 border-b border-[var(--vds-divider-default)] bg-[var(--vds-bg-white-default)]"
        data-testid="review-bar"
        role="toolbar"
      >
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--vds-space-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]" data-testid="review-batch-actions">
          <div className="flex min-w-0 items-center gap-[var(--vds-space-1)]">
            <EllipsisText wrapperClassName="min-w-0 flex-1" className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]" tooltipPortalled>{t('review.toolbar')}</EllipsisText>
            <Tooltip content={t('review.outcomeProgress', { reviewed, pending, failed })} portalled>
              <IconButton data-testid="review-progress" label={t('review.outcomeProgress', { reviewed, pending, failed })} icon={<Icon name="chart-line" size={16} />} size="sm" variant="ghost" />
            </Tooltip>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-[var(--vds-space-1)]">
            <Tooltip content={t('review.undoAll')} portalled>
              <Button size="sm" aria-label={t('review.undoAll')} icon={<Icon name="rewind" size={16} />} data-testid="review-batch-undo" disabled={busy || !decisionsEnabled} variant="ghost" onClick={() => onUndo('all')}><span className="hidden @2xl/review:inline">{t('review.undoAll')}</span></Button>
            </Tooltip>
            <Tooltip content={t('review.acceptAll')} portalled>
              <Button size="sm" aria-label={t('review.acceptAll')} icon={<CheckCheck />} disabled={busy || !decisionsEnabled || total === 0} variant="ghost" onClick={() => { if (decided === 0 && !hasEdits) onBulk('accept', 'all'); else setBulkAction('accept') }}><span className="hidden @2xl/review:inline">{t('review.acceptAll')}</span></Button>
            </Tooltip>
            <Tooltip content={t('review.rejectAll')} portalled>
              <Button size="sm" aria-label={t('review.rejectAll')} icon={<Icon name="close" size={16} />} disabled={busy || !decisionsEnabled || total === 0} variant="ghost" onClick={() => { if (decided === 0 && !hasEdits) onBulk('reject', 'all'); else setBulkAction('reject') }}><span className="hidden @2xl/review:inline">{t('review.rejectAll')}</span></Button>
            </Tooltip>
            <Divider orientation="vertical" className="h-[var(--vds-icon-8)]" />
            <Button size="sm" disabled={busy || remaining !== 0 || total === 0} loading={busy} onClick={onSubmit}>{t('review.submit')}</Button>
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] px-[var(--vds-space-3)] py-[var(--vds-space-3)]" data-testid="review-file-actions">
          <div className="grid min-w-0 grid-cols-1 gap-[var(--vds-space-1)]">
            <EllipsisText wrapperClassName="w-full" className="font-[family-name:var(--vds-font-code)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)]" tooltipPortalled>{filePath || t('review.currentFile')}</EllipsisText>
            <Tooltip className="min-w-0" content={previewLabel} portalled><Badge className="min-w-0 max-w-full" size="sm" tone="neutral" data-testid="review-preview-source"><span className="truncate">{previewLabel}</span></Badge></Tooltip>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-[var(--vds-space-1)]">
            <Tooltip content={t('review.undo')} portalled><IconButton size="sm" label={t('review.undo')} icon={<Icon name="rewind" size={16} />} data-testid="review-file-undo" disabled={busy || !selectedEnabled} variant="ghost" onClick={() => onUndo('current')} /></Tooltip>
            <Divider orientation="vertical" className="h-[var(--vds-icon-8)]" />
            <div className="flex shrink-0 items-center gap-[var(--vds-space-1)]">
              <Tooltip content={t('review.accept')} portalled><Button size="sm" aria-label={t('review.accept')} aria-pressed={selectedAction === 'accept'} data-testid="review-file-accept" disabled={busy || !acceptEnabled} variant={selectedAction === 'accept' ? 'primary' : 'outline'} onClick={() => onChoose('accept')}><span className="inline-flex @lg/review:hidden"><CheckCheck /></span><span className="hidden @lg/review:inline">{t('review.accept')}</span></Button></Tooltip>
              <Tooltip content={t('review.revise')} portalled><Button size="sm" aria-label={t('review.revise')} aria-pressed={selectedAction === 'revise'} data-testid="review-file-revise" disabled={busy || !selectedEnabled || !reviseEnabled} variant={selectedAction === 'revise' ? 'primary' : 'outline'} onClick={() => onChoose('revise')}><span className="inline-flex @lg/review:hidden"><Icon name="edit-square" size={16} /></span><span className="hidden @lg/review:inline">{t('review.revise')}</span></Button></Tooltip>
              <Tooltip content={t('review.reject')} portalled><Button size="sm" aria-label={t('review.reject')} aria-pressed={selectedAction === 'reject'} data-testid="review-file-reject" disabled={busy || !selectedEnabled} variant={selectedAction === 'reject' ? 'danger' : 'outline'} onClick={() => onChoose('reject')}><span className="inline-flex @lg/review:hidden"><Icon name="close" size={16} /></span><span className="hidden @lg/review:inline">{t('review.reject')}</span></Button></Tooltip>
            </div>
          </div>
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
