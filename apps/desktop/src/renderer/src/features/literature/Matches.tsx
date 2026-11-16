import { type Joining } from './Joining'
import type { HeldFulltextSource } from './join'
import { paperJoinKey, type JoinDestination } from './hierarchy'
import { searchFailureMessageKey } from './error'
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link, Upload } from 'lucide-react'

import type {
  LiteratureSearchPaper,
  LiteratureSearchTask,
  ResultLibraryState,
} from '../../contracts/literature'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EllipsisText,
  IconButton,
  EmptyState,
  ScrollArea,
  Spinner,
  Tag,
  Tooltip,
  useToast,
} from '../../components/ui'
import { Icon } from '../../icons'
import {
  reviewEvidence,
  searchPapersBibtex,
  visibleSearchPapers,
  type AccessFilter,
  type DecisionFilter,
  type ResultSort,
  type ReviewEvidence,
} from './result'
import type { BibtexSave } from './export'

export interface SearchActions {
  projectId?: string
  receipts: ReadonlyMap<string, JoinDestination>
  Join: React.ComponentType<Omit<React.ComponentProps<typeof Joining>, 'ports'>>
  Batch?: React.ComponentType<{
    papers: LiteratureSearchPaper[]
    source?: HeldFulltextSource
    selection?: { count: number; total: number }
    onJoined?: (papers: LiteratureSearchPaper[], destination: JoinDestination) => void
  }>
  openSource: (paper: LiteratureSearchPaper, url: string) => Promise<unknown>
  saveBibtex?: (bibtex: string) => Promise<BibtexSave>
}
const SearchContext = createContext<SearchActions | null>(null)
const VISIBLE_SEARCH_AUTHORS = 2

export function SearchSurface({
  actions,
  ...props
}: LiteratureSearchViewProps & { actions: SearchActions }): React.JSX.Element {
  return (
    <SearchContext.Provider value={actions}>
      <SearchContents {...props} />
    </SearchContext.Provider>
  )
}

const SEARCH_RESULTS_TABLE_MIN_WIDTH_PX = 852
const SEARCH_RESULTS_NO_ACCESS_MIN_WIDTH_PX = 730
const SEARCH_RESULTS_ASIDE_WIDTH = 'var(--vds-literature-results-detail-width)'
const RESULT_BODY_CELL_CLASS =
  'm-0 min-h-0 min-w-0 self-stretch overflow-y-auto [contain:size] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden break-words text-[length:var(--vds-font-body-lv2)] font-[number:var(--vds-fw-regular)] leading-[var(--vds-library-search-line-height)] text-[var(--vds-text-primary)]'

export type ResultColumnSet = 'search' | 'conversation' | 'candidates' | 'authorized'

interface ResultColumnLayout {
  grid: string
  minWidth: number
  /** 全文获取 / 综述依据列。 */
  access: boolean
  detailAbstract: boolean
  abstract?: boolean
}

const RESULT_COLUMN_SETS: Record<ResultColumnSet, ResultColumnLayout> = {
  search: {
    grid: 'grid-cols-[42px_minmax(360px,2fr)_minmax(280px,1.35fr)]',
    minWidth: SEARCH_RESULTS_NO_ACCESS_MIN_WIDTH_PX,
    access: false,
    detailAbstract: false,
  },
  conversation: {
    grid: 'grid-cols-[42px_minmax(360px,2fr)_minmax(280px,1.35fr)_110px]',
    minWidth: SEARCH_RESULTS_TABLE_MIN_WIDTH_PX,
    access: true,
    detailAbstract: true,
  },
  candidates: {
    grid: 'grid-cols-[42px_minmax(360px,2fr)_minmax(280px,1.35fr)]',
    minWidth: SEARCH_RESULTS_NO_ACCESS_MIN_WIDTH_PX,
    access: false,
    detailAbstract: false,
  },
  authorized: {
    grid: 'grid-cols-[42px_minmax(0,2fr)_minmax(0,1.35fr)_minmax(0,1.35fr)]',
    minWidth: SEARCH_RESULTS_TABLE_MIN_WIDTH_PX,
    access: false,
    detailAbstract: true,
    abstract: true,
  },
}
const PAPER_LINK_PROTOCOLS = new Set(['https:', 'http:'])
const DOI_SOURCE_BASE = 'https://doi.org/'
const ARXIV_SOURCE_BASE = 'https://arxiv.org/abs/'

