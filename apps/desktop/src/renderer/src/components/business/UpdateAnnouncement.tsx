import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { updateCandidateKey } from '../../../../updates'
import { isUpdateEntryVisible, useUpdateAnnouncement, useUpdateState } from '../../features/updates/state'
import { Dialog, DialogContent, DialogPortal } from '../ui'
import { UpdatePanel } from './UpdatePanel'

const CONTENT_CLASS_NAME = '!z-[var(--vds-z-modal-nested)] !w-[var(--vds-update-dialog-width)] !gap-0 !p-0 overflow-hidden'
const OVERLAY_CLASS_NAME = '!z-[var(--vds-z-modal-nested-overlay)]'

export function UpdateAnnouncement(): React.JSX.Element | null {
  const { t } = useTranslation('components')
  const state = useUpdateState()
  const announcement = useUpdateAnnouncement()
  const [open, setOpen] = useState(false)
  const candidateKey = updateCandidateKey(state?.candidate)

  useEffect(() => {
    if (announcement.pending) setOpen(true)
  }, [announcement.pending, candidateKey])

  if (!isUpdateEntryVisible(state)) return null

  const dismiss = (): void => {
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogContent
          aria-label={t('update.notesTitle')}
          className={CONTENT_CLASS_NAME}
          data-testid="update-announcement"
          hideCloseButton
          overlayClassName={OVERLAY_CLASS_NAME}
          overlayProps={{ onPointerDown: () => setOpen(false) }}
        >
          <UpdatePanel onDismiss={dismiss} onAction={announcement.acknowledge} presentation="dialog" />
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
