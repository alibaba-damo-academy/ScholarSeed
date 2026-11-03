import React from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../../../components/primitive/Markdown'
import { Button } from '../../../components/ui'
import type { PdfAiContent, ReadingSummary } from './analysis'

export function Summary({
  value,
  onSource,
  provisional = false,
}: {
  value: ReadingSummary
  onSource: (page: number, text: string) => void
  provisional?: boolean
}): React.JSX.Element {
  const { t } = useTranslation(['literature', 'pdf'])
  const content = (item: PdfAiContent): React.JSX.Element => (
    <>
      <Markdown
        text={item.text}
        className="!text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-body-lv2)] !text-[var(--vds-text-secondary)]"
      />
      {item.uncertain && (
        <p className="text-xs text-[var(--vds-text-tertiary)]">{t('summary.uncertain')}</p>
      )}
      {!provisional && (
        <div className="mt-3 flex flex-wrap gap-1">
          {item.evidence?.map((anchor, index) => (
            <Button
              key={index}
              size="sm"
              variant="secondary"
              title={anchor.quote}
              onClick={() => onSource(anchor.page, anchor.quote)}
            >
              {t('reading.evidencePage', { ns: 'pdf', page: anchor.page })}
            </Button>
          ))}
        </div>
      )}
    </>
  )
  return (
    <div
      className="cursor-text select-text p-5 text-sm leading-[var(--vds-pdf-reading-body-line-height)]"
      data-testid="reading-summary"
    >
      <div className="mb-5 flex gap-2 text-xs text-[var(--vds-text-tertiary)]">
        <span className="rounded bg-[var(--vds-surface-muted)] px-2 text-[var(--vds-brand-text-primary)]">
          {value.paper_type}
        </span>
        {!provisional && <span>{t('summary.basedOnFullText')}</span>}
      </div>
      <section className="mb-5 border-b border-[var(--vds-border-default)] pb-5">
        <h3 className="mb-3 font-semibold">{t('summary.contribution')}</h3>
        {content(value.contribution)}
      </section>
      <section className="mb-5 border-b border-[var(--vds-border-default)] pb-5">
        <h3 className="font-semibold">{t('summary.claims')}</h3>
        {value.claims.map((claim, index) => (
          <div key={index} className="mt-5 flex gap-3">
            <span className="h-6 w-6 flex-none rounded-full bg-[var(--vds-surface-muted)] text-center text-[var(--vds-brand-text-primary)]">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              {content(claim)}
              {Boolean(claim.evidence?.length) && (
                <details className="mt-3 text-xs text-[var(--vds-text-tertiary)]">
                  <summary className="cursor-pointer">{t('summary.evidence')}</summary>
                  {claim.evidence?.map((anchor, key) => (
                    <blockquote
                      key={key}
                      className="my-2 border-l-2 border-[var(--vds-border-default)] pl-3"
                    >
                      {anchor.quote}
                    </blockquote>
                  ))}
                </details>
              )}
            </div>
          </div>
        ))}
      </section>
      <details className="mb-5 border-b border-[var(--vds-border-default)] pb-5">
        <summary className="mb-3 cursor-pointer font-semibold">{t('summary.method')}</summary>
        {content(value.method)}
      </details>
      <details className="mb-5 border-b border-[var(--vds-border-default)] pb-5">
        <summary className="mb-3 cursor-pointer font-semibold">{t('summary.limitations')}</summary>
        {content(value.limitations)}
      </details>
    </div>
  )
}
