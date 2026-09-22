import { useTranslation } from 'react-i18next'
import React from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui'
import type { TranslationDirection, TranslationSentence } from './analysis'

export function Language({ value, disabled, onChange }: { value: TranslationDirection; disabled?: boolean; onChange: (value: TranslationDirection) => void }): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return <Select size="sm" value={value} disabled={disabled} onValueChange={next => onChange(next as TranslationDirection)}><SelectTrigger aria-label={t('translation.direction')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">{t('translation.auto')}</SelectItem><SelectItem value="en">{t('translation.toEnglish')}</SelectItem><SelectItem value="zh">{t('translation.toChinese')}</SelectItem></SelectContent></Select>
}

export function Translation({ sentences, active, onSelect }: { sentences: TranslationSentence[]; active: string; onSelect: (sentence: TranslationSentence) => void }): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return <div className="cursor-text select-text text-sm leading-8" data-testid="translation-sentences">{sentences.map((sentence, index) => <React.Fragment key={index}>{index > 0 && sentence.paragraph_start === true && <span className="block h-4" />}<span role="button" tabIndex={0} aria-pressed={active === sentence.source_text} title={sentence.located ? sentence.source_text : t('translation.unlocated')} onClick={() => onSelect(sentence)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(sentence) } }} className={`cursor-pointer rounded box-decoration-clone outline-none focus-visible:ring-2 focus-visible:ring-[var(--vds-border-default)] ${sentence.heading === true ? 'font-semibold' : ''} ${active === sentence.source_text ? 'bg-[var(--vds-brand-light-bg-default)] ring-2 ring-[var(--vds-brand-light-bg-hover)]' : ''}`}>{sentence.translated_text}</span>{' '}</React.Fragment>)}</div>
}
