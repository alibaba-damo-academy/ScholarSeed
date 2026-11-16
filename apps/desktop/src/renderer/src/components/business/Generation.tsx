import React from 'react'
import { useTranslation } from 'react-i18next'
import type { ReadingMetadata } from '../../contracts/literature'
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Divider, IconButton } from '../ui'
import { Icon } from '../../icons'

export function GenerationDetails({
  label,
  testId,
  children,
}: {
  label: string
  testId: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Collapsible
      className="!gap-0 font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] [overflow-wrap:anywhere] [&_dt]:text-[var(--vds-text-tertiary)]"
      data-testid={testId}
    >
      <Divider />
      <div className="flex items-center gap-[var(--vds-space-1)] py-[var(--vds-space-2)]">
        <CollapsibleTrigger asChild>
          <IconButton
            className="group"
            size="xs"
            variant="ghostIcon"
            label={label}
            icon={
              <span className="inline-flex group-data-[state=open]:rotate-90">
                <Icon name="chevron-right" size={12} />
              </span>
            }
          />
        </CollapsibleTrigger>
        <span>{label}</span>
      </div>

      <CollapsibleContent className="!border-0 !bg-transparent !p-0 !text-inherit">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Developer diagnostics: missing observations stay unknown; durations are not additive. */
export function Generation({ metadata: m }: { metadata: ReadingMetadata }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const number = (value: number | null | undefined): string =>
    value == null ? t('summary.diagnostics.unknown') : value.toLocaleString()
  const seconds = (value: number | null | undefined): string =>
    value == null
      ? t('summary.diagnostics.unknown')
      : t('summary.diagnostics.seconds', { value: value.toFixed(2) })
  const usage = m.usage
  const total =
    usage.input_tokens == null || usage.output_tokens == null
      ? null
      : usage.input_tokens + usage.output_tokens
  const repairs =
    m.l1_retries == null && m.citation_retries == null && m.reading_retries == null
      ? null
      : (m.l1_retries ?? 0) + (m.citation_retries ?? 0) + (m.reading_retries ?? 0)
  const timing = [
    ['summary.diagnostics.prepare', m.preparation_seconds],
    ['summary.diagnostics.total', m.ui_timing?.total_seconds],
    ['summary.diagnostics.backend', m.elapsed_seconds],
    ['summary.diagnostics.request', m.request_seconds],
  ] as const
  return (
    <div className="grid">
      <GenerationDetails label={t('summary.details')} testId="reading-details">
        <div className="mt-[var(--vds-space-3)] grid gap-[var(--vds-space-3)]">
          <dl className="grid gap-[var(--vds-space-3)]">
            <div>
              <dt>{t('summary.diagnostics.first')}</dt>
              <dd>{seconds(m.ui_timing?.first_seconds)}</dd>
            </div>
            <div>
              <dt>{t('summary.diagnostics.reading')}</dt>
              <dd>{seconds(m.ui_timing?.reading_seconds)}</dd>
            </div>
            <div>
              <dt>{t('summary.diagnostics.tokens')}</dt>
              <dd>
                {t('summary.diagnostics.tokenValues', {
                  total: number(total),
                  input: number(usage.input_tokens),
                  output: number(usage.output_tokens),
                })}
              </dd>
            </div>
            <div>
              <dt>{t('summary.diagnostics.calls')}</dt>
              <dd>
                {t('summary.diagnostics.callValues', {
                  total: number(usage.calls),
                  repairs: number(repairs),
                })}
              </dd>
            </div>
          </dl>
          <p className="text-[var(--vds-text-secondary)]">
            {t('summary.diagnostics.overviewNote')}
          </p>
        </div>
      </GenerationDetails>
      <GenerationDetails
        label={t('summary.diagnostics.technical')}
        testId="reading-technical-details"
      >
        <dl className="mt-[var(--vds-space-3)] grid gap-[var(--vds-space-3)]">
          <div>
            <dt>{t('summary.generatedModel')}</dt>
            <dd>{m.model_key}</dd>
          </div>
          {m.generated_at && (
            <div>
              <dt>{t('summary.generatedAt')}</dt>
              <dd>{new Date(m.generated_at).toLocaleString()}</dd>
            </div>
          )}
          <div>
            <dt>{t('summary.diagnostics.validation')}</dt>
            <dd>
              {t('summary.diagnostics.states', {
                l1: m.l1_status ?? t('summary.diagnostics.unknown'),
                citation: m.citation_diagnostic || t('summary.diagnostics.citationValid'),
              })}
            </dd>
          </div>
          <div>
            <dt>{t('summary.diagnostics.cache')}</dt>
            <dd>
              {m.l1_reused
                ? t('summary.diagnostics.l1Reused')
                : m.index_cache_hit == null
                  ? t('summary.diagnostics.unknown')
                  : t(m.index_cache_hit ? 'summary.diagnostics.hit' : 'summary.diagnostics.miss')}
            </dd>
          </div>
          {timing.map(([label, value]) => (
            <div key={label}>
              <dt>{t(label)}</dt>
              <dd>{seconds(value)}</dd>
            </div>
          ))}
          <div>
            <dt>{t('summary.diagnostics.boundary')}</dt>
            <dd>{t('summary.diagnostics.timingNote')}</dd>
          </div>
          <div>
            <dt>{t('summary.diagnostics.invocations')}</dt>
            <dd className="space-y-[var(--vds-space-3)]">
              {m.invocations?.length
                ? m.invocations.map((call, index) => (
                    <div
                      key={call.id}
                      className="border-l border-[var(--vds-border-default)] pl-[var(--vds-space-3)]"
                    >
                      <div>
                        {index + 1}. {call.prompt_version || t('summary.diagnostics.unknown')} ·{' '}
                        {call.status || t('summary.diagnostics.unknown')}
                      </div>
                      <div>
                        {t('summary.diagnostics.callUsage', {
                          input: number(call.input_tokens),
                          output: number(call.output_tokens),
                          seconds: seconds(call.elapsed_seconds),
                        })}
                      </div>
                      <div>
                        {t('summary.diagnostics.callStart', {
                          seconds: seconds(call.start_seconds),
                        })}
                      </div>
                      <div>
                        {call.model_key} · {call.id}
                      </div>
                    </div>
                  ))
                : t('summary.diagnostics.unknown')}
            </dd>
          </div>
          <div>
            <dt>{t('summary.diagnostics.trace')}</dt>
            <dd>
              <div>{m.task_id || t('summary.diagnostics.unknown')}</div>
              <div>{m.reading_version || m.prompt_version || t('summary.diagnostics.unknown')}</div>
              {(m.l1_diagnostic || m.citation_diagnostic) && (
                <div>{m.l1_diagnostic || m.citation_diagnostic}</div>
              )}
              {m.l1_retry_mode && (
                <div>
                  {t('summary.diagnostics.retry', {
                    mode: m.l1_retry_mode,
                    original: m.l1_retry_includes_original
                      ? t('summary.diagnostics.yes')
                      : t('summary.diagnostics.no'),
                  })}
                </div>
              )}
            </dd>
          </div>
        </dl>
      </GenerationDetails>
    </div>
  )
}
