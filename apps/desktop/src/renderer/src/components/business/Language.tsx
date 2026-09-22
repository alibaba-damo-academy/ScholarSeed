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
  type AssistantTranslationTarget
} from '../../contracts/assistant'
import { Icon } from '../../icons'

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
