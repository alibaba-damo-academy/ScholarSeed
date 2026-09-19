import type { TFunction } from 'i18next'
import { resourceNameSuggestion } from '../resources/state.ts'

const EXCERPT_NAME_MAX_LENGTH = 18
const EXCERPT_PUNCTUATION_PATTERN = /[，。；：！？、]/gu

export function defaultExcerptName(text: string, t: TFunction<'assistant'>): string {
  const fallback = t('excerptName.default')
  const normalized = resourceNameSuggestion(
    text.replace(EXCERPT_PUNCTUATION_PATTERN, ' '),
    fallback
  )
  const subject = normalized.split(' ').filter(Boolean).slice(0, 2).join('')
  if (!subject || subject === fallback) return fallback
  return t('excerptName.named', { subject: subject.slice(0, EXCERPT_NAME_MAX_LENGTH) })
}