const UNKNOWN_METADATA_VALUES = new Set([
  'unknown',
  'n/a',
  'null',
  'none',
  '未知',
  '出版物未知',
  '作者未知',
  '暂无',
  '-',
])

function knownMetadata(value: string | null | undefined): string {
  const text = value?.trim() ?? ''
  return UNKNOWN_METADATA_VALUES.has(text.toLowerCase()) ? '' : text
}

function PaperIdentifierLink({
  paper,
  value,
  baseUrl,
  label,
  showValue = false,
}: {
  paper: LiteratureSearchPaper
  value: string
  baseUrl: string
  label: string
  showValue?: boolean
}): React.JSX.Element {
  return (
    <PaperSourceLink
      paper={paper}
      sourceUrl={
        value.startsWith('https://') || value.startsWith('http://') ? value : `${baseUrl}${value}`
      }
    >
      <span className="inline-flex max-w-full items-center gap-[var(--vds-space-1)] align-middle">
        <Link size="1em" aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 break-all group-hover/paper-link:underline group-focus-visible/paper-link:underline">
          {showValue ? `${label}: ${value}` : label}
        </span>
      </span>
    </PaperSourceLink>
  )
}

function PaperMetadata({ paper }: { paper: LiteratureSearchPaper }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const authors = paper.authors.map(knownMetadata).filter(Boolean)
  const abbreviated = authors.length > VISIBLE_SEARCH_AUTHORS
  const visibleAuthors = abbreviated ? authors[0] : authors.join(', ')
  const venue = knownMetadata(paper.venue)
  const doi = knownMetadata(paper.doi)
  const arxiv = knownMetadata(paper.arxiv_id)
  const metadata: React.ReactNode[] = []
  if (paper.year != null && paper.year > 0) metadata.push(paper.year)
  if (paper.citation_count != null && paper.citation_count >= 0) {
    metadata.push(t('search.metadataCitations', { count: paper.citation_count }))
  }
  if (venue) metadata.push(venue)
  const identifiers: React.ReactNode[] = []
  if (doi)
    identifiers.push(
      <PaperIdentifierLink
        paper={paper}
        value={doi}
        baseUrl={DOI_SOURCE_BASE}
        label={t('columns.doi')}
      />
    )
  if (arxiv)
    identifiers.push(
      <PaperIdentifierLink
        paper={paper}
        value={arxiv}
        baseUrl={ARXIV_SOURCE_BASE}
        label={t('columns.arxiv')}
      />
    )
  return (
    <>
      {authors.length ? (
        <Tooltip
          content={authors.join(', ')}
          disabled={!abbreviated}
          side="bottom"
          align="start"
          portalled
          className="mt-[var(--vds-space-1)] block min-w-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
        >
          <span
            tabIndex={abbreviated ? 0 : undefined}
            className="flex min-w-0 items-center gap-[var(--vds-space-1)]"
          >
            <span className="min-w-0 truncate">{visibleAuthors}</span>
            {abbreviated ? <span className="shrink-0">{t('search.authorsEtAl')}</span> : null}
          </span>
        </Tooltip>
      ) : null}
      {metadata.length ? (
        <span className="mt-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
          {metadata.map((item, index) => (
            <React.Fragment key={index}>
              {index > 0 ? ' · ' : null}
              {item}
            </React.Fragment>
          ))}
        </span>
      ) : null}
      {identifiers.length ? (
        <span
          data-testid="search-paper-identifiers"
          className="mt-[var(--vds-space-1)] block text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]"
        >
          {identifiers.map((item, index) => (
            <React.Fragment key={index}>
              {index > 0 ? ' · ' : null}
              {item}
            </React.Fragment>
          ))}
        </span>
      ) : null}
    </>
  )
}

