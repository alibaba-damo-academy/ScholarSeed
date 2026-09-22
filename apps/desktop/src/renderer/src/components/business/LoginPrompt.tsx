import React from 'react'
import { LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useApp } from '../../store'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPortal, DialogTitle } from '../ui'

export function LoginPrompt({ open, onOpenChange, skill }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill?: string
}): React.JSX.Element {
  const { set } = useApp()
  const { t } = useTranslation('components')
  const titleId = React.useId()
  const descriptionId = React.useId()

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPortal>
      <DialogContent className="!z-[var(--vds-z-modal-nested)]" overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]" aria-labelledby={titleId} aria-describedby={descriptionId} data-testid="login-prompt">
        <div className="grid size-[var(--vds-control-height-standard)] place-items-center rounded-[var(--vds-radius-5)] border border-[var(--vds-warning-light-border)] bg-[var(--vds-warning-light-bg-default)] text-[var(--vds-warning-text-primary)]" aria-hidden="true">
          <LockKeyhole className="size-[var(--vds-icon-8)]" />
        </div>
        <DialogHeader>
          <DialogTitle id={titleId}>{skill ? t('loginPrompt.skillTitle', { name: skill }) : t('loginPrompt.title')}</DialogTitle>
          <DialogDescription id={descriptionId}>{skill ? t('loginPrompt.skillDescription') : t('loginPrompt.description')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="login-prompt-cancel">{t('loginPrompt.cancel')}</Button>
          <Button onClick={() => { onOpenChange(false); set({ loginOpen: true }) }} data-testid="login-prompt-confirm">{t('loginPrompt.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </DialogPortal>
  </Dialog>
}
