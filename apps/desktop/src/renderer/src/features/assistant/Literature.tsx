import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getLiterature } from '../literature/api'
import { AttachmentFiles } from './Local'
import type { LiteratureAttachmentSummary } from '../../contracts/literature'

export function LiteratureAttachment({
  id,
  referenceId,
  title,
  initialFileName,
  onRemove,
  onOpen,
  showActions = false,
}: {
  id: string
  referenceId: string
  title: string
  initialFileName?: string
  onRemove?: () => void
  onOpen?: () => void
  showActions?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [attachment, setAttachment] = useState<{
    id: string
    primary: LiteratureAttachmentSummary | null
  } | null>(null)
  useEffect(() => {
    let active = true
    void getLiterature(id).then(
      (item) => {
        if (active) setAttachment({ id, primary: item.primary_attachment })
      },
      () => {
        if (active) setAttachment(null)
      }
    )
    return () => {
      active = false
    }
  }, [id])
  return (
    <AttachmentFiles
      showActions={showActions && attachment?.id === id && Boolean(attachment.primary)}
      layout="contents"
      sourceLabel={t('queue.kinds.literature')}
      source="literature"
      refs={[
        {
          type: 'file',
          id: referenceId,
          path: id,
          title,
          fileName:
            attachment?.id === id ? (attachment.primary?.name ?? '') : (initialFileName ?? ''),
          previewSource:
            attachment?.id === id && attachment.primary
              ? {
                  kind: 'literature',
                  literatureId: id,
                  attachmentId: attachment.primary.id,
                  recordTarget: attachment.primary.record_target,
                  path: id,
                }
              : undefined,
        },
      ]}
      onRemove={onRemove}
      onOpen={onOpen}
    />
  )
}
