import React, { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  AlertDescription,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tooltip,
} from '../ui'

export function Canvas({
  title,
  children,
  defaultExpanded = true,
  expanded,
  onExpandedChange,
  onOpen,
  scroll = true,
}: {
  title: string
  children: React.ReactNode
  defaultExpanded?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  onOpen?: () => Promise<void>
  scroll?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const open = async (): Promise<void> => {
    if (!onOpen || pending.current) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      await onOpen()
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Collapsible
      data-testid="conversation-canvas"
      defaultOpen={defaultExpanded}
      open={expanded}
      onOpenChange={onExpandedChange}
      className="min-w-0 !gap-0 overflow-hidden rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
    >
      <div className="flex min-w-0 items-center gap-[var(--vds-space-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
        <CollapsibleTrigger className="group min-w-0 flex-1 !justify-start !border-0 !bg-transparent !p-0 text-left">
          <ChevronDown className="shrink-0 group-data-[state=closed]:-rotate-90" />
          <Tooltip content={title} portalled>
            <span className="min-w-0 break-words text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-[var(--vds-fw-medium)]">
              {title}
            </span>
          </Tooltip>
        </CollapsibleTrigger>
        {onOpen ? (
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void open()}>
            {t('canvas.open')}
          </Button>
        ) : null}
      </div>
      {failed ? (
        <Alert tone="error">
          <AlertDescription>{t('canvas.openFailed')}</AlertDescription>
        </Alert>
      ) : null}
      <CollapsibleContent className="!border-0 !p-0">
        <div
          tabIndex={0}
          aria-label={title}
          className={
            scroll
              ? 'max-h-[var(--vds-canvas-preview-height)] min-w-0 overflow-auto overscroll-contain p-[var(--vds-space-3)] [&>*]:my-0'
              : 'min-w-0 p-[var(--vds-space-3)] [&>*]:my-0'
          }
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
