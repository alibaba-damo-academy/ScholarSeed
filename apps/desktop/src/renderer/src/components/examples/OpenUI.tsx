import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import {
  upstreamCollection,
  upstreamEntries,
} from '../../../../../../../packages/ui/preview/upstream'
import { Preview } from '../../../../../../../packages/ui/preview/page'
import { LABEL_KEYS } from './labels'
import {
  Alert,
  AlertDescription,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui'

const PREFIX = 'openui-'
export const openUIEntries = upstreamEntries.map((entry) => ({
  ...entry,
  id: `${PREFIX}${entry.name}`,
}))

export function OpenUIDirectory({
  activeId,
  onSelect,
  label,
  number,
  testId = 'openui-directory',
}: {
  activeId: string
  onSelect: (id: string) => void
  label?: string
  number?: string
  testId?: string
}): JSX.Element {
  const { t } = useTranslation('official')
  return (
    <Collapsible defaultOpen={activeId.startsWith(PREFIX)} data-testid={testId}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size={number ? 'content' : undefined}
          className={
            number
              ? 'w-full min-w-0 items-start justify-start gap-[var(--vds-space-2)] !whitespace-normal px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-left'
              : 'w-full justify-start'
          }
          data-scene-number={number}
        >
          {number && (
            <span
              aria-hidden
              className="shrink-0 font-[var(--vds-font-code)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-tertiary)]"
            >
              {number}
            </span>
          )}
          <span className={number ? 'min-w-0 flex-1 break-words' : undefined}>
            {label ?? t('upstream.title')} ({openUIEntries.length})
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-[var(--vds-space-1)]">
        {openUIEntries.map((entry) => (
          <Button
            key={entry.id}
            variant="ghost"
            size="content"
            aria-current={activeId === entry.id ? 'page' : undefined}
            data-upstream-export={entry.name}
            onClick={() => onSelect(entry.id)}
            className="w-full justify-start px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-left"
          >
            {LABEL_KEYS[entry.name as keyof typeof LABEL_KEYS]
              ? t(LABEL_KEYS[entry.name as keyof typeof LABEL_KEYS])
              : (entry.label ?? entry.name)}
          </Button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function OpenUIPreview({ name }: { name: string }): JSX.Element {
  const { t } = useTranslation('official')
  return (
    <>
      <Alert tone="neutral">
        <AlertDescription>{t('upstream.notice')}</AlertDescription>
      </Alert>
      <Preview sample={name} collection={upstreamCollection} />
    </>
  )
}
