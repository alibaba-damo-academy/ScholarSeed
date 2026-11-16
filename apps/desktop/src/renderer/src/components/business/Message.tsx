import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Link2 } from 'lucide-react'
import { Button, Link, cx } from '../ui'
import { userMessageParts } from './utils'
import { WebNavigationContext } from '../../contracts/navigation'
import { strongSegments } from '../markdown/strong'

export function MessageActions({
  children,
  latest = false,
  alignEnd = false,
}: {
  children: React.ReactNode
  latest?: boolean
  alignEnd?: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid="message-actions"
      className={cx(
        'mt-[var(--vds-message-actions-margin-top)] flex items-center gap-[var(--vds-space-1)]',
        alignEnd && 'justify-end',
        !latest &&
          'pointer-events-none opacity-0 group-hover/message:pointer-events-auto group-hover/message:opacity-[var(--vds-opacity-full)] group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-[var(--vds-opacity-full)]'
      )}
    >
      {children}
    </div>
  )
}

export function UserMessageText({ text }: { text: string }): React.JSX.Element {
  const openWebPage = React.useContext(WebNavigationContext)
  const { t } = useTranslation('conversation')
  const id = useId()
  const content = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [heights, setHeights] = useState<{ full: number; preview: number } | null>(null)
  const parts = useMemo(
    () =>
      strongSegments(text).flatMap((segment) =>
        userMessageParts(segment.text).map((part) => ({ ...part, strong: segment.strong }))
      ),
    [text]
  )
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const measure = (): void => {
      const style = getComputedStyle(element)
      const lines = Number(style.getPropertyValue('--vds-user-message-collapsed-lines'))
      const full = element.getBoundingClientRect().height
      const preview = Math.min(full, parseFloat(style.lineHeight) * lines)
      setHeights((current) =>
        current?.full === full && current.preview === preview ? current : { full, preview }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  const collapsible = heights !== null && Math.ceil(heights.full) > Math.ceil(heights.preview)
  const collapsed = collapsible && !expanded
  return (
    <div className="min-w-0 max-w-full">
      <div
        id={id}
        data-testid="user-message-text"
        data-collapsed={collapsed}
        style={heights ? { height: collapsed ? heights.preview : heights.full } : undefined}
        className={cx(
          'overflow-hidden whitespace-pre-wrap font-[var(--vds-font-serif)] font-[var(--vds-fw-regular)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-user-message-line-height)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere] transition-[height] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none',
          collapsed &&
            '[mask-image:linear-gradient(to_bottom,black_calc(100%_-_var(--vds-user-message-fade-height)),transparent)]'
        )}
        onFocusCapture={() => {
          if (collapsed) setExpanded(true)
        }}
      >
        <div ref={content}>
          {parts.map((part, index) => {
            const value = part.href ? (
              <Link
                href={part.href}
                icon={<Link2 />}
                onClick={(event) => {
                  event.preventDefault()
                  openWebPage(part.href!)
                }}
              >
                {part.text}
              </Link>
            ) : (
              part.text
            )
            return part.strong ? (
              <strong key={index} className="font-[var(--vds-fw-semibold)]">
                {value}
              </strong>
            ) : (
              <React.Fragment key={index}>{value}</React.Fragment>
            )
          })}
        </div>
      </div>
      {collapsible && (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          aria-controls={id}
          className="mt-[var(--vds-space-1)]"
          onClick={() => setExpanded((current) => !current)}
        >
          {t(expanded ? 'message.collapse' : 'message.expand')}
          {expanded ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
        </Button>
      )}
    </div>
  )
}
