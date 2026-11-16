import React from 'react'
import { MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { SentReferenceAttachment } from '../../components/primitive'
import type { MessageReference } from '../../model'
import { useApp } from '../../store'
import { referenceLabel } from './text'

export function SessionReference({
  reference,
}: {
  currentSessionId: string | null
  reference: MessageReference
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const { act } = useApp()
  const sourceId = reference.sourceId
  return (
    <SentReferenceAttachment
      variant="text"
      className="[&>span:last-of-type]:!text-[var(--vds-brand-bg-default)] hover:[&>span:last-of-type]:!text-[var(--vds-brand-bg-hover)]"
      disabled={!sourceId}
      onOpen={sourceId ? () => void act.openSession(sourceId) : undefined}
      icon={<MessageCircle size={12} strokeWidth={1.5} />}
      label={referenceLabel(reference, t)}
      data-testid={`sent-session-reference-${reference.id}`}
    />
  )
}
