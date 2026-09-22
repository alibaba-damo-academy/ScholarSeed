import { previewReferenceLabel, referenceLabel } from './text'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import aiThinking from '../../assets/ai-thinking.gif'

import { Button, Popover, PopoverContent, PopoverTrigger, ScrollArea, Spinner } from '../../components/ui'
import { Icon } from '../../icons'
import type { MessageReference } from '../../model'
import {
  fetchSessionReferencePreview,
  SessionReferencePreviewError,
  type SessionReferenceMessage,
  type SessionReferencePreview
} from './api'

export function SessionReference({
  currentSessionId,
  reference
}: {
  currentSessionId: string | null
  reference: MessageReference
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const errorLabels: Record<string, string> = {
    assistant_session_reference_not_found: t('sessionReference.notFound'),
    history_source_unavailable: t('sessionReference.unavailable'),
    session_not_found: t('sessionReference.deleted')
  }
  const [preview, setPreview] = useState<SessionReferencePreview | null>(null)
  const [messages, setMessages] = useState<SessionReferenceMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{ code: string; detail: string } | null>(null)
  const canPreview = Boolean(currentSessionId && reference.snapshotId && reference.sourceId)

  const load = async (cursor = ''): Promise<void> => {
    if (!canPreview || loading || !currentSessionId || !reference.snapshotId || !reference.sourceId) return
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
      setMessages((current) => cursor ? [...current, ...result.messages] : result.messages)
    } catch (reason) {
      setError(reason instanceof SessionReferencePreviewError
        ? { code: reason.code, detail: '' }
        : { code: reason instanceof Error ? reason.message : '', detail: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Popover onOpenChange={(open) => { if (open && !preview && !error) void load() }}>
      <PopoverTrigger asChild>
        <Button
          unstyled
          variant="outline"
          size="content"
          disabled={!canPreview}
          className="inline-flex min-h-8 max-w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
          data-testid={`sent-session-reference-${reference.id}`}
        >
          <Icon name="quote" size={12} />
          <span className="max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap" title={referenceLabel(reference, t)}>{referenceLabel(reference, t)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="!w-[420px] !max-w-[calc(100vw-32px)] overflow-hidden !rounded-[var(--vds-radius-6)] !border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] p-0 shadow-[var(--vds-shadow-lg)]"
        data-testid="session-reference-preview"
      >
        <div className="border-b border-[var(--vds-divider-default)] px-4 py-3">
          <div className="whitespace-normal [overflow-wrap:anywhere] font-medium leading-relaxed text-[var(--vds-text-primary)]">{preview ? previewReferenceLabel(reference, preview, t) : referenceLabel(reference, t)}</div>
          <div className="mt-1 text-xs text-[var(--vds-text-tertiary)]">{t('sessionReference.referencePreview')}</div>
        </div>
        {preview?.changed ? (
          <div className="border-b border-[var(--vds-divider-default)] bg-[var(--vds-warning-light-bg-default)] px-4 py-2 text-xs text-[var(--vds-warning-text-primary)]">
            {t('sessionReference.referenceUpdated')}
          </div>
        ) : null}
        <ScrollArea className="max-h-[min(360px,50vh)]" viewportClassName="max-h-[min(360px,50vh)]">
          <div className="grid gap-3 px-4 py-3">
            {messages.map((message, index) => (
              <div key={`${message.message_id}:${index}`} className="grid gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] pb-[var(--vds-space-3)] last:border-0 last:pb-0">
                <div className="text-xs font-medium text-[var(--vds-text-tertiary)]">{message.role === 'user' ? t('sessionReference.user') : t('sessionReference.assistant')}</div>
                <div className="whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-[var(--vds-text-primary)]">{message.text}</div>
              </div>
            ))}
            {loading ? <div className="flex justify-center py-3"><Spinner imageSrc={aiThinking} aria-label={t('sessionReference.referenceLoading')} size="sm" /></div> : null}
            {error ? <div className="py-3 text-sm text-[var(--vds-error-text-primary)]">{(Object.prototype.hasOwnProperty.call(errorLabels, error.code) ? errorLabels[error.code] : undefined) ?? <>{t('sessionReference.failed')}{error.detail && <p>{error.detail}</p>}</>}</div> : null}
            {!loading && !error && preview && messages.length === 0 ? (
              <div className="py-3 text-sm text-[var(--vds-text-tertiary)]">{t('sessionReference.referenceEmpty')}</div>
            ) : null}
          </div>
        </ScrollArea>
        {preview?.has_more ? (
          <div className="border-t border-[var(--vds-divider-default)] p-2 text-center">
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load(preview.next_cursor)}>
              {t('sessionReference.referenceMore')}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
