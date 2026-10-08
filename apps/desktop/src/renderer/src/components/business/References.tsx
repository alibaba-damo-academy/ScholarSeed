import { BookOpenText, ChevronRight, File, Folder, SearchX, X } from 'lucide-react'
import React from 'react'
import { useTranslation } from 'react-i18next'

import { createFormatters } from '../../../../localization/format'
import type { AssistantContextCandidate } from '../../contracts/assistant'
import { fetchResourceCandidatePage, RESOURCE_CONTEXT_KIND } from '../../features/assistant/api'
import { candidateLabel, useAssistantContextText } from '../../features/assistant/text'
import { Icon } from '../../icons'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator, Button, Checkbox, EmptyState, IconButton, SearchBox, Tooltip } from '../ui'

const REFERENCE_PAGE_SIZE = 10
const BREADCRUMB_PREVIEW_LENGTH = 2

function TruncatedTitleTooltip({ children, title }: { children: React.ReactNode; title: string }): React.JSX.Element {
  const rowRef = React.useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = React.useState(false)

  React.useLayoutEffect(() => {
    const row = rowRef.current
    const label = row?.querySelector<HTMLElement>('.line-clamp-2')
    if (!row || !label) return
    const update = (): void => setTruncated(label.scrollHeight > label.clientHeight + 1)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(row)
    observer.observe(label)
    return () => observer.disconnect()
  }, [title])

  return (
    <Tooltip className="!w-full" content={title} disabled={!truncated} portalled side="left">
      <span className="block w-full" ref={rowRef}>{children}</span>
    </Tooltip>
  )
}

