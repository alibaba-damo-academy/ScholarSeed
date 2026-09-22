import { Maximize2, Minimize2 } from 'lucide-react'
import React, { type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'

import { IconButton } from '../../../components/ui'
import { Icon } from '../../../icons'

interface PdfPanelProps {
  ariaLabel: string
  bodyClassName?: string
  bodyRef?: Ref<HTMLDivElement>
  bodyTestId?: string
  children: ReactNode
  closeLabel: string
  expanded: boolean
  footer?: ReactNode
  headerAction?: ReactNode
  icon: ReactNode
  onClose: () => void
  onToggleExpanded: () => void
  testId: string
  title: ReactNode
  toolbar?: ReactNode
}

export function PdfPanel({
  ariaLabel,
  bodyClassName = 'min-h-0 flex-1 overflow-auto',
  bodyRef,
  bodyTestId,
  children,
  closeLabel,
  expanded,
  footer,
  headerAction,
  icon,
  onClose,
  onToggleExpanded,
  testId,
  title,
  toolbar
}: PdfPanelProps): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return (
    <aside
      aria-label={ariaLabel}
      className={`vds-pdf-panel absolute inset-y-0 right-[var(--vds-layout-pdf-rail-width)] z-[var(--vds-z-surface-panel)] flex h-full min-w-0 flex-col overflow-hidden border-l border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-2-left)]${expanded ? ' left-0 max-w-none' : ' w-[var(--vds-layout-pdf-panel-width)] max-w-[calc(100%-var(--vds-layout-pdf-rail-width))]'}`}
      data-testid={testId}
    >
      <header className="flex min-h-12 items-center justify-between gap-2 border-b border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="shrink-0">{icon}</span>
          <strong className="truncate">{title}</strong>
          {headerAction}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            data-testid={`${testId}-toggle-size`}
            label={expanded ? t('reading.shrinkPanel') : t('reading.expandPanel')}
            icon={expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            size="sm"
            variant="ghostIcon"
            onClick={onToggleExpanded}
          />
          <IconButton
            label={closeLabel}
            icon={<Icon name="close" size={14} />}
            size="sm"
            variant="ghostIcon"
            onClick={onClose}
          />
        </div>
      </header>
      {toolbar}
      <div className={bodyClassName} data-testid={bodyTestId} ref={bodyRef}>{children}</div>
      {footer}
    </aside>
  )
}
