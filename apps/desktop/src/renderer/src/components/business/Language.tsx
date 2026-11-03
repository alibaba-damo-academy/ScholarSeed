import React from 'react'
import { useTranslation } from 'react-i18next'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui'
import {
  ASSISTANT_TRANSLATION_TARGETS,
  isAssistantTranslationTarget,
  type AssistantTranslationTarget,
} from '../../contracts/assistant'

const TRANSLATION_TARGET_STORAGE_PREFIX = 'scholarseed.translation.target.'
const TRANSLATION_TARGET_GLOBAL_KEY = 'scholarseed.translation.target'
const TRANSLATION_MODEL_STORAGE_PREFIX = 'scholarseed.translation.model.'
export type TranslationPreferenceScope =
  'literature-document' | 'literature-selection' | 'resource-selection'

function storageKey(prefix: string, scope: TranslationPreferenceScope): string {
  return `${prefix}${scope}`
}

export function readTranslationTarget(
  scope: TranslationPreferenceScope
): AssistantTranslationTarget | undefined {
  if (typeof window === 'undefined') return undefined
  const value =
    window.localStorage.getItem(TRANSLATION_TARGET_GLOBAL_KEY) ??
    window.localStorage.getItem(storageKey(TRANSLATION_TARGET_STORAGE_PREFIX, scope))
  if (value && isAssistantTranslationTarget(value)) {
    window.localStorage.setItem(TRANSLATION_TARGET_GLOBAL_KEY, value)
    return value
  }
  return undefined
}

export function writeTranslationTarget(
  scope: TranslationPreferenceScope,
  value: AssistantTranslationTarget
): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(TRANSLATION_TARGET_GLOBAL_KEY, value)
    window.localStorage.setItem(storageKey(TRANSLATION_TARGET_STORAGE_PREFIX, scope), value)
  }
}

export function readTranslationModel(scope: TranslationPreferenceScope): string | undefined {
  if (typeof window === 'undefined') return undefined
  const value = window.localStorage.getItem(storageKey(TRANSLATION_MODEL_STORAGE_PREFIX, scope))
  return value || undefined
}

export function writeTranslationModel(scope: TranslationPreferenceScope, value: string): void {
  if (typeof window !== 'undefined')
    window.localStorage.setItem(storageKey(TRANSLATION_MODEL_STORAGE_PREFIX, scope), value)
}

export function detectTranslationSource(text: string): 'zh' | 'en' | 'other' | undefined {
  const chinese = (text.match(/[\u3400-\u9fff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length
  const cyrillic = (text.match(/[\u0400-\u04ff]/g) ?? []).length
  const total = chinese + latin + kana + cyrillic
  if (total === 0) return undefined
  if (chinese >= latin && chinese >= kana && chinese >= cyrillic) return 'zh'
  if (latin >= kana && latin >= cyrillic) return 'en'
  return 'other'
}

export function defaultTranslationTarget(
  uiLanguage: string | undefined,
  sourceText: string
): AssistantTranslationTarget {
  const source = detectTranslationSource(sourceText)
  const englishUi = uiLanguage?.toLowerCase().startsWith('en') === true
  if (englishUi) return source === 'en' ? 'zh-CN' : 'en'
  return source === 'zh' ? 'en' : 'zh-CN'
}

const TRANSLATION_LANGUAGE_KEYS = {
  'zh-CN': 'translation.languages.zh-CN',
  en: 'translation.languages.en',
} as const satisfies Record<AssistantTranslationTarget, string>

export function TranslationTargetPicker({
  value,
  disabled,
  onChange,
}: {
  value: AssistantTranslationTarget
  disabled?: boolean
  onChange: (value: AssistantTranslationTarget) => void
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const languageName = (target: AssistantTranslationTarget): string =>
    t(TRANSLATION_LANGUAGE_KEYS[target])

  return (
    <Select
      disabled={disabled}
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (isAssistantTranslationTarget(next)) onChange(next)
      }}
    >
      <SelectTrigger aria-label={t('translation.targetLanguage')} className="min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ASSISTANT_TRANSLATION_TARGETS.map((target) => (
          <SelectItem key={target} value={target}>
            {languageName(target)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
