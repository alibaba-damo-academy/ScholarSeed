import { JoinLibraryMenu, JoinedLabel } from './JoinMenu'
import { paperJoinKey, type JoinDestination } from './join'
import { useJoinedPapers } from './joinState'
import {
  literatureErrorMessage,
  searchFailureMessageKey,
  type LiteratureErrorMessage
} from './error'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link } from 'lucide-react'

import type {
  LiteratureSearchEvent,
  LiteratureSearchPaper,
  LiteratureSearchTask
} from '../../contracts/literature'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EllipsisText,
  IconButton,
  EmptyState,
  Spinner,
  Tag,
  Tooltip,
} from '../../components/ui'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import {
  LiteratureApiError,
  listLiteratureSearches,
  loadSearchLibraryStatus,
  streamLiteratureSearch,
} from './api'
import { searchEventText, visibleSearchOutput } from './output'
import {
  reviewEvidence,
  searchResultPapers,
  visibleSearchPapers,
  type AccessFilter,
  type DecisionFilter,
  type ResultSort,
  type ReviewEvidence
} from './result'

const TASK_ID_PREFIX = 'literature-search:'
const VISIBLE_SEARCH_AUTHORS = 2
const visitedSearchTasks = new Set<string>()
const STREAM_RECONNECT_DELAY_MS = 1_000
const ELAPSED_TICK_MS = 1_000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const SEARCH_RESULTS_TABLE_MIN_WIDTH_PX = 852
const SEARCH_RESULTS_NO_ACCESS_MIN_WIDTH_PX = 730
const SEARCH_RESULTS_ASIDE_WIDTH = 'max(300px, 38%)'
const RESULT_BODY_CELL_CLASS =
  'm-0 min-h-0 min-w-0 max-h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden break-words text-xs leading-5 text-[var(--vds-text-secondary)]'

/**
 * 结果表列集。两个入口的正文列都是推荐理由，差异只在 AI 检索页没有全文获取列、
 * 且完全不读摘要。新增一种结果表在这里登记即可。
 */
export type ResultColumnSet = 'search' | 'conversation'

interface ResultColumnLayout {
  grid: string
  minWidth: number
  /** 全文获取 / 综述依据列。 */
  access: boolean
  /** 详情面板是否展示摘要；AI 检索页的摘要在投影里就已丢弃。 */
  detailAbstract: boolean
}

const RESULT_COLUMN_SETS: Record<ResultColumnSet, ResultColumnLayout> = {
  search: {
    grid: 'grid-cols-[42px_minmax(360px,2fr)_minmax(280px,1.35fr)]',
    minWidth: SEARCH_RESULTS_NO_ACCESS_MIN_WIDTH_PX,
    access: false,
    detailAbstract: false
  },
  conversation: {
    grid: 'grid-cols-[42px_minmax(360px,2fr)_minmax(280px,1.35fr)_110px]',
    minWidth: SEARCH_RESULTS_TABLE_MIN_WIDTH_PX,
    access: true,
    detailAbstract: true
  }
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
  '-'
])

function knownMetadata(value: string | null | undefined): string {
  const text = value?.trim() ?? ''
  return UNKNOWN_METADATA_VALUES.has(text.toLowerCase()) ? '' : text
}

