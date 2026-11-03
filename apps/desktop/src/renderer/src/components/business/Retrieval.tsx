import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../icons'
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui'

const INITIAL_VISIBLE_RESULTS = 3

export interface WebRecordResult {
  id: string
  title: string
  url?: string
  site?: string
}

export interface WebSearchRecordProps {
  title: string
  queries: string[]
  page?: string
  pattern?: string
  results: WebRecordResult[]
  status?: React.ReactNode
  groupOpen?: boolean
  defaultExpanded?: boolean
  initialVisibleResults?: number
  onOpenResult?: (result: WebRecordResult) => Promise<unknown> | void
}

export function WebSearchRecord({
  title,
  queries,
  page,
  pattern,
  results,
  status,
  groupOpen = true,
  defaultExpanded = false,
  initialVisibleResults = INITIAL_VISIBLE_RESULTS,
  onOpenResult,
}: WebSearchRecordProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const [all, setAll] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const visibleCount = Number.isFinite(initialVisibleResults)
    ? Math.max(1, Math.floor(initialVisibleResults))
    : INITIAL_VISIBLE_RESULTS
  const hiddenCount = Math.max(0, results.length - visibleCount)
  const displayed = all ? results : results.slice(0, visibleCount)
  const hasDetails = Boolean(queries.length || page || pattern || results.length)
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
      defaultOpen={defaultExpanded}
      className="!gap-0 !border-0 !bg-transparent"
      data-testid="web-search-step"
    >
      <CollapsibleTrigger asChild>
        <Button
          unstyled
          type="button"
          tabIndex={groupOpen ? 0 : -1}
          disabled={!hasDetails}
          className="group/record flex min-h-[var(--vds-control-height-md)] w-full min-w-0 items-center gap-[var(--vds-space-2)] !border-0 !bg-transparent px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-left text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)] !shadow-none"
        >
          <Icon name="globe" size={14} />
          <span className="min-w-0 flex-1 truncate" title={title}>
            {title}
          </span>
          {status ? (
            <span className="shrink-0 text-[var(--vds-text-tertiary)]">{status}</span>
          ) : null}
          {hasDetails ? (
            <Icon
              name="chevron-right"
              size={12}
              className="shrink-0 transition-transform group-aria-expanded/record:rotate-90"
            />
          ) : null}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="!border-0 !bg-transparent !px-[var(--vds-space-2)] !py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] !shadow-none">
        <div className="grid min-w-0 gap-[var(--vds-space-3)]">
          {queries.length ? (
            <ul
              className="m-0 grid list-none gap-[var(--vds-space-2)] p-0"
              aria-label={t('stream.search.query')}
            >
              {queries.map((query, index) => (
                <li key={index} className="flex min-w-0 items-start gap-[var(--vds-space-2)]">
                  <Icon name="search" size={14} className="shrink-0" />
                  <span className="whitespace-pre-wrap break-words">{query}</span>
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
              <span className="text-[var(--vds-text-tertiary)]">{t('stream.search.pattern')}</span>
              <div className="whitespace-pre-wrap break-words">{pattern}</div>
            </div>
          ) : null}
          {results.length ? (
            <div className="grid min-w-0 gap-[var(--vds-space-2)]" data-testid="web-search-results">
              {displayed.map((result) => (
                <div key={result.id} className="grid min-w-0 gap-[var(--vds-space-1)]">
                  <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                    <Icon
                      name="globe"
                      size={14}
                      className="shrink-0 text-[var(--vds-text-tertiary)]"
                    />
                    <Button
                      unstyled
                      type="button"
                      tabIndex={groupOpen ? 0 : -1}
                      disabled={!result.url || !onOpenResult || opening !== null}
                      title={result.title || result.url}
                      aria-label={result.title || result.url}
                      onClick={() => void openResult(result)}
                      className="block min-w-0 flex-1 truncate text-left text-[var(--vds-text-primary)] hover:underline"
                    >
                      {result.title || result.url}
                    </Button>
                    {result.site ? (
                      <span
                        className="max-w-[var(--vds-retrieval-site-width)] shrink-0 truncate text-[var(--vds-text-tertiary)]"
                        title={result.site}
                      >
                        {result.site}
                      </span>
                    ) : null}
                  </div>
                  {failed === result.id ? (
                    <div role="alert" className="text-[var(--vds-error-text-primary)]">
                      {t('stream.search.openFailed')}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {hiddenCount ? (
            <Button
              unstyled
              type="button"
              tabIndex={groupOpen ? 0 : -1}
              aria-expanded={all}
              onClick={() => setAll((value) => !value)}
              className="justify-self-start text-[var(--vds-text-tertiary)] hover:text-[var(--vds-text-primary)]"
            >
              {all
                ? t('stream.search.collapseResults')
                : t('stream.search.moreResults', { count: hiddenCount })}
            </Button>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
