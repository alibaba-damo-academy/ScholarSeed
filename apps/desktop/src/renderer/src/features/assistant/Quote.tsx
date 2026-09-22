import React from 'react'
import { useTranslation } from 'react-i18next'

import { Button, ScrollArea } from '../../components/ui'

export interface AssistantContextQuoteProps {
  label: string
  onOpenSource?: () => void
  sourceId: string
  text: string
}

export function AssistantContextQuote({
  label,
  onOpenSource,
  sourceId,
  text
}: AssistantContextQuoteProps): React.JSX.Element {
  const { t } = useTranslation('assistant')
  return (
    <div
      className="w-full min-w-0"
      data-testid="assistant-selection-quote"
    >
      <blockquote className="m-0 flex flex-col gap-[var(--vds-space-3)]">
        <ScrollArea
          className="max-h-44"
          viewportClassName="max-h-44 whitespace-pre-wrap [overflow-wrap:anywhere] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] leading-relaxed text-[var(--vds-text-secondary)]"
        >
          {text}
        </ScrollArea>
        {onOpenSource ? (
          <Button
            aria-label={t('quote.open', { name: label })}
            className="order-first w-fit max-w-full whitespace-normal [overflow-wrap:anywhere] text-left text-[length:var(--vds-font-body-lv1)] font-medium text-[var(--vds-text-secondary)] hover:underline focus-visible:underline"
            data-testid="assistant-selection-open-source"
            unstyled
            onClick={onOpenSource}
          >
            {label} · {sourceId}
          </Button>
        ) : (
          <cite className="order-first [overflow-wrap:anywhere] not-italic text-[length:var(--vds-font-body-lv1)] font-medium text-[var(--vds-text-secondary)]">
            {label} · {sourceId}
          </cite>
        )}
      </blockquote>
    </div>
  )
}
