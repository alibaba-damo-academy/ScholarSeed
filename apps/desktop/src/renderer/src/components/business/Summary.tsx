import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from '../primitive/Markdown'
import { CitationMarker } from '../primitive/Citation'
import { readingCitations } from './provenance'
import { Generation, GenerationDetails } from './Generation'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Divider,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
} from '../ui'
import { Icon } from '../../icons'
import type {
  PdfAiContent,
  ReadingAsset,
  ReadingEvidence,
  ReadingSection,
  ReadingSummary,
} from '../../contracts/literature'

const PAPER_TYPES = ['method', 'benchmark', 'survey', 'theory'] as const
const SECTION_TITLE_KEYS = {
  default: {
    problem: 'summary.sections.problem',
    method: 'summary.sections.method',
    results: 'summary.sections.results',
    limitations: 'summary.sections.limitations',
  },
  method: {
    problem: 'summary.typeSections.method.problem',
    method: 'summary.typeSections.method.method',
    results: 'summary.typeSections.method.results',
    limitations: 'summary.typeSections.method.limitations',
  },
  benchmark: {
    problem: 'summary.typeSections.benchmark.problem',
    method: 'summary.typeSections.benchmark.method',
    results: 'summary.typeSections.benchmark.results',
    limitations: 'summary.typeSections.benchmark.limitations',
  },
  survey: {
    problem: 'summary.typeSections.survey.problem',
    method: 'summary.typeSections.survey.method',
    results: 'summary.typeSections.survey.results',
    limitations: 'summary.typeSections.survey.limitations',
  },
  theory: {
    problem: 'summary.typeSections.theory.problem',
    method: 'summary.typeSections.theory.method',
    results: 'summary.typeSections.theory.results',
    limitations: 'summary.typeSections.theory.limitations',
  },
} as const satisfies Record<
  (typeof PAPER_TYPES)[number] | 'default',
  Record<ReadingSection['key'], string>
>
const SECTION_HEADING_CLASS =
  '!text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-subhead)] ![font-weight:var(--vds-fw-semibold)] !text-[var(--vds-text-primary)]'
const READING_TEXT_CLASS =
  '![font-family:var(--vds-font-main)] !text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-subhead)] !text-[var(--vds-text-primary)] [&_strong]:!text-inherit [&_.md-h]:!text-[length:var(--vds-font-body-lv2)] [&_.md-h]:!leading-[var(--vds-lh-subhead)] [&_.md-h]:!text-inherit [&_.md-quote]:!text-inherit [&_.md-table]:![font-family:inherit] [&_.md-table]:!text-[length:var(--vds-font-body-lv2)] [&_th]:!text-inherit [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:py-[var(--vds-space-2)] [&_.katex-display]:text-left'
// Keep equation layout and mathematical typography intact while prose shares one text style.
const FORMULA_CLASS =
  '[&_.md-p:first-child>.katex:first-of-type]:block [&_.md-p:first-child>.katex:first-of-type]:max-w-full [&_.md-p:first-child>.katex:first-of-type]:overflow-x-auto [&_.md-p:first-child>.katex:first-of-type]:py-[var(--vds-space-3)]'

function SummarySection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Collapsible defaultOpen className="!gap-[var(--vds-space-3)]">
      <h3 className={SECTION_HEADING_CLASS}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="content"
            className="group w-full !justify-start !gap-[var(--vds-space-1)] !p-0 !text-left ![font:inherit] !text-inherit hover:!bg-transparent"
          >
            <span
              aria-hidden="true"
              className="inline-block shrink-0 group-aria-expanded:rotate-90"
            >
              ▶
            </span>
            <span>{title}</span>
          </Button>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="!rounded-none !border-0 !bg-transparent !p-0 !text-inherit space-y-[var(--vds-space-3)]">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Evidence({
  source,
  index,
  onSource,
}: {
  source: ReadingEvidence
  index: number
  onSource: (source: ReadingEvidence) => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: citationText } = useTranslation('assistant')
  const [open, setOpen] = useState(false)
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <CitationMarker
          label={`[${index}]`}
          className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0 align-baseline text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-brand-text-primary)] [font-weight:var(--vds-fw-regular)] hover:underline focus-visible:underline focus-visible:outline-none"
          aria-label={citationText('citations.view', { label: `[${index}]` })}
          onClick={() => {
            setOpen(false)
            onSource(source)
          }}
        />
      </HoverCardTrigger>
      <HoverCardContent
        aria-label={t('summary.source')}
        className="!flex flex-col !w-[var(--vds-reading-source-width)] !max-w-[var(--vds-popover-available-width)] max-h-[var(--vds-dialog-list-max-height)] overflow-auto !gap-[var(--vds-space-2)] !rounded-[var(--vds-radius-6)] border-0 !bg-[var(--vds-surface-raised)] !p-[var(--vds-space-3)] !shadow-[var(--vds-shadow-2-center)] [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] !text-[var(--vds-text-secondary)] [font-weight:var(--vds-fw-regular)]"
      >
        <div className="flex items-center justify-between gap-[var(--vds-space-3)]">
          <h4 className="text-inherit [font:inherit]">{t('summary.source')}</h4>
          <Button
            size="content"
            variant="ghost"
            className="shrink-0 !p-0 !text-inherit [font:inherit]"
            onClick={() => {
              setOpen(false)
              onSource(source)
            }}
          >
            {t('summary.locateSource')}
          </Button>
        </div>
        <Divider className="!my-0" />
        <p className="text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-placeholder)]">
          {t('summary.reference', { page: source.page, index })}
        </p>
        <blockquote className="whitespace-pre-wrap [overflow-wrap:anywhere] border-l-[length:var(--vds-border-width-2)] border-[var(--vds-divider-default)] pl-[calc(var(--vds-space-1)+var(--vds-space-half))] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
          {source.quote || source.label}
        </blockquote>
      </HoverCardContent>
    </HoverCard>
  )
}