function PaperIdentifierLink({ paper, value, baseUrl, label, showValue = false }: {
  paper: LiteratureSearchPaper
  value: string
  baseUrl: string
  label: string
  showValue?: boolean
}): React.JSX.Element {
  return (
    <PaperSourceLink
      paper={paper}
      sourceUrl={value.startsWith('https://') || value.startsWith('http://') ? value : `${baseUrl}${value}`}
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

function PaperMetadata({
  paper
}: {
  paper: LiteratureSearchPaper
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const authors = paper.authors.map(knownMetadata).filter(Boolean)
  const visibleAuthors = authors.slice(0, VISIBLE_SEARCH_AUTHORS).join(', ')
  const remainingAuthors = authors.length - VISIBLE_SEARCH_AUTHORS
  const venue = knownMetadata(paper.venue)
  const doi = knownMetadata(paper.doi)
  const arxiv = knownMetadata(paper.arxiv_id)
  const metadata: React.ReactNode[] = []
  if (paper.year != null && paper.year > 0) metadata.push(paper.year)
  if (paper.citation_count != null && paper.citation_count >= 0) {
    metadata.push(
      t('search.metadataCitations', { count: paper.citation_count })
    )
  }
  if (venue) metadata.push(venue)
  if (doi)
    metadata.push(
      <PaperIdentifierLink paper={paper} value={doi} baseUrl={DOI_SOURCE_BASE} label="DOI" />
    )
  if (arxiv)
    metadata.push(
      <PaperIdentifierLink paper={paper} value={arxiv} baseUrl={ARXIV_SOURCE_BASE} label="arXiv" />
    )
  return (
    <>
      {authors.length ? (
        <Tooltip
          content={authors.join(', ')}
          disabled={remainingAuthors <= 0}
          side="bottom"
          align="start"
          portalled
          className="mt-1 block min-w-0 text-xs text-[var(--vds-text-secondary)]"
        >
          <span tabIndex={remainingAuthors > 0 ? 0 : undefined} className="flex min-w-0 items-center gap-[var(--vds-space-1)]">
            <span className="min-w-0 truncate">{visibleAuthors}</span>
            {remainingAuthors > 0 ? (
              <span className="shrink-0">{t('search.remainingAuthors', { count: remainingAuthors })}</span>
            ) : null}
          </span>
        </Tooltip>
      ) : null}
      {metadata.length ? (
        <span className="mt-1 block text-xs text-[var(--vds-text-tertiary)]">
          {metadata.map((item, index) => (
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
  sourceUrl
}: {
  paper: LiteratureSearchPaper
  children: React.ReactNode
  sourceUrl?: string
}): React.JSX.Element {
  const candidates = sourceUrl
    ? [sourceUrl]
    : [
        paper.url,
        paper.doi ? `${DOI_SOURCE_BASE}${paper.doi}` : null,
        paper.arxiv_id ? `${ARXIV_SOURCE_BASE}${paper.arxiv_id}` : null
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
        if (window.scholarseed?.openExternal) {
          event.preventDefault()
          void window.scholarseed.openExternal(href)
        }
      }}
    >
      {children}
    </a>
  )
}

const SEARCH_STATUS_KEYS = {
  pending: 'search.status.pending',
  running: 'search.status.running',
  completed: 'search.status.completed',
  failed: 'search.status.failed',
  interrupted: 'search.status.interrupted',
  unknown: 'search.status.unknown',
  empty: 'search.status.empty'
} as const
const TERMINAL_STATUSES = new Set<LiteratureSearchTask['status']>([
  'completed',
  'failed',
  'interrupted',
  'unknown',
  'empty'
])
const RESULT_SORT_LABELS: Record<ResultSort, string> = {
  relevance: '相关度',
  title: '标题',
  year: '年份',
  citations: '引用量'
}
const ACCESS_FILTER_LABELS: Record<AccessFilter, string> = {
  all: '全部获取方式',
  open: '开放获取',
  closed: '需查找全文'
}
const REVIEW_ACCESS_FILTER_LABELS: Record<AccessFilter, string> = {
  all: '全部全文状态',
  open: '已有全文',
  closed: '摘要级或未核对'
}
const DECISION_FILTER_LABELS: Record<DecisionFilter, string> = {
  all: '全部筛选状态',
  included: '最终纳入',
  excluded: '未纳入'
}

const REVIEW_EVIDENCE_KEYS = {
  fulltext: 'searchResult.fulltext',
  abstract: 'searchResult.abstractOnly',
  metadata: 'searchResult.metadataOnly',
  unknown: 'searchResult.other'
} as const
const REVIEW_EVIDENCE_TONES = {
  fulltext: 'success',
  abstract: 'warning',
  metadata: 'neutral',
  unknown: 'neutral'
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
  t
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

function downloadText(filename: string, content: string, type: string): void {
  const href = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(href)
}

function eventStatus(
  event: LiteratureSearchEvent
): LiteratureSearchTask['status'] | undefined {
  if (event.type === 'result.completed') return 'completed'
  if (event.type === 'invocation.failed') return 'failed'
  if (event.type === 'invocation.interrupted') return 'interrupted'
  if (event.type === 'invocation.unknown') return 'unknown'
  return undefined
}

function errorText(event: LiteratureSearchEvent): string | undefined {
  const error = event.data.error
  if (typeof error === 'string') return error
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return undefined
}

export function literatureSearchElapsedLabel(
  startedAt: number,
  endedAt: number,
  t: TFunction<'literature'>
): string {
  const seconds = Math.max(
    0,
    Math.floor((endedAt - startedAt) / ELAPSED_TICK_MS)
  )
  const hours = Math.floor(seconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR))
  const minutes = Math.floor(
    (seconds % (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)) / SECONDS_PER_MINUTE
  )
  const remainder = seconds % SECONDS_PER_MINUTE
  if (hours)
    return t('search.elapsedHours', { hours, minutes, seconds: remainder })
  if (minutes)
    return t('search.elapsedMinutes', { minutes, seconds: remainder })
  return t('search.elapsedSeconds', { seconds: remainder })
}

export function LiteratureSearchTab({ tabId }: { tabId: string }): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  return <ScopedLiteratureSearchTab key={JSON.stringify([tabId, projectId])} tabId={tabId} projectId={projectId} />
}

function ScopedLiteratureSearchTab({
  tabId, projectId
}: {
  tabId: string
  projectId?: string
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const taskId = tabId.startsWith(TASK_ID_PREFIX)
    ? tabId.slice(TASK_ID_PREFIX.length)
    : tabId
  const [task, setTask] = useState<LiteratureSearchTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [streamError, setStreamError] = useState<LiteratureErrorMessage | null>(
    null
  )
  const [now, setNow] = useState(Date.now())
  const [savedIds, setSavedIds] = useState<string[]>([])

  useEffect(() => {
    let active = true
    setLoading(true)
    listLiteratureSearches()
      .then((items) => {
        if (active) setTask(items.find((item) => item.id === taskId) ?? null)
      })
      .catch((reason: unknown) => {
        if (active)
          setStreamError(
            literatureErrorMessage(
              reason instanceof LiteratureApiError
                ? reason.failure.code
                : undefined,
              reason instanceof Error ? reason.message : undefined,
              'search.loadFailed'
            )
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [taskId])

  useEffect(() => {
    if (!task || TERMINAL_STATUSES.has(task.status)) return
    const controller = new AbortController()
    let latestSeq = task.last_seq
    const follow = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          await streamLiteratureSearch(
            task.id,
            latestSeq,
            (event) => {
              latestSeq = Math.max(latestSeq, event.seq)
              setTask((current) => {
                if (!current || event.seq <= current.last_seq) return current
                const status = eventStatus(event)
                return {
                  ...current,
                  last_seq: event.seq,
                  output: `${current.output}${searchEventText(event)}`,
                  status: status ?? current.status,
                  error: errorText(event) ?? current.error
                }
              })
            },
            controller.signal
          )
          const refreshed = (await listLiteratureSearches()).find(
            (item) => item.id === task.id
          )
          if (!controller.signal.aborted && refreshed) setTask(refreshed)
          return
        } catch (reason) {
          if (controller.signal.aborted) return
          setStreamError(
            literatureErrorMessage(
              reason instanceof LiteratureApiError
                ? reason.failure.code
                : undefined,
              reason instanceof Error ? reason.message : undefined,
              'search.reconnecting'
            )
          )
          await new Promise((resolve) =>
            window.setTimeout(resolve, STREAM_RECONNECT_DELAY_MS)
          )
        }
      }
    }
    void follow()
    return () => controller.abort()
  }, [task?.id])

  const resultPapers = task?.result?.papers
  // AI 检索页只认推荐理由, 摘要在投影里就被丢掉, 展示与入库都不会再读到它。
  const papers = useMemo(() => searchResultPapers(resultPapers ?? []), [resultPapers])
  const running = task?.status === 'pending' || task?.status === 'running'
  useEffect(() => {
    if (running || !papers.length) return
    let active = true
    loadSearchLibraryStatus(papers, projectId).then((ids) => {
      if (active) setSavedIds(ids)
    })
    return () => {
      active = false
    }
  }, [papers, running, projectId])
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => window.clearInterval(timer)
  }, [running])
  const elapsed = task
    ? literatureSearchElapsedLabel(
        task.created_at,
        running ? now : (task.completed_at ?? now),
        t
      )
    : ''

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner aria-label={t('search.restoring')} />
      </div>
    )
  if (!task)
    return (
      <EmptyState
        title={t('search.missing')}
        description={t('search.missingDescription')}
      />
    )

  return (
    <LiteratureSearchView
      key={task.id}
      taskId={task.id}
      query={task.query}
      columnSet="search"
      papers={papers}
      status={task.status}
      output={visibleSearchOutput(task.output)}
      error={task.error}
      streamError={
        streamError ? (streamError.detail ?? t(streamError.key)) : undefined
      }
      elapsed={elapsed}
      savedPaperIds={savedIds}
    />
  )
}

interface LiteratureSearchViewProps {
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
  /** 结果表列集；缺省是对话卡片打开的结果页（保留全文获取列）。 */
  columnSet?: ResultColumnSet
}

/** Shared result presentation for a running search task or a saved conversation result. */
export function LiteratureSearchView({
  taskId,
  query,
  papers,
  status,
  output,
  error,
  warning,
  streamError,
  elapsed,
  savedPaperIds,
  columnSet = 'conversation'
}: LiteratureSearchViewProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const columns = RESULT_COLUMN_SETS[columnSet]
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<Set<string>>(() => new Set(savedPaperIds))
  useEffect(() => {
    if (!savedPaperIds?.length) return
    setSaved((current) => {
      let changed = false
      const next = new Set(current)
      for (const id of savedPaperIds)
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      return changed ? next : current
    })
  }, [savedPaperIds])
  const receipts = useJoinedPapers()
  const isSaved = (paper: LiteratureSearchPaper): boolean => saved.has(paper.paper_id) || receipts.has(paperJoinKey(paper, projectId))
  const [focusedId, setFocusedId] = useState('')
  const [sort, setSort] = useState<ResultSort>('relevance')
  const [access, setAccess] = useState<AccessFilter>('all')
  const [decision, setDecision] = useState<DecisionFilter>('all')
  const running = status === 'pending' || status === 'running'
  const failureKey = searchFailureMessageKey(error)
  const failureMessage = failureKey ? t(failureKey) : undefined
  // 进度信息栏 = 模型可见输出 + 已知失败码折算出的用户文案, 失败原因因此和过程同处一栏。
  const processText = [output, failureMessage].filter(Boolean).join('\n')
  const [processOpen, setProcessOpen] = useState(
    () => running && (!taskId || !visitedSearchTasks.has(taskId))
  )
  const previousRunning = useRef(running)
  useEffect(() => {
    if (taskId) visitedSearchTasks.add(taskId)
  }, [taskId])
  useEffect(() => {
    if (previousRunning.current !== running) {
      setProcessOpen(running)
      previousRunning.current = running
    }
  }, [running])
  const reviewResults = papers.some(
    (paper) => paper.decision && paper.decision !== 'candidate'
  )
  const accessLabels = reviewResults
    ? REVIEW_ACCESS_FILTER_LABELS
    : ACCESS_FILTER_LABELS
  const statusTone =
    status === 'completed' || status === 'empty'
      ? 'success'
      : running
        ? 'brand'
        : 'danger'
  const shown = useMemo(
    () => visibleSearchPapers(papers, access, sort, decision),
    [access, decision, papers, sort]
  )
  const focused = papers.find((paper) => paper.paper_id === focusedId) ?? null
  const selectable = shown.filter((paper) => !isSaved(paper))
  const allShownSelected =
    selectable.length > 0 &&
    selectable.every((paper) => selected.has(paper.paper_id))
  const picked = papers.filter((paper) => selected.has(paper.paper_id) && !isSaved(paper))
  const onJoined = (items: LiteratureSearchPaper[], _destination: JoinDestination): void => {
    const ids = items.map(paper => paper.paper_id)
    setSaved(current => new Set([...current, ...ids]))
    setSelected(current => new Set([...current].filter(id => !ids.includes(id))))
  }

  return (
    <div
      className="relative flex h-full min-h-0 overflow-hidden bg-[var(--vds-bg-gray-default)]"
      data-testid="literature-search-tab"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex min-w-0 shrink-0 flex-nowrap items-center justify-between gap-[var(--vds-space-3)] overflow-x-auto whitespace-nowrap border-b border-[var(--vds-border-default)] px-[var(--vds-space-5)] py-[var(--vds-space-2)]">
            <div className="flex shrink-0 flex-nowrap items-center gap-[var(--vds-space-1)]">
              <h1 className="!m-0 min-w-0 whitespace-nowrap !text-sm !font-normal !leading-5 !text-[var(--vds-text-tertiary)]">
                {query ? (
                  <Trans
                    t={t}
                    i18nKey="search.summary"
                    values={{ query }}
                    components={{
                      keyword: (
                        <EllipsisText
                          className="max-w-[var(--vds-literature-search-query-max-width)] text-[var(--vds-text-primary)]"
                          wrapperClassName="!max-w-[min(100%,var(--vds-literature-search-query-max-width))] align-middle"
                          tooltipPortalled
                          tooltipSide="bottom"
                        >
                          {query}
                        </EllipsisText>
                      )
                    }}
                  />
                ) : t('search.title')}
              </h1>
              <span className="text-sm font-normal leading-5 text-[var(--vds-text-primary)]">
                {t('search.paperCount', { count: papers.length })}
              </span>
              <Tag tone={statusTone === 'success' ? 'brand' : statusTone} size="small">
                {t(SEARCH_STATUS_KEYS[status])}
              </Tag>
            </div>
              <div
                aria-hidden={picked.length === 0}
                className={`ml-auto flex min-h-[var(--vds-control-height-md)] shrink-0 items-center gap-[var(--vds-space-3)]${picked.length === 0 ? ' invisible pointer-events-none' : ''}`}
              >
                <span className="text-sm tabular-nums text-[var(--vds-text-secondary)]">
                  {t('batch.selected', { count: picked.length })}
                </span>
                <JoinLibraryMenu papers={picked} size="md" variant="primary" onJoined={onJoined} />
              </div>
          </header>
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-[var(--vds-space-4)] overflow-auto px-[var(--vds-space-5)] py-[var(--vds-space-4)]">
          {streamError ? (
            <Alert
              tone="error"
              title={t('search.streamFailed')}
              description={streamError}
            />
          ) : null}
          {error ? (
            <Alert
              tone="error"
              title={t('search.incomplete')}
              description={failureMessage ?? error}
            />
          ) : null}
          {warning ? <Alert tone="warning" description={warning} /> : null}

          <Collapsible className="!gap-[var(--vds-space-4)]" open={processOpen} onOpenChange={setProcessOpen}>
              <CollapsibleTrigger asChild>
                <Button variant="outline" size="sm" className="!w-fit max-w-full !justify-start gap-[var(--vds-space-2)] !rounded-[var(--vds-radius-4)] !border-[var(--vds-border-default)] !px-[var(--vds-space-3)]">
                    <span className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                      {running ? (
                        <Spinner size="sm" />
                      ) : (
                        <Icon name="sparkle" size={15} />
                      )}
                      <span className="font-semibold text-[var(--vds-text-primary)]">{t('search.output')}</span>
                      {elapsed ? (
                        <span className="font-normal text-[var(--vds-text-tertiary)]">
                          {t('search.elapsed', { elapsed })}
                        </span>
                      ) : null}
                    </span>
                    <span aria-hidden="true" className={`inline-flex shrink-0${processOpen ? ' rotate-180' : ''}`}>
                      <Icon name="chevron-down" size={14} />
                    </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="[--vds-collapsible-content-padding:var(--vds-space-2)]">
                  <pre className="m-0 max-h-[var(--vds-layout-session-output-max-height)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-6 text-[var(--vds-text-secondary)]">
                    {processText ||
                      (running ? t('search.starting') : t('search.noOutput'))}
                  </pre>
              </CollapsibleContent>
          </Collapsible>
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
            <section className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]">
              <div className="relative min-h-0 overflow-hidden">
                <div className="min-w-0 overflow-x-auto">
                  <div style={{ minWidth: columns.minWidth }}>
                    <div className={`sticky top-0 z-10 grid ${columns.grid} items-center gap-3 border-b border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-3 py-2 text-xs font-semibold text-[var(--vds-text-secondary)]`}>
                      <Checkbox
                        aria-label={t('search.selectAll')}
                        checked={allShownSelected}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current)
                            shown.forEach((paper) => {
                              if (isSaved(paper)) return
                              checked
                                ? next.add(paper.paper_id)
                                : next.delete(paper.paper_id)
                            })
                            return next
                          })
                        }
                      />
                      <span>{t('search.literature')}</span>
                      <span>{t('search.reason')}</span>
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
                          data-active={focusedId === paper.paper_id}
                          className={`grid min-h-28 max-h-[var(--vds-layout-search-row-max-height)] cursor-pointer ${columns.grid} grid-rows-[minmax(0,1fr)] items-start gap-3 border-b border-[var(--vds-divider-default)] px-3 py-3 hover:bg-[var(--vds-surface-muted)] data-[active=true]:bg-[var(--vds-surface-muted)]`}
                          onClick={() => setFocusedId(paper.paper_id)}
                        >
                          <span onClick={(event) => event.stopPropagation()}>
                            <Checkbox
                              aria-label={t('list.select', {
                                title: paper.title
                              })}
                              checked={selected.has(paper.paper_id)}
                              disabled={isSaved(paper)}
                              onCheckedChange={(checked) =>
                                setSelected((current) => {
                                  const next = new Set(current)
                                  checked
                                    ? next.add(paper.paper_id)
                                    : next.delete(paper.paper_id)
                                  return next
                                })
                              }
                            />
                          </span>
                          <div className="min-h-0 min-w-0 max-h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            <strong className="line-clamp-2 text-sm text-[var(--vds-text-primary)]">
                              <PaperSourceLink paper={paper}>
                                {paper.title}
                              </PaperSourceLink>
                            </strong>
                            <PaperMetadata paper={paper} />
                            <div className="mt-[var(--vds-space-2)]">
                              {isSaved(paper) ? <JoinedLabel />
                                : <JoinLibraryMenu papers={[paper]} size="md" variant="outline" onJoined={onJoined} />}
                            </div>
                          </div>
                          <p tabIndex={0} className={RESULT_BODY_CELL_CLASS}>
                            {paper.reason || t('search.detailUnknown')}
                          </p>
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
          ) : null}
        </div>
      </div>
      {focused ? (
        <aside
          className="relative z-[var(--vds-z-surface-panel)] flex h-full min-h-0 max-w-full shrink-0 flex-col overflow-hidden border-l border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] shadow-[var(--vds-shadow-3-left)]"
          style={{
            width: SEARCH_RESULTS_ASIDE_WIDTH
          }}
        >
          <header className="sticky top-0 z-10 shrink-0 border-b border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-4 pb-3 pt-4">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <EllipsisText
                className="text-base font-semibold leading-6 text-[var(--vds-text-primary)]"
                wrapperClassName="min-w-0 flex-1"
                tooltipPortalled
                tooltipSide="bottom"
              >
                <PaperSourceLink paper={focused}>
                  {focused.title}
                </PaperSourceLink>
              </EllipsisText>
              <IconButton
                label={t('search.collapseDetail')}
                icon={<Icon name="close" size={16} />}
                size="sm"
                variant="ghostIcon"
                onClick={() => setFocusedId('')}
              />
            </div>
            <div className="mt-2">
              <FulltextAccessBadge
                access={focused.access}
                evidence={reviewEvidence(focused)}
                reviewResults={reviewResults}
                t={t}
              />
            </div>
          </header>
          <div className="min-h-0 flex-1 cursor-text select-text overflow-auto p-4">
            <div className="space-y-4">
              <section>
                <h3 className="mb-2 text-sm font-semibold text-[var(--vds-text-primary)]">
                  {t('search.information')}
                </h3>
                <div className="space-y-2 text-sm text-[var(--vds-text-primary)]">
                  <p className="m-0">
                    <span className="text-[var(--vds-text-secondary)]">
                      {t('search.authorLabel')}
                    </span>
                    {focused.authors.map(knownMetadata).filter(Boolean).join(', ') || t('search.detailUnknown')}
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
                    {focused.year != null && focused.year > 0 ? focused.year : t('search.detailUnknown')}
                  </p>
                  {knownMetadata(focused.doi) ? (
                    <p className="m-0 break-all">
                      <PaperIdentifierLink paper={focused} value={knownMetadata(focused.doi)} baseUrl={DOI_SOURCE_BASE} label="DOI" showValue />
                    </p>
                  ) : null}
                  {knownMetadata(focused.arxiv_id) ? (
                    <p className="m-0 break-all">
                      <PaperIdentifierLink paper={focused} value={knownMetadata(focused.arxiv_id)} baseUrl={ARXIV_SOURCE_BASE} label="arXiv" showValue />
                    </p>
                  ) : null}
                </div>
              </section>
              {focused.reason ? (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-[var(--vds-text-primary)]">
                    {t('search.reason')}
                  </h3>
                  <p className="m-0 text-sm leading-6 text-[var(--vds-text-primary)]">
                    {focused.reason}
                  </p>
                </section>
              ) : null}
              {focused.decision_reason ? (
                <section>
                  <h3 className="mb-2 text-sm font-semibold text-[var(--vds-text-primary)]">
                    {t('searchResult.decision')}
                  </h3>
                  <p className="m-0 text-sm leading-6 text-[var(--vds-text-primary)]">
                    {focused.decision === 'included'
                      ? t('searchResult.included')
                      : t('searchResult.excluded')}{' '}
                    · {focused.decision_reason}
                  </p>
                </section>
              ) : null}
              {columns.detailAbstract ? (
                <section className="shrink-0">
                  <h3 className="mb-2 text-sm font-semibold text-[var(--vds-text-primary)]">
                    {t('search.abstract')}
                  </h3>
                  <p className="m-0 text-sm leading-6 text-[var(--vds-text-primary)]">
                    {focused.abstract || t('search.noAbstract')}
                  </p>
                </section>
              ) : null}
            </div>
          </div>
          <footer className="shrink-0 border-t border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-4">
            {isSaved(focused) ? <JoinedLabel />
              : <JoinLibraryMenu className="w-full" papers={[focused]} size="md" variant="outline" onJoined={onJoined} />}
          </footer>
        </aside>
      ) : null}

    </div>
  )
}
