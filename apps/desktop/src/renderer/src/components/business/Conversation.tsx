import React, { useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import aiThinking from '../../assets/ai-thinking.gif'
import { Icon } from '../../icons'
import {
  Alert,
  AlertDescription,
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Spinner,
} from '../ui'

export interface SelectionReferenceProps {
  label: string
  items: readonly { id: string; text: string; complete?: boolean; canOpen?: boolean }[]
  onOpen?: (id: string) => void | Promise<void>
}

export function SelectionReference({
  label,
  items,
  onOpen,
}: SelectionReferenceProps): React.JSX.Element | null {
  const { t } = useTranslation('assistant')
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  if (!items.length) return null
  const openSource = async (id: string): Promise<void> => {
    if (!onOpen || busy !== null) return
    setBusy(id)
    setFailed(null)
    try {
      await onOpen(id)
      setOpen(false)
    } catch {
      setFailed(id)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setHovered(false)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="content"
          className="inline-flex max-w-full items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)]"
          onMouseEnter={() => {
            if (!open) {
              setHovered(true)
              setOpen(true)
            }
          }}
          onClick={(event) => {
            setHovered(false)
            if (open) event.preventDefault()
          }}
        >
          <Icon name="quote" size={12} />
          <span
            title={label}
            className="max-w-[var(--vds-conversation-reference-label-width)] truncate"
          >
            {label}
          </span>
          <span className="shrink-0 text-[var(--vds-text-tertiary)]">
            {t('quote.fragments', { count: items.length })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="sent-selection-reference"
        autoFocus={!hovered}
        align="end"
        className="w-[var(--vds-conversation-reference-width)] max-w-[var(--vds-popover-available-width)] gap-[var(--vds-space-2)]"
      >
        <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)]">
          <span className="min-w-0 break-words font-[var(--vds-fw-medium)]">{label}</span>
          <IconButton
            size="sm"
            variant="ghostIcon"
            label={t('save.collapse')}
            icon={<Icon name="close" size={12} />}
            onClick={() => setOpen(false)}
          />
        </div>
        <ScrollArea
          className="max-h-[var(--vds-conversation-reference-height)]"
          viewportClassName="max-h-[var(--vds-conversation-reference-height)]"
        >
          <div className="grid gap-[var(--vds-space-3)]">
            {items.map((item, index) => (
              <div
                key={item.id}
                data-testid={`selection-reference-${item.id}`}
                className="grid min-w-0 gap-[var(--vds-space-2)] border-t border-[var(--vds-border-default)] pt-[var(--vds-space-2)]"
              >
                <Button
                  variant="link"
                  size="content"
                  disabled={!onOpen || !item.canOpen || busy !== null}
                  loading={busy === item.id}
                  onClick={() => void openSource(item.id)}
                  className="justify-start text-left"
                >
                  {t('quote.openItem', { index: index + 1 })}
                </Button>
                {failed === item.id && (
                  <Alert tone="error">
                    <AlertDescription>{t('contextErrors.sourceUnavailable')}</AlertDescription>
                  </Alert>
                )}
                <blockquote className="m-0 whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] [overflow-wrap:anywhere]">
                  {item.text || t('quote.noText')}
                </blockquote>
                {!item.complete && (
                  <span className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
                    {t('quote.previewOnly')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

export interface ConversationReferenceProps {
  id: string
  label: string
  title: string
  canPreview: boolean
  loaded: boolean
  loading: boolean
  changed?: boolean
  messages: { message_id: string; role: 'user' | 'assistant'; text: string }[]
  error?: React.ReactNode
  onOpen: () => void
  onMore?: () => void
  onNavigate?: () => void
}

export function ConversationReference({
  id,
  label,
  title,
  canPreview,
  loaded,
  loading,
  changed,
  messages,
  error,
  onOpen,
  onMore,
  onNavigate,
}: ConversationReferenceProps): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(open) => {
        setOpen(open)
        if (open) onOpen()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          unstyled
          variant="outline"
          size="content"
          disabled={!canPreview && !onNavigate}
          className={
            onNavigate
              ? 'inline-flex max-w-full items-center gap-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-brand-text-primary)]'
              : 'inline-flex min-h-[var(--vds-control-height-md)] max-w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]'
          }
          onClick={
            onNavigate
              ? (event) => {
                  event.preventDefault()
                  onNavigate()
                }
              : undefined
          }
          onMouseEnter={
            onNavigate && canPreview
              ? () => {
                  setOpen(true)
                  onOpen()
                }
              : undefined
          }
          data-testid={`sent-session-reference-${id}`}
        >
          {onNavigate ? (
            <MessageCircle size={12} strokeWidth={1.5} />
          ) : (
            <Icon name="quote" size={12} />
          )}
          <span
            className="max-w-[var(--vds-conversation-reference-label-width)] overflow-hidden text-ellipsis whitespace-nowrap"
            title={label}
          >
            {label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="!w-[var(--vds-conversation-reference-width)] !max-w-[var(--vds-conversation-reference-width)] overflow-hidden !rounded-[var(--vds-radius-6)] !border-[var(--vds-border-default)] !bg-[var(--vds-surface-raised)] p-0 shadow-[var(--vds-shadow-lg)]"
        data-testid="session-reference-preview"
      >
        <div className="border-b border-[var(--vds-divider-default)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]">
          <div className="whitespace-normal [overflow-wrap:anywhere] font-[var(--vds-fw-medium)] leading-[var(--vds-conversation-reference-title-leading)] text-[var(--vds-text-primary)]">
            {title}
          </div>
          <div className="mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)]">
            {t('sessionReference.referencePreview')}
          </div>
        </div>
        {changed ? (
          <div className="border-b border-[var(--vds-divider-default)] bg-[var(--vds-warning-light-bg-default)] px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] text-[var(--vds-warning-text-primary)]">
            {t('sessionReference.referenceUpdated')}
          </div>
        ) : null}
        <ScrollArea
          className="max-h-[var(--vds-conversation-reference-height)]"
          viewportClassName="max-h-[var(--vds-conversation-reference-height)]"
        >
          <div className="grid gap-[var(--vds-space-3)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]">
            {messages.map((message, index) => (
              <div
                key={`${message.message_id}:${index}`}
                className="grid gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] pb-[var(--vds-space-3)] last:border-0 last:pb-0"
              >
                <div className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-caption)] font-[var(--vds-fw-medium)] text-[var(--vds-text-tertiary)]">
                  {message.role === 'user'
                    ? t('sessionReference.user')
                    : t('sessionReference.assistant')}
                </div>
                <div className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                  {message.text}
                </div>
              </div>
            ))}
            {loading ? (
              <div className="flex justify-center py-[var(--vds-space-3)]">
                <Spinner
                  imageSrc={aiThinking}
                  aria-label={t('sessionReference.referenceLoading')}
                  size="sm"
                />
              </div>
            ) : null}
            {error ? (
              <div className="py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-conversation-reference-feedback-leading)] text-[var(--vds-error-text-primary)]">
                {error}
              </div>
            ) : null}
            {!loading && !error && loaded && messages.length === 0 ? (
              <div className="py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-conversation-reference-feedback-leading)] text-[var(--vds-text-tertiary)]">
                {t('sessionReference.referenceEmpty')}
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {onMore ? (
          <div className="border-t border-[var(--vds-divider-default)] p-[var(--vds-space-2)] text-center">
            <Button size="sm" variant="ghost" disabled={loading} onClick={onMore}>
              {t('sessionReference.referenceMore')}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
