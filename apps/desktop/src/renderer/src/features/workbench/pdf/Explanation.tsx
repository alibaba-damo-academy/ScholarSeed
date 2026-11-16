import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { Button, Textarea, Tooltip } from '../../../components/ui'
import { MAX_SELECTION_REQUIREMENT_CHARS } from '../../../../../prompts'

export function PdfExplanation({
  value,
  disabled,
  onChange,
  onOpenSettings,
  onSubmit,
}: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
  onOpenSettings: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return (
    <div className="vds-selection-action-result" data-testid="pdf-explanation-editor">
      <Textarea
        autoFocus
        label={t('reading.explanationPrompt')}
        labelClassName="sr-only"
        placeholder={t('reading.explanationPlaceholder')}
        maxLength={MAX_SELECTION_REQUIREMENT_CHARS}
        rows={2}
        value={value}
        className="placeholder:font-[var(--vds-fw-regular)]"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key !== 'Enter' ||
            event.shiftKey ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return
          event.preventDefault()
          event.stopPropagation()
          if (!disabled) onSubmit()
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
        <Button
          size="sm"
          variant="ghost"
          className="!pl-0"
          icon={<SlidersHorizontal size={14} />}
          onClick={onOpenSettings}
        >
          {t('reading.selectionPromptSettings')}
        </Button>
        <Tooltip portalled content={t('reading.explainSelectionShortcut')}>
          <Button size="sm" disabled={disabled} onClick={onSubmit}>
            {t('reading.explainSelection')}
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}
