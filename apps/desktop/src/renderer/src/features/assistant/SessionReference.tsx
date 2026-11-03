import { previewReferenceLabel, referenceLabel } from './text'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConversationReference } from '../../components/business/Conversation'
import type { MessageReference } from '../../model'
import {
  fetchSessionReferencePreview,
  SessionReferencePreviewError,
  type SessionReferenceMessage,
  type SessionReferencePreview,
} from './api'

export function SessionReference({
  currentSessionId,
  reference,
}: {
  currentSessionId: string | null
  reference: MessageReference
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const errorLabels: Record<string, string> = {
    assistant_session_reference_not_found: t('sessionReference.notFound'),
    history_source_unavailable: t('sessionReference.unavailable'),
    session_not_found: t('sessionReference.deleted'),
  }
  const [preview, setPreview] = useState<SessionReferencePreview | null>(null)
  const [messages, setMessages] = useState<SessionReferenceMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ code: string; detail: string } | null>(null)
  const canPreview = Boolean(currentSessionId && reference.snapshotId && reference.sourceId)

  const load = async (cursor = ''): Promise<void> => {
    if (!canPreview || loading || !currentSessionId || !reference.snapshotId || !reference.sourceId)
      return
    setLoading(true)
    setError(null)
    try {
      const result = await fetchSessionReferencePreview(
        currentSessionId,
        reference.snapshotId,
        reference.sourceId,
        cursor
      )
      setPreview(result)
      setMessages((current) => (cursor ? [...current, ...result.messages] : result.messages))
    } catch (reason) {
      setError(
        reason instanceof SessionReferencePreviewError
          ? { code: reason.code, detail: '' }
          : {
              code: reason instanceof Error ? reason.message : '',
              detail: reason instanceof Error ? reason.message : String(reason),
            }
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <ConversationReference
      id={reference.id}
      label={referenceLabel(reference, t)}
      title={preview ? previewReferenceLabel(reference, preview, t) : referenceLabel(reference, t)}
      canPreview={canPreview}
      loaded={Boolean(preview)}
      loading={loading}
      changed={preview?.changed}
      messages={messages}
      error={
        error
          ? ((Object.prototype.hasOwnProperty.call(errorLabels, error.code)
              ? errorLabels[error.code]
              : undefined) ?? (
              <>
                {t('sessionReference.failed')}
                {error.detail && <p>{error.detail}</p>}
              </>
            ))
          : null
      }
      onOpen={() => {
        if (!preview && !error) void load()
      }}
      onMore={preview?.has_more ? () => void load(preview.next_cursor) : undefined}
    />
  )
}
