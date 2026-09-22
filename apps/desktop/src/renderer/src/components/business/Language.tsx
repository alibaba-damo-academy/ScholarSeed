import { Check } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '../ui'
import {
  ASSISTANT_TRANSLATION_TARGETS,
  isAssistantTranslationTarget,
  type AssistantTranslationTarget
} from '../../contracts/assistant'
import { Icon } from '../../icons'

const TRANSLATION_TARGET_STORAGE_PREFIX = 'scholarseed.translation.target.'
const TRANSLATION_MODEL_STORAGE_PREFIX = 'scholarseed.translation.model.'
export type TranslationPreferenceScope = 'literature-document' | 'literature-selection' | 'resource-selection'

function storageKey(prefix: string, scope: TranslationPreferenceScope): string {
  return `${prefix}${scope}`
}

export function readTranslationTarget(scope: TranslationPreferenceScope): AssistantTranslationTarget | undefined {
  if (typeof window === 'undefined') return undefined
  const value = window.localStorage.getItem(storageKey(TRANSLATION_TARGET_STORAGE_PREFIX, scope))
  return isAssistantTranslationTarget(value) ? value : undefined
}

export function writeTranslationTarget(scope: TranslationPreferenceScope, value: AssistantTranslationTarget): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(storageKey(TRANSLATION_TARGET_STORAGE_PREFIX, scope), value)
}

export function readTranslationModel(scope: TranslationPreferenceScope): string | undefined {
  if (typeof window === 'undefined') return undefined
  const value = window.localStorage.getItem(storageKey(TRANSLATION_MODEL_STORAGE_PREFIX, scope))
  return value || undefined
}

export function writeTranslationModel(scope: TranslationPreferenceScope, value: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(storageKey(TRANSLATION_MODEL_STORAGE_PREFIX, scope), value)
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

export function defaultTranslationTarget(uiLanguage: string | undefined, sourceText: string): AssistantTranslationTarget {
  const source = detectTranslationSource(sourceText)
  const englishUi = uiLanguage?.toLowerCase().startsWith('en') === true
  if (englishUi) return source === 'en' ? 'zh-CN' : 'en'
  return source === 'zh' ? 'en' : 'zh-CN'
}

type TranslationLanguageKey = `translation.languages.${AssistantTranslationTarget}`

export function TranslationTargetPicker({
  value,
  disabled,
  onChange
}: {
  value: AssistantTranslationTarget
  disabled?: boolean
  onChange: (value: AssistantTranslationTarget) => void
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const languageName = (target: AssistantTranslationTarget): string => (
    t(`translation.languages.${target}` as TranslationLanguageKey)
  )

  return <Popover open={open} onOpenChange={(next) => {
    setOpen(next)
    if (!next) setSearch('')
  }}>
    <PopoverTrigger asChild>
      <Button
        aria-label={t('translation.targetLanguage')}
        aria-expanded={open}
        className="min-w-0 justify-between"
        disabled={disabled}
        size="sm"
        variant="outline"
      >
        {languageName(value)}
        <Icon name="chevron-down" size={13} />
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-[var(--vds-popover-width-md)] p-0">
      <Command
        searchValue={search}
        value={value}
        onSearchValueChange={setSearch}
        onValueChange={(next) => {
          onChange(next as AssistantTranslationTarget)
          setOpen(false)
          setSearch('')
        }}
      >
        <CommandInput
          aria-label={t('translation.searchLanguage')}
          placeholder={t('translation.searchLanguage')}
        />
        <CommandList>
          <CommandEmpty>{t('translation.noLanguages')}</CommandEmpty>
          <CommandGroup heading={t('translation.targetLanguage')}>
            {ASSISTANT_TRANSLATION_TARGETS.map((target) => (
              <CommandItem key={target} keywords={[target]} value={target}>
                <span className="min-w-0 flex-1">{languageName(target)}</span>
                {target === value ? <Check size={13} /> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
