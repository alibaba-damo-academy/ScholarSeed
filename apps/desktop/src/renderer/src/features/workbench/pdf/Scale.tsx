import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input } from '../../../components/ui'
import { nextFitMode, percentScale, type PdfFitMode } from './geometry'

const CLICK_DISAMBIGUATION_MS = 300

export function PdfScale({
  editLabel,
  fitPageLabel,
  fitWidthLabel,
  mode,
  scale,
  onModeChange,
  onScaleChange
}: {
  editLabel: string
  fitPageLabel: string
  fitWidthLabel: string
  mode: PdfFitMode
  scale: number
  onModeChange: (mode: Exclude<PdfFitMode, 'custom'>) => void
  onScaleChange: (scale: number) => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => String(Math.round(scale * 100)))
  const clickTimer = useRef<number>()
  const inputRef = useRef<HTMLInputElement>(null)

  const clearClick = (): void => {
    if (clickTimer.current !== undefined) window.clearTimeout(clickTimer.current)
    clickTimer.current = undefined
  }
  useEffect(() => clearClick, [])
  useEffect(() => {
    if (!editing) setDraft(String(Math.round(scale * 100)))
  }, [editing, scale])

  const beginEdit = (): void => {
    clearClick()
    setDraft(String(Math.round(scale * 100)))
    setEditing(true)
    window.requestAnimationFrame(() => inputRef.current?.select())
  }
  const commit = (): void => {
    onScaleChange(percentScale(draft, scale))
    setEditing(false)
  }
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (event.detail === 0) {
      onModeChange(nextFitMode(mode))
      return
    }
    if (event.detail !== 1) return
    clearClick()
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = undefined
      onModeChange(nextFitMode(mode))
    }, CLICK_DISAMBIGUATION_MS)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') commit()
    if (event.key === 'Escape') {
      setDraft(String(Math.round(scale * 100)))
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        aria-label={editLabel}
        className="w-[72px] text-center tabular-nums"
        data-testid="pdf-scale-input"
        inputMode="decimal"
        size="sm"
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    )
  }

  const nextLabel = nextFitMode(mode) === 'page' ? fitPageLabel : fitWidthLabel
  return (
    <Button
      aria-label={t('pdfToolbar.scaleAction', { percent: Math.round(scale * 100), action: nextLabel })}
      className="min-w-[72px] tabular-nums"
      data-testid="pdf-scale"
      size="sm"
      title={editLabel}
      variant="outline"
      onClick={handleClick}
      onDoubleClick={(event) => {
        event.preventDefault()
        beginEdit()
      }}
    >
      {Math.round(scale * 100)}%
    </Button>
  )
}