export function Summary({
  value,
  result,
  onSource,
  showSources = true,
}: {
  value: ReadingSummary
  result?: ReadingAsset
  onSource: (source: ReadingEvidence) => void
  showSources?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const evidenceNumbers = new Map<string, number>()
  const content = (item: PdfAiContent & { path?: string }): React.JSX.Element => {
    const { text, citations } = readingCitations(item, evidenceNumbers, showSources)
    return (
      <div className="min-w-0">
        <Markdown
          math
          text={text}
          renderCitation={(_range, _children, href) => {
            const citation = citations.find((item) => item.href === href)
            return citation ? (
              <Evidence source={citation.source} index={citation.number} onSource={onSource} />
            ) : null
          }}
          className={`${READING_TEXT_CLASS} ${/(?:^|\.)key_formulas(?:\[|$)/.test(item.path ?? '') ? FORMULA_CLASS : ''}`}
        />
        {item.origin === 'l1' && <p className="text-inherit">{t('summary.fromL1')}</p>}
        {showSources && item.source_warning && (
          <p className="text-inherit">{t('summary.sourceUnavailable')}</p>
        )}
      </div>
    )
  }
  const overviewSource = value.overview?.text?.trim()
    ? value.overview
    : value.text?.trim()
      ? { text: value.text }
      : value.contribution
  const overview: PdfAiContent = {
    ...overviewSource,
    evidence: [...(overviewSource.evidence ?? [])],
  }
  const candidates: ReadingSection[] =
    value.organized || value.sections?.length
      ? (value.sections ?? [])
      : [
          { key: 'problem' as const, items: [value.contribution] },
          { key: 'method' as const, items: [value.method] },
          { key: 'results' as const, items: value.claims },
          { key: 'limitations' as const, items: [value.limitations] },
        ]
  const seen = new Map<string, PdfAiContent>(
    overview.text?.trim() ? [[overview.text.trim(), overview]] : []
  )
  const sections = candidates
    .map((section) => ({
      ...section,
      items: section.items.flatMap((item) => {
        const text = item.text?.trim()
        if (!text) return []
        const previous = seen.get(text)
        if (previous && !value.organized) {
          previous.evidence = [...(previous.evidence ?? []), ...(item.evidence ?? [])]
          return []
        }
        const entry = { ...item, evidence: [...(item.evidence ?? [])] }
        seen.set(text, entry)
        return [entry]
      }),
    }))
    .filter((section) => section.items.length)
  const paperType = PAPER_TYPES.find((type) => type === value.paper_type)
  const metadata = result?.metadata
  return (
    <article
      className="min-w-0 cursor-text select-text space-y-[var(--vds-space-5)] p-[var(--vds-space-4)] [font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]"
      data-testid="reading-summary"
    >
      {value.organization === 'abstract' && (
        <p role="status" className="text-[var(--vds-text-tertiary)]">
          {t('summary.abstractFallback')}
        </p>
      )}
      {overview.text?.trim() && (
        <section className="rounded-[var(--vds-radius-3)] bg-[var(--vds-brand-light-bg-default)] p-[var(--vds-space-4)]">
          <SummarySection title={t('summary.overview')}>{content(overview)}</SummarySection>
        </section>
      )}
      {sections.map((section) => (
        <section
          key={section.key}
          className="space-y-[var(--vds-space-5)]"
          data-testid={`reading-section-${section.key}`}
        >
          <Divider />
          <SummarySection title={t(SECTION_TITLE_KEYS[paperType ?? 'default'][section.key])}>
            {section.items.map((item, index) => (
              <div key={index}>{content(item)}</div>
            ))}
          </SummarySection>
        </section>
      ))}
      {result && (
        <div hidden data-testid="reading-diagnostics">
          {metadata ? (
            <Generation metadata={metadata} />
          ) : (
            <GenerationDetails label={t('summary.details')} testId="reading-details">
              <dl className="mt-[var(--vds-space-3)]">
                <div>
                  <dt>{t('summary.generatedModel')}</dt>
                  <dd>{result.model_key}</dd>
                </div>
              </dl>
            </GenerationDetails>
          )}
        </div>
      )}
    </article>
  )
}
