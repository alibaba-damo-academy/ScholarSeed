import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../components/ui'

export function ReviewAdmission({
  open,
  fileCount,
  busy,
  error,
  onAccept,
  onReject,
  onReview,
  onCancel
}: {
  open: boolean
  fileCount: number
  busy: boolean
  error: string | null
  onAccept: () => void
  onReject: () => void
  onReview: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation('resources')
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel() }}>
      <DialogContent data-testid="review-admission-dialog" hideCloseButton>
        <DialogHeader>
          <DialogTitle>{t('admission.title')}</DialogTitle>
          <DialogDescription>
            {t('admission.description', { count: fileCount })}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="m-0 text-sm text-[var(--vds-error-default)]">{error}</p> : null}
        <DialogFooter>
          <Button disabled={busy} variant="ghost" onClick={onCancel}>{t('cancel')}</Button>
          <Button disabled={busy} variant="secondary" onClick={onReview}>{t('admission.review')}</Button>
          <Button disabled={busy} variant="danger" onClick={onReject}>{t('admission.rejectAll')}</Button>
          <Button disabled={busy} loading={busy} onClick={onAccept}>{t('admission.acceptAll')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
