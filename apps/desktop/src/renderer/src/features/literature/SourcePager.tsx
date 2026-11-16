import { ChevronLeft, ChevronRight } from 'lucide-react'
import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, IconButton } from '../../components/ui'

export interface SourcePagerItem {
  label: string
  title: string
  available: boolean
  selected: boolean
  navigate: () => Promise<void>
}

/** Browse one paragraph's references and follow each explicit selection in the PDF. */
export function SourcePager({ items }: { items: SourcePagerItem[] }): React.JSX.Element | null {
  const { t } = useTranslation('literature')
  const [position, setPosition] = useState(0)
  const [pending, setPending] = useState(false)
  const navigating = useRef(false)
  const index = Math.min(position, items.length - 1)
  const current = items[index]
  if (!current) return null
  const single = items.length === 1

  const select = async (next: number): Promise<void> => {
    if (navigating.current || next < 0 || next >= items.length) return
    setPosition(next)
    if (!items[next].available) return
    navigating.current = true
    setPending(true)
    try {
      await items[next].navigate()
    } finally {
      navigating.current = false
      setPending(false)
    }
  }
  return (
    <span className="inline-flex max-w-full items-center gap-[var(--vds-space-1)]">
      <Badge
        data-testid="note-source-current"
        tone={current.selected ? 'brand' : 'neutral'}
        aria-label={current.title}
        title={current.title}
      >
        {current.label}
        {!current.available ? ` · ${t('noteSources.unavailable')}` : ''}
      </Badge>
      <IconButton
        size="md"
        variant="ghost"
        icon={<ChevronLeft size={16} strokeWidth={3} />}
        label={t('noteSources.previous')}
        disabled={pending || (single ? !current.available : index === 0)}
        onClick={() => void select(single ? index : index - 1)}
      />
      <span
        className="whitespace-nowrap text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-semibold)] tabular-nums text-[var(--vds-text-secondary)]"
        data-testid="note-source-position"
        aria-live="polite"
        aria-label={t('noteSources.position', { position: index + 1, count: items.length })}
      >
        {index + 1} / {items.length}
      </span>
      <IconButton
        size="md"
        variant="ghost"
        icon={<ChevronRight size={16} strokeWidth={3} />}
        label={t('noteSources.next')}
        disabled={pending || (single ? !current.available : index === items.length - 1)}
        onClick={() => void select(single ? index : index + 1)}
      />
    </span>
  )
}
