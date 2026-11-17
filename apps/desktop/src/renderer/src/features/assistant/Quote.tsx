import React from 'react'
import { useTranslation } from 'react-i18next'

import { SelectionQuote } from '../../components/primitive'

export interface AssistantContextQuoteProps {
  label: string
  onOpenSource?: () => void
  onRemove?: () => void
  text: string
}

export function AssistantContextQuote({
  label,
  onOpenSource,
  onRemove,
  text,
}: AssistantContextQuoteProps): React.JSX.Element {
  const { t } = useTranslation('assistant')
  return (
    <div className="w-full min-w-0" data-testid="assistant-selection-quote">
      <SelectionQuote
        openTestId="assistant-selection-open-source"
        text={text}
        label={t('quote.open', { name: label })}
        onOpen={onOpenSource}
        onRemove={onRemove}
        removeLabel={t('panel.remove', { name: label })}
      />
    </div>
  )
}
