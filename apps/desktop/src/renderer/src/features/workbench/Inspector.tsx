import React, { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, IconButton } from '../../components/ui'
import type { DocumentPanelContext, DocumentPanelContribution } from '../../contracts/features'

export function DocumentPanelActions({
  activePanelId,
  panels,
  onToggle
}: {
  activePanelId: string | null
  panels: DocumentPanelContribution[]
  onToggle: (panelId: string) => void
}): React.JSX.Element {
  const { i18n } = useTranslation()
  return (
    <>
      {panels.map((panel) => (
        <Button
          key={panel.id}
          aria-label={panel.label(i18n)}
          aria-pressed={activePanelId === panel.id}
          data-testid={`document-panel-toggle-${panel.id}`}
          variant={activePanelId === panel.id ? 'secondary' : 'outline'}
          onClick={() => onToggle(panel.id)}
        >
          {panel.title}
        </Button>
      ))}
    </>
  )
}

export function DocumentPanelHost({
  context,
  panel,
  onClose
}: {
  context: DocumentPanelContext
  panel: DocumentPanelContribution
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const headingId = useId()
  return (
    <aside
      aria-labelledby={headingId}
      className="flex w-80 max-w-[45%] flex-none flex-col overflow-hidden border-l border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]"
      data-testid={`document-panel-${panel.id}`}
    >
      <header className="flex min-h-12 items-center justify-between gap-2 border-b border-[var(--vds-divider-default)] px-3 py-2">
        <h2 id={headingId} className="m-0 text-sm font-medium text-[var(--vds-text-primary)]">{panel.title}</h2>
        <IconButton
          icon="×"
          label={t('documentPanel.close')}
          size="sm"
          variant="ghost"
          onClick={onClose}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {panel.render(context)}
      </div>
    </aside>
  )
}
