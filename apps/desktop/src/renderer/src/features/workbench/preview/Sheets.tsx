import React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui'

interface Props {
  names: readonly string[]
  selected: string
  onSelect(name: string): void
}

/** Document navigation uses source sheet names; CSV supplies one display-only label. */
export function Sheets({ names, selected, onSelect }: Props): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <div
      role="tablist"
      aria-label={t('officePreview.sheets')}
      className="flex h-[var(--vds-spreadsheet-sheet-height)] shrink-0 overflow-x-auto border-t border-[var(--vds-spreadsheet-header-border)] bg-[var(--vds-spreadsheet-header-background)]"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        const offset = event.key === 'ArrowRight' ? 1 : -1
        const index = (names.indexOf(selected) + offset + names.length) % names.length
        onSelect(names[index])
        const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')
        tabs[index]?.focus()
      }}
    >
      {names.map((name) => (
        <Button
          key={name}
          role="tab"
          unstyled
          aria-selected={name === selected}
          tabIndex={name === selected ? 0 : -1}
          onClick={() => onSelect(name)}
            className="h-full shrink-0 border-r border-b-2 border-r-[var(--vds-spreadsheet-header-border)] border-b-transparent px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-primary)] outline-none aria-selected:border-b-[var(--vds-text-primary)] aria-selected:bg-[var(--vds-bg-container)] aria-selected:[font-weight:var(--vds-fw-semibold)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--vds-spreadsheet-selection-border)]"
        >
          {name}
        </Button>
      ))}
    </div>
  )
}
