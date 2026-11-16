import React from 'react'
import { useTranslation } from 'react-i18next'
import { TextSelect } from 'lucide-react'
import { SelectionQuote, SentReferenceAttachment } from '../../components/primitive'
import type { MessageReference } from '../../model'
import { selectionReferenceGroups } from './grouping'

export function SelectionReferences({
  references,
  label,
  onOpen,
}: {
  references: MessageReference[]
  label: (reference: MessageReference) => string
  onOpen: (reference: MessageReference) => void
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  return (
    <div className="contents" data-testid="sent-selection-groups">
      {selectionReferenceGroups(references).map((group) => (
        <SentReferenceAttachment
          key={group.identity}
          data-testid="sent-selection-group"
          icon={<TextSelect />}
          label={t('contextGroups.selections', { count: group.references.length })}
          description={label(group.references[0])}
          details={
            <div className="grid gap-[var(--vds-space-1)]">
              {group.references.map((reference) => (
                <SelectionQuote
                  key={reference.id}
                  label={t('quote.open', { name: label(reference) })}
                  onOpen={reference.sourceId ? () => onOpen(reference) : undefined}
                  text={reference.anchor?.previewText || t('contextGroups.unavailable')}
                />
              ))}
            </div>
          }
        />
      ))}
    </div>
  )
}