export function ReferencePicker({
  candidates,
  emptyLabel,
  loading,
  onQueryChange,
  onConfirm,
  projectId,
  query,
  sourceId,
  sourceLabel
}: {
  candidates: AssistantContextCandidate[]
  emptyLabel: React.ReactNode
  loading: boolean
  onQueryChange: (query: string) => void
  onConfirm: (candidates: AssistantContextCandidate[]) => Promise<void>
  projectId: string | null
  query: string
  sourceId: string
  sourceLabel: string
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText, i18n } = useTranslation('assistant')
  const contextText = useAssistantContextText()
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const [selected, setSelected] = React.useState<Map<string, AssistantContextCandidate>>(() => new Map())
  const [path, setPath] = React.useState<AssistantContextCandidate[]>([])
  const [folderCandidates, setFolderCandidates] = React.useState<AssistantContextCandidate[]>([])
  const [nextOffset, setNextOffset] = React.useState<number | null>(null)
  const [folderLoading, setFolderLoading] = React.useState(false)
  const [folderFailed, setFolderFailed] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const folder = path.at(-1)
  const requestId = React.useRef(0)
  React.useEffect(() => {
    if (!folder) return
    const currentRequest = ++requestId.current
    setFolderLoading(true)
    setFolderFailed(false)
    setFolderCandidates([])
    setNextOffset(null)
    void fetchResourceCandidatePage(projectId, folder.source_id, 0).then((page) => {
      if (currentRequest !== requestId.current) return
      setFolderLoading(false)
      if (!page) { setFolderFailed(true); return }
      setFolderCandidates(page.items)
      setNextOffset(page.nextOffset)
    })
    return () => { requestId.current += 1 }
  }, [folder, projectId])
  const toggle = (item: AssistantContextCandidate): void => {
    const key = `${item.kind}:${item.source_id}`
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(key)) next.delete(key)
      else next.set(key, item)
      return next
    })
  }
  const displayedCandidates = folder
    ? folderCandidates.filter((item) => candidateLabel(item, assistantText).toLowerCase().includes(query.trim().toLowerCase()))
    : candidates
  const pending = folder ? folderLoading : loading
  const noMatch = Boolean(query.trim()) && !pending && displayedCandidates.length === 0
  const initialLoading = pending && displayedCandidates.length === 0
  const [visibleCount, setVisibleCount] = React.useState(REFERENCE_PAGE_SIZE)
  React.useEffect(() => {
    setVisibleCount(REFERENCE_PAGE_SIZE)
  }, [candidates, folderCandidates, query])
  const visibleCandidates = displayedCandidates.slice(0, visibleCount)

  return (
    <div aria-busy={pending || submitting} className="flex max-h-[calc(min(420px,70vh)-var(--vds-space-2))] min-h-0 flex-col overflow-hidden" data-testid="reference-picker">
      <div className="grid flex-none gap-[var(--vds-space-2)] border-b border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-2)] pb-[var(--vds-space-3)] pt-[var(--vds-space-2)]">
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
        {path.length > 0 && (
          <Breadcrumb className="min-w-0 overflow-hidden" data-testid="reference-picker-breadcrumb"><BreadcrumbList className="flex-nowrap overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <BreadcrumbItem className="shrink-0"><BreadcrumbLink href="#" onClick={(event) => { event.preventDefault(); setPath([]); onQueryChange('') }}>{sourceLabel}</BreadcrumbLink></BreadcrumbItem>
            {path.map((segment, index) => {
              const characters = Array.from(segment.label)
              const truncated = characters.length > BREADCRUMB_PREVIEW_LENGTH
              const preview = truncated ? `${characters.slice(0, BREADCRUMB_PREVIEW_LENGTH).join('')}…` : segment.label
              return <React.Fragment key={segment.source_id}>
                <BreadcrumbSeparator className="shrink-0" />
                <BreadcrumbItem className="shrink-0"><Tooltip content={segment.label} disabled={!truncated} portalled side="left">
                  {index === path.length - 1
                    ? <BreadcrumbPage>{preview}</BreadcrumbPage>
                    : <BreadcrumbLink href="#" onClick={(event) => { event.preventDefault(); setPath(path.slice(0, index + 1)); onQueryChange('') }}>{preview}</BreadcrumbLink>}
                </Tooltip></BreadcrumbItem>
              </React.Fragment>
            })}
          </BreadcrumbList></Breadcrumb>
        )}
      </div>
      <div className="flex min-h-0 basis-[var(--vds-reference-picker-list-height)] flex-col gap-[var(--vds-space-1)] overflow-x-hidden overflow-y-auto px-[var(--vds-space-1)] pb-[var(--vds-space-1)] pt-[var(--vds-space-1)]" data-testid="reference-picker-list">
        {initialLoading ? (
          <div role="status" className="px-[var(--vds-space-3)] py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)]">
            {t('composer.loadingProject')}
          </div>
        ) : displayedCandidates.length ? (
          [
            ...visibleCandidates.map((item) => {
              const resourceMetadata = item.kind === 'dir'
                ? assistantText('referencePicker.folderItems', { count: item.child_count ?? 0 })
                : assistantText('referencePicker.file')
              const metadata = item.unavailable_reason
                ? contextText(item.unavailable_reason)
                : sourceId === RESOURCE_CONTEXT_KIND
                  ? resourceMetadata
                  : item.hint || (item.kind === 'session' && item.created_at
                  ? format.date(item.created_at * 1000, { year: 'numeric', month: 'short', day: 'numeric' })
                  : '')
              const firstLineAligned = item.kind === 'literature' || item.kind === 'session' || item.kind === 'dir' || item.kind === 'file'
              const clampedTitle = firstLineAligned
              const candidateIcon = item.kind === 'dir' ? <Folder size={15} /> : item.kind === 'literature' ? <BookOpenText size={15} /> : item.kind === 'session' ? <Icon name="quote" size={15} /> : <File size={15} />
              const row = (
              <div className={`flex min-w-0 ${firstLineAligned ? 'items-start' : 'items-center'} gap-[var(--vds-space-1)] rounded-[var(--vds-radius-3)] pl-[6px] hover:bg-[var(--vds-bg-white-hover-transparent)]`}>
                <span className={firstLineAligned ? 'inline-flex h-[calc(var(--vds-space-2)+var(--vds-border-width-1)+var(--vds-lh-body-lv1))] shrink-0 items-end' : 'inline-flex shrink-0'}>
                  <span className={firstLineAligned ? 'inline-flex h-[var(--vds-lh-body-lv1)] items-center' : 'inline-flex'}>
                    <Checkbox
                      aria-label={assistantText('referencePicker.select', { name: candidateLabel(item, assistantText) })}
                      checked={selected.has(`${item.kind}:${item.source_id}`)}
                      data-testid={`ai-context-select-${item.kind}-${item.source_id}`}
                      disabled={Boolean(item.unavailable_reason)}
                      onCheckedChange={() => toggle(item)}
                    />
                  </span>
                </span>
                <Button
                  className={`!h-auto min-h-8 w-full min-w-0 flex-1 ${firstLineAligned ? '!items-start' : ''} justify-start gap-[var(--vds-space-2)] !whitespace-normal px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-left hover:!bg-transparent`}
                  data-testid={`ai-context-option-${item.kind}-${item.source_id}`}
                  disabled={Boolean(item.unavailable_reason)}
                  icon={firstLineAligned ? <span className="inline-flex h-[var(--vds-lh-body-lv1)] shrink-0 items-center">{candidateIcon}</span> : candidateIcon}
                  onClick={() => { if (item.kind === 'dir') { setPath([...path, item]); onQueryChange('') } else toggle(item) }}
                  size="content"
                  variant="ghost"
                >
                  <span className="grid min-w-0 flex-1 text-left">
                    <span className={`${clampedTitle ? 'line-clamp-2' : 'whitespace-normal'} break-words text-[length:var(--vds-font-body-lv1)] font-medium leading-[var(--vds-lh-body-lv1)]`}>{candidateLabel(item, assistantText)}</span>
                    {item.kind !== 'literature' && metadata && <small className="whitespace-normal break-words text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">{metadata}</small>}
                  </span>
                  {item.kind === 'dir' && <span className="inline-flex h-[var(--vds-lh-body-lv1)] items-center"><ChevronRight size={12} /></span>}
                </Button>
              </div>
              )
              return clampedTitle
                ? <TruncatedTitleTooltip key={`${item.kind}:${item.source_id}`} title={candidateLabel(item, assistantText)}>{row}</TruncatedTitleTooltip>
                : <React.Fragment key={`${item.kind}:${item.source_id}`}>{row}</React.Fragment>
            }),
            displayedCandidates.length > visibleCandidates.length ? (
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
                {t('composer.viewMore')} ({displayedCandidates.length - visibleCandidates.length})
              </Button>
            ) : null
          ]
        ) : (
          <EmptyState
            variant="compact"
            className="min-h-[var(--vds-layout-search-row-max-height)] self-center"
            icon={<SearchX size={18} />}
            title={folderFailed ? assistantText('contextOption.retry') : noMatch ? t('composer.noMatchingContent') : emptyLabel}
          />
        )}
        {folder && !folderLoading && (folderFailed || nextOffset !== null) && (
          <Button className="hover:!bg-[var(--vds-bg-white-hover)]" onClick={() => {
            setFolderLoading(true)
            setFolderFailed(false)
            void fetchResourceCandidatePage(projectId, folder.source_id, nextOffset ?? 0).then((page) => {
              setFolderLoading(false)
              if (!page) { setFolderFailed(true); return }
              setFolderCandidates((current) => [...current, ...page.items])
              setNextOffset(page.nextOffset)
            })
          }} size="sm" variant="ghost">{assistantText(folderFailed ? 'contextOption.retry' : 'contextOption.more')}</Button>
        )}
      </div>
      <div className="flex flex-none items-center justify-between gap-[var(--vds-space-2)] border-t border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
        <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--text-3)]">{assistantText('referencePicker.selected', { count: selected.size })}</span>
        <Button data-testid="reference-picker-confirm" disabled={selected.size === 0 || submitting} onClick={() => { setSubmitting(true); void onConfirm([...selected.values()]).finally(() => setSubmitting(false)) }} size="sm" variant="primary">{assistantText('referencePicker.add')}</Button>
      </div>
    </div>
  )
}
