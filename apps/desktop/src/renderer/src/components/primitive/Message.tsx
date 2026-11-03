import React, { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Link as LinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, CopyButton, cx } from '../ui'
import { messageLinks } from '../markdown/links'

export interface MessageProps {
  text: string
  timestamp?: number
  header?: ReactNode
  children?: ReactNode
  steering?: boolean
  onCopy?: (text: string) => Promise<void>
  onOpenExternal?: (url: string) => Promise<void> | void
}

export function Message({
  text,
  timestamp,
  header,
  children,
  steering,
  onCopy,
  onOpenExternal,
}: MessageProps): React.JSX.Element {
  const { t, i18n } = useTranslation('ui')
  const content = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [linkFailed, setLinkFailed] = useState(false)
  useLayoutEffect(() => {
    setExpanded(false)
    setLinkFailed(false)
  }, [text])
  useLayoutEffect(() => {
    const element = content.current
    if (!element || expanded) return
    const measure = (): void => setOverflowing(element.scrollHeight > element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text, expanded])
  const open = async (url: string): Promise<void> => {
    setLinkFailed(false)
    try {
      await onOpenExternal?.(url)
    } catch {
      setLinkFailed(true)
    }
  }
  const parsedTime = timestamp !== undefined ? new Date(timestamp) : null
  const time = parsedTime && Number.isFinite(parsedTime.getTime()) ? parsedTime : null
  return (
    <div
      className="group/message ml-auto grid w-fit min-w-0 max-w-[var(--vds-conversation-message-max-width)] justify-items-end"
      data-testid="conversation-message"
    >
      <div
        className={cx(
          'relative box-border w-auto min-w-0 max-w-full rounded-[var(--vds-conversation-message-radius)] bg-[var(--vds-other-overlay-2)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]',
          steering && 'border border-dashed border-[var(--vds-brand-light-border)]'
        )}
        data-testid="user-bubble"
      >
        {header}
        <div
          ref={content}
          data-testid="message-text"
          onFocusCapture={() => setExpanded(true)}
          className={cx(
            'whitespace-pre-wrap font-[family-name:var(--font-sans)] text-[length:var(--vds-conversation-message-font-size)] leading-[var(--vds-conversation-message-line-height)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]',
            !expanded && 'max-h-[var(--vds-conversation-message-collapsed-height)] overflow-hidden',
            !expanded && overflowing && '[mask-image:var(--vds-conversation-message-fade)]'
          )}
        >
          {onOpenExternal
            ? messageLinks(text).map((fragment, index) =>
                fragment.url ? (
                  <a
                    key={index}
                    href={fragment.url}
                    className="text-[var(--vds-brand-text-primary)] underline underline-offset-2"
                    onClick={(event) => {
                      event.preventDefault()
                      void open(fragment.url!)
                    }}
                  >
                    <LinkIcon
                      aria-hidden="true"
                      className="mr-[var(--vds-space-1)] inline size-[var(--vds-icon-4)]"
                    />
                    {fragment.value}
                  </a>
                ) : (
                  fragment.value
                )
              )
            : text}
        </div>
        {overflowing ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t('message.collapse') : t('message.expand')}
          </Button>
        ) : null}
        {linkFailed ? (
          <p
            role="alert"
            className="m-0 text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-secondary)]"
          >
            {t('message.openFailed')}
          </p>
        ) : null}
        {children}
      </div>
      {time || (text && onCopy) ? (
        <div className="mt-[var(--vds-space-1)] flex min-h-[var(--vds-control-height-sm)] items-center justify-end gap-[var(--vds-space-2)] opacity-0 group-hover/message:opacity-[var(--vds-opacity-full)] group-focus-within/message:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:opacity-[var(--vds-opacity-full)]">
          {time ? (
            <time
              dateTime={time.toISOString()}
              className="text-[length:var(--vds-font-body-lv3)] text-[var(--vds-text-tertiary)]"
            >
              {time.toLocaleString(i18n.language)}
            </time>
          ) : null}
          {text && onCopy ? (
            <CopyButton
              key={text}
              value={text}
              writeText={onCopy}
              iconOnly
              icon={<Copy className="size-[var(--vds-icon-6)]" />}
              copiedIcon={<Check className="size-[var(--vds-icon-6)]" />}
              tooltip
              size="sm"
              variant="ghost"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