function PaperSourceLink({
  paper,
  children,
  sourceUrl,
}: {
  paper: LiteratureSearchPaper
  children: React.ReactNode
  sourceUrl?: string
}): React.JSX.Element {
  const actions = useContext(SearchContext)!
  const { t } = useTranslation('literature')
  const { toast } = useToast()
  const candidates = sourceUrl
    ? [sourceUrl]
    : [
        paper.url,
        paper.doi ? `${DOI_SOURCE_BASE}${paper.doi}` : null,
        paper.arxiv_id ? `${ARXIV_SOURCE_BASE}${paper.arxiv_id}` : null,
      ]
  const href = candidates.find((candidate) => {
    if (!candidate) return false
    try {
      return PAPER_LINK_PROTOCOLS.has(new URL(candidate).protocol)
    } catch {
      return false
    }
  })
  if (!href) return <>{children}</>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`group/paper-link ${sourceUrl ? '!text-[var(--vds-link)]' : 'text-inherit'} hover:text-[var(--vds-link-hover)] hover:underline focus-visible:text-[var(--vds-link-hover)] focus-visible:underline active:text-[var(--vds-link-active)]`}
      onClick={(event) => {
        event.stopPropagation()
        event.preventDefault()
        void actions.openSource(paper, href).catch(() => {
          toast({ tone: 'error', description: t('result.openFailed') })
        })
      }}
    >
      {children}
    </a>
  )
}

const REVIEW_EVIDENCE_KEYS = {
  fulltext: 'searchResult.fulltext',
  abstract: 'searchResult.abstractOnly',
  metadata: 'searchResult.metadataOnly',
  unknown: 'searchResult.other',
} as const
const REVIEW_EVIDENCE_TONES = {
  fulltext: 'success',
  abstract: 'warning',
  metadata: 'neutral',
  unknown: 'neutral',
} as const

interface FulltextAccessBadgeProps {
  access?: LiteratureSearchPaper['access']
  evidence?: ReviewEvidence
  reviewResults: boolean
  t: TFunction<'literature'>
}

function FulltextAccessBadge({
  access,
  evidence = 'unknown',
  reviewResults,
  t,
}: FulltextAccessBadgeProps): React.JSX.Element {
  const label = reviewResults
    ? t(REVIEW_EVIDENCE_KEYS[evidence])
    : access === 'open'
      ? t('search.openAccess')
      : t('search.findFulltext')
  const tone = reviewResults
    ? REVIEW_EVIDENCE_TONES[evidence]
    : access === 'open'
      ? 'success'
      : access === 'closed'
        ? 'warning'
        : 'neutral'

  return (
    <Badge className="w-fit justify-self-start" size="sm" tone={tone}>
      {label}
    </Badge>
  )
}

export interface LiteratureSearchViewProps {
  taskId?: string
  query?: string
  papers: LiteratureSearchPaper[]
  status: LiteratureSearchTask['status']
  /** 已投影的用户可见输出：模型原始流由调用方裁剪，本组件不再过滤。 */
  output: string
  error?: string | null
  warning?: string
  streamError?: string
  elapsed?: string
  savedPaperIds?: readonly string[]
  libraryStatuses?: Readonly<Record<string, ResultLibraryState>>
  /** 结果表列集；缺省是对话卡片打开的结果页（保留全文获取列）。 */
  columnSet?: ResultColumnSet
  /** 精确检索卡片带来的已下载全文来源; 只有它能让「元信息和全文」出现。 */
  heldSource?: HeldFulltextSource
}

