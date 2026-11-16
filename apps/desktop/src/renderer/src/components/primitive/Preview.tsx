import React, { useId, useState } from 'react'
import { IconFont } from './Iconfont'
import { ArtifactOpenButton } from './Receipt'
import { IconButton } from '../ui'

export function CanvasPreview({
  title,
  full = false,
  onOpen,
  onReturn,
  collapseOnOpen = false,
  expandLabel,
  collapseLabel,
  fitContent = false,
  notice,
  footer,
  testId,
  children,
}: {
  title: string
  full?: boolean
  onOpen?: () => void
  onReturn?: () => void
  collapseOnOpen?: boolean
  expandLabel: string
  collapseLabel: string
  fitContent?: boolean
  notice?: React.ReactNode
  footer?: React.ReactNode
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  const previewId = useId()
  const [expandedInline, setExpanded] = useState(true)
  const expanded = expandedInline && !onReturn
  const showBody = full || expanded
  const height = full
    ? 'min-h-0 flex-1'
    : fitContent
      ? 'max-h-[var(--vds-canvas-preview-height)] overscroll-contain'
      : 'h-[var(--vds-canvas-preview-height)] overscroll-y-contain'

  return (
    <section
      data-testid={testId}
      className={`flex min-h-0 min-w-0 flex-col ${full ? 'h-full' : 'overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]'}`}
    >
      {!full && (
        <header
          className={`flex min-w-0 items-center justify-between gap-[var(--vds-space-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] ${expanded ? 'border-b border-[var(--vds-divider-default)]' : ''}`}
        >
          <span className="min-w-0 break-words font-[var(--vds-fw-medium)]">{title}</span>
          <div className="flex shrink-0 items-center gap-[var(--vds-space-2)]">
            {onOpen && (
              <ArtifactOpenButton
                onOpen={() => {
                  if (collapseOnOpen) setExpanded(false)
                  onOpen()
                }}
              />
            )}
            <IconButton
              label={expanded ? collapseLabel : expandLabel}
              size="sm"
              variant="ghostIcon"
              icon={
                <IconFont
                  type={expanded ? 'a-line-switch-arrow-down-s' : 'a-line-switch-arrow-right-s'}
                />
              }
              aria-controls={previewId}
              aria-expanded={expanded}
              onClick={() => {
                if (onReturn) {
                  setExpanded(true)
                  onReturn()
                } else {
                  setExpanded((current) => !current)
                }
              }}
            />
          </div>
        </header>
      )}
      <div
        id={previewId}
        hidden={!showBody}
        className={`min-h-0 min-w-0 flex-col gap-[var(--vds-space-3)] ${showBody ? 'flex' : 'hidden'} ${full ? 'flex-1' : 'mx-[var(--vds-space-3)] py-[var(--vds-space-3)]'}`}
      >
        {notice}
        <div
          className={`min-w-0 overflow-auto ${height}`}
          tabIndex={fitContent ? 0 : undefined}
          role={fitContent ? 'region' : undefined}
          aria-label={fitContent ? title : undefined}
        >
          {children}
        </div>
        {footer}
      </div>
    </section>
  )
}
