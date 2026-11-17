import React, { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import { WEB_SEARCH_PRESENTATION } from '../../activity'
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, ScrollArea } from '../ui'
import {
  TOOL_ACTIVITY_DETAIL_INSET_CLASS,
  TOOL_ACTIVITY_LABEL_CLASS,
  TOOL_RUN_STEP_CARET_CLASS,
  TOOL_RUN_STEP_TRIGGER_CLASS,
} from './Execution'

export interface WebRecordResult {
  id: string
  title: string
  url?: string
  site?: string
  publishedDate?: string
  contentType?: string
}

export interface WebSearchRecordProps {
  title: React.ReactNode
  queries: string[]
  page?: string
  pattern?: string
  results: WebRecordResult[]
  showKeywordCount?: boolean
  statusIcon?: React.ReactNode
  statusLabel?: string
  groupOpen?: boolean
  onOpenResult?: (result: WebRecordResult) => Promise<unknown> | void
}

export function WebSearchRecord({
  title,
  queries,
  page,
  pattern,
  results,
  showKeywordCount = true,
  statusIcon,
  statusLabel,
  groupOpen = true,
  onOpenResult,
}: WebSearchRecordProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const resultsId = useId()
  const [expanded, setExpanded] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const [opening, setOpening] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const hiddenCount = Math.max(0, results.length - WEB_SEARCH_PRESENTATION.previewCount)
  const displayedResults = expanded
    ? results
    : results.slice(0, WEB_SEARCH_PRESENTATION.previewCount)
  const hasDetails = Boolean(queries.length || page || pattern || results.length)
  const resultCount = t('stream.search.results', { count: results.length })
  const summary = showKeywordCount
    ? t('stream.search.summary', {
        keywords: t('stream.search.keywords', { count: queries.length }),
        results: resultCount,
      })
    : resultCount
  const openResult = async (result: WebRecordResult): Promise<void> => {
    if (!onOpenResult || !result.url || opening !== null) return
    setOpening(result.id)
    setFailed(null)
    try {
      await onOpenResult(result)
    } catch {
      setFailed(result.id)
    } finally {
      setOpening(null)
    }
  }
  return (
    <Collapsible
      open={detailsOpen}
      onOpenChange={setDetailsOpen}
      className="min-w-0 !gap-0 font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]"
    >
      <CollapsibleTrigger asChild>
        <Button
          unstyled
          disabled={!hasDetails}
          tabIndex={groupOpen ? 0 : -1}
          className={`${TOOL_RUN_STEP_TRIGGER_CLASS} ${
            showKeywordCount
              ? '!min-h-[var(--vds-control-height-sm)] !py-[0px]'
              : `${TOOL_ACTIVITY_LABEL_CLASS} !py-[var(--vds-space-half)]`
          }`}
          data-testid="web-search-node"
        >
          {statusIcon}
          <span className="min-w-0 flex-1 break-words">{title}</span>
          {statusLabel ? <span className="sr-only">{statusLabel}</span> : null}
          {hasDetails ? (
            <span className={TOOL_RUN_STEP_CARET_CLASS}>
              <Icon name="chevron-right" size={12} sw={1.8} />
            </span>
          ) : null}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={`${TOOL_ACTIVITY_DETAIL_INSET_CLASS} group/record-card min-w-0 !p-0 !pb-[calc(var(--vds-space-2)+var(--vds-space-half))] !bg-transparent !rounded-[var(--vds-radius-6)] !border-[var(--vds-divider-default)] text-[length:var(--vds-font-caption)] !text-[var(--vds-text-tertiary)] leading-[var(--vds-lh-caption)]`}
        data-testid="web-search-step"
      >
        <div
          className="grid min-h-[var(--vds-control-height-lg)] min-w-0 content-center whitespace-normal px-[calc(var(--vds-space-2)+var(--vds-space-half))] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] [overflow-wrap:anywhere]"
          data-testid="web-search-summary"
        >
          {summary}
        </div>
        <ScrollArea
          overlay
          shadow="auto"
          className="!rounded-none before:!bg-[linear-gradient(to_bottom,var(--vds-bg-gray-default),transparent)] after:!bg-[linear-gradient(to_top,var(--vds-bg-gray-default),transparent)] [&>[role=scrollbar]]:pointer-events-none [&>[role=scrollbar]]:opacity-0 group-hover/record-card:[&>[role=scrollbar]]:pointer-events-auto group-hover/record-card:[&>[role=scrollbar]]:opacity-[var(--vds-opacity-full)] [&>[role=scrollbar]:focus-visible]:opacity-[var(--vds-opacity-full)]"
          viewportClassName="max-h-[var(--vds-execution-detail-height)] px-[calc(var(--vds-space-2)+var(--vds-space-half))]"
          viewportProps={{ 'aria-label': summary, tabIndex: groupOpen ? 0 : -1 }}
        >
          <div className="grid min-w-0 gap-[var(--vds-space-1)]">
            {queries.length ? (
              <ul
                className="m-0 grid list-none gap-[var(--vds-space-1)] p-0"
                aria-label={t('stream.search.query')}
              >
                {queries.map((query, index) => (
                  <li
                    key={index}
                    className="flex min-w-0 items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-2)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]"
                  >
                    <Icon
                      name="search"
                      size={12}
                      className="shrink-0 !text-[var(--vds-icon-outline-muted)]"
                    />
                    <span className="min-w-0 truncate" title={query}>
                      {query}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {page ? (
              <div>
                <span className="text-[var(--vds-text-tertiary)]">{t('stream.search.page')}</span>
                <div className="whitespace-pre-wrap break-all">{page}</div>
              </div>
            ) : null}
            {pattern ? (
              <div>
                <span className="text-[var(--vds-text-tertiary)]">
                  {t('stream.search.pattern')}
                </span>
                <div className="whitespace-pre-wrap break-words">{pattern}</div>
              </div>
            ) : null}
            {results.length ? (
              <div
                id={resultsId}
                className="grid min-w-0 gap-[var(--vds-space-1)]"
                data-testid="web-search-results"
              >
                {displayedResults.map((result) => (
                  <div key={result.id} className="grid min-w-0 gap-[var(--vds-space-1)]">
                    <div className="flex min-w-0 items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-2)] bg-[var(--vds-other-overlay-1)] px-[var(--vds-space-2)] py-[var(--vds-space-1)]">
                      <Icon
                        name="globe"
                        size={12}
                        className="shrink-0 !text-[var(--vds-icon-outline-muted)]"
                      />
                      <Button
                        unstyled
                        type="button"
                        tabIndex={groupOpen ? 0 : -1}
                        disabled={!result.url || !onOpenResult || opening !== null}
                        title={result.title || result.url}
                        aria-label={result.title || result.url}
                        onClick={() => void openResult(result)}
                        className="block min-w-0 flex-1 truncate text-left !font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)] hover:underline"
                      >
                        {result.title || result.url}
                      </Button>
                      {result.site ? (
                        <span
                          className="max-w-[var(--vds-retrieval-site-width)] shrink-0 truncate text-[var(--vds-text-placeholder)]"
                          title={result.site}
                        >
                          {result.site}
                        </span>
                      ) : null}
                    </div>
                    {(result.publishedDate || result.contentType) && (
                      <div className="min-w-0 break-words px-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">
                        {[result.publishedDate, result.contentType].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {failed === result.id ? (
                      <div role="alert" className="text-[var(--vds-error-text-primary)]">
                        {t('stream.search.openFailed')}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {hiddenCount > 0 ? (
          <Button
            unstyled
            type="button"
            tabIndex={groupOpen ? 0 : -1}
            aria-expanded={expanded}
            aria-controls={resultsId}
            onClick={() => setExpanded((previous) => !previous)}
            className="mx-[calc(var(--vds-space-2)+var(--vds-space-half))] mt-[var(--vds-space-1)] text-[var(--vds-text-tertiary)] hover:underline focus-visible:underline"
          >
            {expanded
              ? t('stream.search.collapse')
              : t('stream.search.more', { count: hiddenCount })}
          </Button>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