function LibraryStatusNotice({
  status,
}: {
  status?: ResultLibraryState
}): React.JSX.Element | null {
  const { t } = useTranslation('literature')
  if (status !== 'ambiguous' && status !== 'unavailable') return null
  return (
    <Tag
      tone="warning"
      size="small"
      className="!font-[var(--vds-fw-regular)]"
      data-testid="literature-library-status"
    >
      {t(status === 'ambiguous' ? 'result.libraryAmbiguous' : 'result.libraryUnavailable')}
    </Tag>
  )
}

/** Shared result presentation for a running search task or a saved conversation result. */
function SearchContents({
  papers,
  status,
  error,
  warning,
  streamError,
  savedPaperIds,
  libraryStatuses,
  columnSet = 'conversation',
  heldSource,
}: LiteratureSearchViewProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const columns = RESULT_COLUMN_SETS[columnSet]
  const { toast } = useToast()
  const [exporting, setExporting] = useState(false)
  const actions = useContext(SearchContext)!
  const projectId = actions.projectId
  const JoinLibraryMenu = actions.Join
  const JoinBatch = actions.Batch
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(papers.map((paper) => paper.paper_id))
  )
  const selectionInitialized = useRef(papers.length > 0)
  useEffect(() => {
    if (selectionInitialized.current || papers.length === 0) return
    selectionInitialized.current = true
    setSelected(new Set(papers.map((paper) => paper.paper_id)))
  }, [papers])
  const saved = useMemo(() => new Set(savedPaperIds), [savedPaperIds])
  const receipts = actions.receipts
  const isSaved = (paper: LiteratureSearchPaper): boolean =>
    libraryStatuses
      ? libraryStatuses[paper.paper_id] === 'matched'
      : saved.has(paper.paper_id) || receipts.has(paperJoinKey(paper, projectId))
  const canJoin = (paper: LiteratureSearchPaper): boolean =>
    libraryStatuses ? libraryStatuses[paper.paper_id] === 'absent' : !isSaved(paper)
  const [focusedId, setFocusedId] = useState('')
  const [detailOpen, setDetailOpen] = useState(false)
  const [sort] = useState<ResultSort>('relevance')
  const [access] = useState<AccessFilter>('all')
  const [decision] = useState<DecisionFilter>('all')
  const running = status === 'pending' || status === 'running'
  const failureKey = searchFailureMessageKey(error)
  const failureMessage = failureKey ? t(failureKey) : undefined
  const reviewResults = papers.some((paper) => paper.decision && paper.decision !== 'candidate')
  const shown = useMemo(
    () => visibleSearchPapers(papers, access, sort, decision),
    [access, decision, papers, sort]
  )
  const focused = papers.find((paper) => paper.paper_id === focusedId) ?? null
  const selectableShown = shown.filter((paper) => !isSaved(paper))
  const allShownSelected =
    selectableShown.length > 0 && selectableShown.every((paper) => selected.has(paper.paper_id))
  const picked = papers.filter((paper) => !isSaved(paper) && selected.has(paper.paper_id))
  const joinable = picked.filter(canJoin)
  const selection = {
    count: papers.filter((paper) => isSaved(paper) || selected.has(paper.paper_id)).length,
    total: papers.length,
  }
  const exportPapers = async (items: LiteratureSearchPaper[]): Promise<void> => {
    if (exporting || !items.length || !actions.saveBibtex) return
    setExporting(true)
    try {
      const result = await actions.saveBibtex(searchPapersBibtex(items))
      if (result.kind === 'saved')
        toast({ title: t('batch.exportSucceeded', { count: items.length }), tone: 'success' })
      else if (result.kind === 'failed')
        toast({ title: t('relations.exportFailed'), tone: 'error' })
    } finally {
      setExporting(false)
    }
  }
  const onJoined = (items: LiteratureSearchPaper[]): void => {
    const ids = items.map((paper) => paper.paper_id)
    setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))))
  }

  return (
    <div
      className="relative flex h-full min-h-0 overflow-hidden bg-[var(--vds-bg-gray-default)]"
      data-testid="literature-search-tab"
    >
      <div className="isolate flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] px-[var(--vds-space-5)] py-[var(--vds-space-2)]">
          <div className="ml-auto flex min-h-[var(--vds-control-height-md)] shrink-0 items-center gap-[var(--vds-space-3)]">
            <Button
              variant="secondary"
              size="md"
              loading={exporting}
              disabled={exporting || picked.length === 0 || !actions.saveBibtex}
              data-testid="search-export-bib"
              onClick={() => void exportPapers(picked)}
            >
              <Upload size="1em" aria-hidden="true" />
              {t('batch.export')}
            </Button>
            {JoinBatch ? (
              <JoinBatch
                papers={joinable}
                source={heldSource}
                selection={selection}
                onJoined={onJoined}
              />
            ) : (
              <JoinLibraryMenu
                papers={joinable}
                selection={selection}
                size="md"
                variant="primary"
                onJoined={onJoined}
              />
            )}
          </div>
        </header>
        <ScrollArea
          overlay
          overlayScrollOnly
          className="flex min-h-0 w-full min-w-0 flex-1 flex-col"
          viewportClassName="min-h-0 flex-1 px-[var(--vds-space-5)] py-[var(--vds-space-4)] [&>div]:flex [&>div]:flex-col [&>div]:gap-[var(--vds-space-4)]"
          viewportProps={{ 'aria-label': t('result.receipt') }}
        >
          {streamError ? (
            <Alert tone="error" title={t('search.streamFailed')} description={streamError} />
          ) : null}
          {error ? (
            <Alert
              tone="error"
              title={t('search.incomplete')}
              description={failureMessage ?? error}
            />
          ) : null}
          {warning ? <Alert tone="warning" description={warning} /> : null}

          {!running && papers.length === 0 ? (
            <EmptyState
              title={t('search.noResults')}
              description={
                status === 'completed' || status === 'empty'
                  ? t('search.noMetadata')
                  : t('search.searchFailed')
              }
            />
          ) : !running ? (
            <section className="flex shrink-0 flex-col overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-transparent">
              <div className="relative min-h-0 overflow-hidden">
                <div className="min-w-0 overflow-x-auto">
                  <div style={{ minWidth: columns.minWidth }}>
                    <div
                      data-testid="search-table-header"
                      className={`sticky top-0 z-[var(--vds-z-elevated)] grid ${columns.grid} items-center gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] bg-[var(--vds-fill-4)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]`}
                    >
                      <Checkbox
                        aria-label={t('search.selectAll')}
                        checked={allShownSelected}
                        disabled={selectableShown.length === 0}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current)
                            selectableShown.forEach((paper) => {
                              if (checked) next.add(paper.paper_id)
                              else next.delete(paper.paper_id)
                            })
                            return next
                          })
                        }
                      />
                      <span>{t('search.literature')}</span>
                      <span>{t('search.reason')}</span>
                      {columns.abstract ? <span>{t('search.abstract')}</span> : null}
                      {columns.access ? (
                        <span>
                          {reviewResults
                            ? t('searchResult.reviewEvidence')
                            : t('searchResult.fulltextAccess')}
                        </span>
                      ) : null}
                    </div>
                    {shown.length ? (
                      shown.map((paper) => (
                        <div
                          key={paper.paper_id}
                          data-testid={`search-paper-${paper.paper_id}`}
                          data-active={detailOpen && focusedId === paper.paper_id}
                          className={`grid cursor-pointer ${columns.grid} items-start gap-[var(--vds-space-3)] border-b border-[var(--vds-divider-default)] px-[var(--vds-space-3)] py-[var(--vds-space-3)] hover:bg-[var(--vds-fill-4)] active:bg-[var(--vds-fill-4)] data-[active=true]:bg-[var(--vds-fill-4)]`}
                          onClick={() => {
                            setFocusedId(paper.paper_id)
                            setDetailOpen(true)
                          }}
                        >
                          <span onClick={(event) => event.stopPropagation()}>
                            <Checkbox
                              className="disabled:opacity-[var(--vds-opacity-full)] [&:disabled_.vds-checkbox__box]:!border-[var(--vds-brand-bg-disabled)] [&:disabled_.vds-checkbox__box]:!bg-[var(--vds-brand-bg-disabled)]"
                              aria-label={t('list.select', {
                                title: paper.title,
                              })}
                              checked={isSaved(paper) || selected.has(paper.paper_id)}
                              disabled={isSaved(paper)}
                              onCheckedChange={(checked) =>
                                setSelected((current) => {
                                  const next = new Set(current)
                                  if (checked) next.add(paper.paper_id)
                                  else next.delete(paper.paper_id)
                                  return next
                                })
                              }
                            />
                          </span>
                          <div className="min-w-0 font-[var(--vds-fw-regular)]">
                            <strong className="line-clamp-2 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
                              <PaperSourceLink paper={paper}>{paper.title}</PaperSourceLink>
                            </strong>
                            <PaperMetadata paper={paper} />
                            <div className="mt-[var(--vds-space-2)] flex flex-wrap items-center gap-[var(--vds-space-2)] empty:hidden">
                              {!isSaved(paper) && (
                                <LibraryStatusNotice status={libraryStatuses?.[paper.paper_id]} />
                              )}
                            </div>
                          </div>
                          <p tabIndex={0} className={RESULT_BODY_CELL_CLASS}>
                            {paper.reason || t('search.detailUnknown')}
                          </p>
                          {columns.abstract ? (
                            <p tabIndex={0} className={RESULT_BODY_CELL_CLASS}>
                              {paper.abstract || t('search.detailUnknown')}
                            </p>
                          ) : null}
                          {columns.access ? (
                            <FulltextAccessBadge
                              access={paper.access}
                              evidence={reviewEvidence(paper)}
                              reviewResults={reviewResults}
                              t={t}
                            />
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <EmptyState
                        title={t('search.noFiltered')}
                        description={t('search.adjustFilter')}
                      />
                    )}
                  </div>
                </div>
              </div>
            </section>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Spinner aria-label={t('search.starting')} />
            </div>
          )}
        </ScrollArea>
      </div>
      {focused && detailOpen ? (
        <Button
          unstyled
          className="absolute inset-0 z-[var(--vds-z-local-control)]"
          aria-label={t('search.collapseDetail')}
          tabIndex={-1}
          onClick={() => setDetailOpen(false)}
        />
      ) : null}
      {focused ? (
        <aside
          className="absolute inset-y-0 right-0 z-[var(--vds-z-surface-panel)] flex min-h-0 max-w-full flex-col overflow-hidden border-l border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] shadow-[var(--vds-shadow-3-left)] transition-[translate,visibility] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none data-[open=false]:invisible data-[open=false]:translate-x-full motion-safe:starting:translate-x-full"
          data-open={detailOpen}
          inert={!detailOpen}
          style={{
            width: SEARCH_RESULTS_ASIDE_WIDTH,
          }}
        >
          <header className="sticky top-0 z-[var(--vds-z-elevated)] shrink-0 border-b border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-4)] pb-[var(--vds-space-3)] pt-[var(--vds-space-4)]">
            <div className="flex min-w-0 items-start justify-between gap-[var(--vds-space-2)]">
              <EllipsisText
                className="text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]"
                wrapperClassName="min-w-0 flex-1"
                tooltipPortalled
                tooltipSide="bottom"
              >
                <PaperSourceLink paper={focused}>{focused.title}</PaperSourceLink>
              </EllipsisText>
              <IconButton
                label={t('search.collapseDetail')}
                icon={<Icon name="close" size={16} />}
                size="sm"
                variant="ghostIcon"
                onClick={() => setDetailOpen(false)}
              />
            </div>
            <div className="mt-[var(--vds-space-2)]">
              <FulltextAccessBadge
                access={focused.access}
                evidence={reviewEvidence(focused)}
                reviewResults={reviewResults}
                t={t}
              />
            </div>
          </header>
          <div className="min-h-0 flex-1 cursor-text select-text overflow-auto p-[var(--vds-space-4)]">
            <div className="space-y-[var(--vds-space-4)]">
              <section>
                <h3 className="mb-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
                  {t('search.information')}
                </h3>
                <div className="space-y-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]">
                  <p className="m-0">
                    <span className="text-[var(--vds-text-secondary)]">
                      {t('search.authorLabel')}
                    </span>
                    {focused.authors.map(knownMetadata).filter(Boolean).join(', ') ||
                      t('search.detailUnknown')}
                  </p>
                  <p className="m-0">
                    <span className="text-[var(--vds-text-secondary)]">
                      {t('search.publicationLabel')}
                    </span>
                    {knownMetadata(focused.venue) || t('search.detailUnknown')}
                  </p>
                  <p className="m-0">
                    <span className="text-[var(--vds-text-secondary)]">
                      {t('search.yearLabel')}
                    </span>
                    {focused.year != null && focused.year > 0
                      ? focused.year
                      : t('search.detailUnknown')}
                  </p>
                  {knownMetadata(focused.doi) ? (
                    <p className="m-0 break-all">
                      <PaperIdentifierLink
                        paper={focused}
                        value={knownMetadata(focused.doi)}
                        baseUrl={DOI_SOURCE_BASE}
                        label={t('columns.doi')}
                        showValue
                      />
                    </p>
                  ) : null}
                  {knownMetadata(focused.arxiv_id) ? (
                    <p className="m-0 break-all">
                      <PaperIdentifierLink
                        paper={focused}
                        value={knownMetadata(focused.arxiv_id)}
                        baseUrl={ARXIV_SOURCE_BASE}
                        label={t('columns.arxiv')}
                        showValue
                      />
                    </p>
                  ) : null}
                </div>
              </section>
              {focused.reason ? (
                <section>
                  <h3 className="mb-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
                    {t('search.reason')}
                  </h3>
                  <p className="m-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-literature-search-result-line-height)] text-[var(--vds-text-primary)]">
                    {focused.reason}
                  </p>
                </section>
              ) : null}
              {focused.decision_reason ? (
                <section>
                  <h3 className="mb-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
                    {t('searchResult.decision')}
                  </h3>
                  <p className="m-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-literature-search-result-line-height)] text-[var(--vds-text-primary)]">
                    {focused.decision === 'included'
                      ? t('searchResult.included')
                      : t('searchResult.excluded')}{' '}
                    · {focused.decision_reason}
                  </p>
                </section>
              ) : null}
              {columns.detailAbstract ? (
                <section className="shrink-0">
                  <h3 className="mb-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
                    {t('search.abstract')}
                  </h3>
                  <p className="m-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-literature-search-result-line-height)] text-[var(--vds-text-primary)]">
                    {focused.abstract || t('search.noAbstract')}
                  </p>
                </section>
              ) : null}
            </div>
          </div>
          <footer className="grid shrink-0 gap-[var(--vds-space-2)] border-t border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-4)] empty:hidden">
            {isSaved(focused) ? (
              <div className="flex flex-wrap items-center justify-end gap-[var(--vds-space-2)]">
                {actions.saveBibtex ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={exporting}
                    disabled={exporting}
                    onClick={() => void exportPapers([focused])}
                  >
                    <Upload size="1em" aria-hidden="true" />
                    {t('batch.export')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <LibraryStatusNotice status={libraryStatuses?.[focused.paper_id]} />
            )}
          </footer>
        </aside>
      ) : null}
    </div>
  )
}
