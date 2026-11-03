import React from 'react'
import { useTranslation } from 'react-i18next'
import { TranslationTargetPicker } from '../../../components/business/Language'
import type { TranslationDirection, TranslationSentence } from './analysis'

export function Language({
  value,
  disabled,
  onChange,
}: {
  value: TranslationDirection
  disabled?: boolean
  onChange: (value: TranslationDirection) => void
}): React.JSX.Element {
  return <TranslationTargetPicker value={value} disabled={disabled} onChange={onChange} />
}

export function Translation({
  sentences,
  active,
  onSelect,
  compact = false,
}: {
  sentences: TranslationSentence[]
  active: string
  onSelect: (sentence: TranslationSentence) => void
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return (
    <div
      className={`cursor-text select-text ${compact ? 'text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-pdf-translation-line-height)]' : 'text-sm leading-[var(--vds-pdf-reading-content-line-height)]'}`}
      data-testid="translation-sentences"
    >
      {sentences.map((sentence, index) => (
        <React.Fragment key={index}>
          {index > 0 && sentence.paragraph_start === true && (
            <span className={compact ? 'block h-[var(--vds-space-1)]' : 'block h-4'} />
          )}
          <span
            role="button"
            tabIndex={0}
            aria-pressed={active === sentence.source_text}
            title={sentence.located ? sentence.source_text : t('translation.unlocated')}
            onClick={() => onSelect(sentence)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(sentence)
              }
            }}
            className={`cursor-pointer rounded box-decoration-clone outline-none focus-visible:ring-2 focus-visible:ring-[var(--vds-border-default)] ${sentence.heading === true && !compact ? 'font-semibold' : ''} ${active === sentence.source_text ? 'bg-[var(--vds-brand-light-bg-default)] ring-2 ring-[var(--vds-brand-light-bg-hover)]' : ''}`}
          >
            {sentence.translated_text}
          </span>{' '}
        </React.Fragment>
      ))}
    </div>
  )
}
