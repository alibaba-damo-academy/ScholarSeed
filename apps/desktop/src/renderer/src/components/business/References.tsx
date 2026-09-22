import { ArrowLeft, SearchX, X } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import type { AssistantContextCandidate, AssistantSourceFilter } from '../../contracts/assistant'
import { Button, EmptyState, IconButton, SearchBox } from '../ui'
import { ContextOption } from './Context'

const FILTERS: readonly AssistantSourceFilter[] = ['all', 'recent', 'newest']
const REFERENCE_PAGE_SIZE = 10

export function ReferencePicker({
  candidates,
  emptyLabel,
  filter,
  loading,
  onBack,
  onFilterChange,
  onQueryChange,
  onSelect,
  projectId,
  query,
  sourceLabel
}: {
  candidates: AssistantContextCandidate[]
  emptyLabel: React.ReactNode
  filter: AssistantSourceFilter
  loading: boolean
  onBack: () => void
  onFilterChange: (filter: AssistantSourceFilter) => void
  onQueryChange: (query: string) => void
  onSelect: (candidate: AssistantContextCandidate) => void
  projectId: string | null
  query: string
  sourceLabel: string
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const noMatch = Boolean(query.trim()) && !loading && candidates.length === 0
  const [visibleCount, setVisibleCount] = React.useState(REFERENCE_PAGE_SIZE)
  React.useEffect(() => {
    setVisibleCount(REFERENCE_PAGE_SIZE)
  }, [candidates])
  const visibleCandidates = candidates.slice(0, visibleCount)

  return (
    <div className="flex max-h-[calc(min(420px,70vh)-var(--vds-space-2))] min-h-0 flex-col overflow-hidden" data-testid="reference-picker">
      <div className="grid flex-none gap-[var(--vds-space-2)] border-b border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-2)] pb-[var(--vds-space-3)] pt-[var(--vds-space-2)]">
        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
          <IconButton
            data-testid="reference-picker-back"
            icon={<ArrowLeft size={15} />}
            label={t('composer.backReferences')}
            onClick={onBack}
            size="sm"
            variant="ghost"
          />
          <strong className="min-w-0 flex-1 truncate text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-primary)]">
            {t('composer.addSource', { source: sourceLabel })}
          </strong>
        </div>
        <div className="relative">
          <SearchBox
            aria-label={t('composer.searchSource', { source: sourceLabel })}
            data-testid="reference-picker-search"
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('composer.searchSource', { source: sourceLabel })}
            size="sm"
            value={query}
          />
          {query && (
            <IconButton
              className="absolute right-[var(--vds-space-1)] top-1/2 -translate-y-1/2"
              data-testid="reference-picker-clear"
              icon={<X size={13} />}
              label={t('composer.clearSearch')}
              onClick={() => onQueryChange('')}
              size="xs"
              variant="ghost"
            />
          )}
        </div>
        <div className="flex items-center gap-[var(--vds-space-1)]" role="group" aria-label={t('composer.quickFilters')}>
          {FILTERS.map((candidateFilter) => (
            <Button
              aria-pressed={filter === candidateFilter}
              className={filter === candidateFilter ? '!bg-[var(--vds-bg-white-active)] !text-[var(--vds-text-primary)]' : ''}
              data-testid={`reference-picker-filter-${candidateFilter}`}
              key={candidateFilter}
              onClick={() => onFilterChange(candidateFilter)}
              size="xs"
              variant="ghost"
            >
              {t(`composer.filters.${candidateFilter}`)}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--vds-space-1)] overflow-x-hidden overflow-y-auto px-[var(--vds-space-1)] pb-[var(--vds-space-1)] pt-[var(--vds-space-1)]" data-testid="reference-picker-list">
        {loading ? (
          <div role="status" className="px-[var(--vds-space-3)] py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)]">
            {t('composer.loadingProject')}
          </div>
        ) : candidates.length ? (
          [
            ...visibleCandidates.map((item) => (
              <ContextOption
                item={item}
                key={`${item.kind}:${item.source_id}`}
                onSelect={onSelect}
                projectId={projectId}
              />
            )),
            candidates.length > visibleCandidates.length ? (
              <Button
                key="reference-picker-more"
                data-testid="reference-picker-more"
                className="flex w-full items-center justify-center border-0 px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)] hover:bg-[var(--vds-bg-white-hover)] hover:text-[var(--text)]"
                onClick={() =>
                  setVisibleCount((count) => count + REFERENCE_PAGE_SIZE)
                }
                size="content"
                variant="ghost"
              >
                {t('composer.viewMore')} ({candidates.length - visibleCandidates.length})
              </Button>
            ) : null
          ]
        ) : (
          <EmptyState
            className="min-h-[var(--vds-layout-search-row-max-height)] self-center"
            icon={<SearchX size={18} />}
            title={noMatch ? t('composer.noMatchingContent') : emptyLabel}
          />
        )}
      </div>
    </div>
  )
}
