import { useTranslation } from 'react-i18next'
import React, { useEffect, useRef, useState } from 'react'
import { Clock3, FolderOpen, LibraryBig, MessageCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button, EmptyState, Input } from '../../components/ui'
import { findSessionNode } from '../../tree'
import type { SessionNode } from '../../model'
import type { RecentFileEntry } from '../../../../preferences'
import { createFormatters } from '../../../../localization/format'
import { useApp } from '../../store'
import { openResourceTarget } from '../../navigation'
import { catalogue, useCatalogue } from '../literature/catalog'
import type { GlobalHit, SearchGroupCount } from './api'
import { searchEverything } from './api'
import { highlightRanges } from './highlight'

/** 搜索防抖，避免边打字边打后端。 */
const SEARCH_DEBOUNCE_MS = 240

/** PRD「结果数量与展开」：每组默认展示排序后的前 3 条，不足 3 条全部展示。 */
const GROUP_INITIAL_ROWS = 3

/** 点「{t('search.more')}」时在该组末尾追加的条数上限。 */
const GROUP_EXPAND_STEP = 10

/** The empty-query design exposes only the five most recently opened files. */
const RECENT_FILE_DISPLAY_LIMIT = 5

/** Managed projects expose their library files below this canonical relative prefix. */
const RESOURCE_PATH_PREFIX = 'resources/'
const SEARCH_GROUP_CLASS =
  'vds-search-group flex flex-col gap-[var(--vds-space-2)] [&+.vds-search-group]:mt-[var(--vds-space-3)]'
const SEARCH_ROW_CLASS =
  'vds-search-row block w-full px-[var(--vds-space-2)] py-[var(--vds-global-search-row-padding-block)] border-0 rounded-[var(--vds-radius-4)] bg-transparent text-left cursor-pointer hover:bg-[var(--vds-bg-gray-hover-transparent)]'
const SEARCH_ROW_TITLE_CLASS =
  'vds-search-row-title block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]'
const SEARCH_ROW_SUBTITLE_CLASS =
  'vds-search-row-sub line-clamp-2 overflow-hidden text-ellipsis text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)]'
const SEARCH_GROUP_HEADING_CLASS =
  'vds-search-group-head flex items-center gap-[var(--vds-global-search-group-heading-gap)] px-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)]'
const SEARCH_HINT_CLASS =
  'vds-search-hint px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-placeholder)]'

/** 各域的展示信息（PRD「全局搜索」：资料库、文献库、对话）。图标与左侧活动栏一致。 */
const DOMAIN_META: Record<string, { icon: LucideIcon }> = {
  resource: { icon: FolderOpen },
  literature: { icon: LibraryBig },
  session: { icon: MessageCircle },
}

/** 域展示顺序。 */
const DOMAIN_ORDER = ['resource', 'literature', 'session']

/**
 * 把命中关键词包进 `<mark>`（PRD「结果行展示」：名称、可搜索字段及片段中的
 * 命中内容高亮）。区间计算是 ./highlight.ts 的纯函数 `highlightRanges`；
 * 这里只负责按区间切原文、插标记，不改动命中切片的大小写。
 */
function Highlight({ text, keyword }: { text: string; keyword: string }): React.JSX.Element {
  const ranges = highlightRanges(text, keyword)
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(
      <mark
        key={range.start}
        className="vds-search-mark bg-transparent text-[var(--vds-text-highlight)]"
      >
        {text.slice(range.start, range.end)}
      </mark>
    )
    cursor = range.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function resourceFileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function resourceDisplayPath(path: string): string {
  return path.startsWith(RESOURCE_PATH_PREFIX) ? path.slice(RESOURCE_PATH_PREFIX.length) : path
}

/**
 * 全局搜索面板（PRD「全局搜索」）。
 *
 * 三个领域统一通过后端 `/api/search` 查询当前项目。
 *
 * 分组计数用后端回报的 `total`（配合 `truncated` 显示成「N+」），不是数一下
 * 手上这几条 —— 后端有命中窗口，拿窗口长度当总数会把上限骗成真实命中数。
 */
export function GlobalSearch(): React.JSX.Element {
  const { t, i18n } = useTranslation('shell')
  const { state, set, act } = useApp()
  const { query: literatureQuery } = useCatalogue()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<GlobalHit[] | null>(null)
  const [counts, setCounts] = useState<Record<string, SearchGroupCount>>({})
  const [expanded, setExpanded] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const requestGeneration = useRef(0)

  // 文献总览的项目筛选由 literature catalogue 持有；进入该视图时
  // homeSelectedProjectId 会被清空，不能再把它当成全局搜索的项目范围。
  // 其它工作台视图仍沿用首页/顶栏选择的项目。
  const searchProjectId =
    state.mainView === 'literature'
      ? (literatureQuery.project_id ?? null)
      : state.homeSelectedProjectId

  const filesOnly = state.globalSearchMode === 'files'
  const close = (): void => set({ globalSearchOpen: false, globalSearchMode: 'all' })

  const openRecentFile = (entry: RecentFileEntry): void => {
    openResourceTarget(act, entry)
    close()
  }

  useEffect(() => {
    const keyword = query.trim()
    // 搜索词变化 → 各组恢复默认展示条数，结果区回到顶部（PRD「结果数量与展开」）。
    setExpanded({})
    if (!keyword) {
      setHits(null)
      setCounts({})
      setLoading(false)
      return
    }
    setLoading(true)
    const controller = new AbortController()
    const generation = ++requestGeneration.current
    const timer = window.setTimeout(() => {
      void searchEverything(keyword, searchProjectId, controller.signal)
        .then((result) => {
          if (controller.signal.aborted || generation !== requestGeneration.current) return
          setHits(
            filesOnly
              ? (result?.hits ?? []).filter((hit) => hit.domain === 'resource')
              : (result?.hits ?? [])
          )
          setCounts(
            filesOnly
              ? { resource: result?.groups.resource ?? { total: 0, truncated: false } }
              : (result?.groups ?? {})
          )
          setLoading(false)
          resultsRef.current?.scrollTo({ top: 0 })
        })
        .catch(() => {
          if (controller.signal.aborted || generation !== requestGeneration.current) return
          setHits([])
          setCounts({})
          setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [filesOnly, query, searchProjectId])

  const openHit = (hit: GlobalHit): void => {
    if (hit.domain === 'resource') {
      act.openWorkbenchView('resource')
      if (hit.reveal) act.revealResourceFile(hit.id, hit.reveal)
      else act.openResourceFile(hit.id)
      close()
      return
    }
    if (hit.domain === 'literature') {
      // 命中属于本次搜索的项目作用域；preserveProject 把它带过跳转，
      // 否则 openWorkbenchView 默认把文献视图退回全局全览。
      const projectId = searchProjectId ?? state.homeSelectedProjectId
      act.openWorkbenchView('literature', { preserveProject: true })
      // 详情抽屉认 catalogue 的 focusedId；先切到命中所在作用域再 focus，
      // 否则 scope() 恢复作用域存档时会把刚设的 focusedId 冲掉。
      if (projectId) catalogue.scope(projectId)
      catalogue.focus(hit.id)
      close()
      return
    }
    if (hit.domain === 'session') {
      const existing = findSessionNode(state.sessions, hit.id)
      const node: SessionNode = existing ?? {
        id: hit.id,
        title: hit.title || t('search.project.untitledSession'),
        status: 'dormant',
        openable: true,
        projectPath: state.projects.find((project) => project.id === state.homeSelectedProjectId)
          ?.path,
      }
      act.openPanelSession(node, {
        turnId: hit.locator?.turn_id,
        itemId: hit.locator?.item_id,
      })
      close()
      return
    }
  }

  const grouped = (filesOnly ? ['resource'] : DOMAIN_ORDER)
    .map((domain) => ({
      domain,
      rows: (hits ?? []).filter((hit) => hit.domain === domain),
    }))
    .filter((group) => group.rows.length > 0)
  // 「最近打开」与搜索结果同口径：在项目内搜索时只列该项目的最近打开；
  // 全局搜索（searchProjectId 为 null，如项目总览/全局文献库）才列跨项目最近打开。
  const recentRows = state.recentFiles
    .filter((entry) => searchProjectId === null || entry.projectId === searchProjectId)
    .flatMap((entry) => {
      const project = state.projects.find((candidate) => candidate.id === entry.projectId)
      return project ? [{ entry, project }] : []
    })
    .slice(0, RECENT_FILE_DISPLAY_LIMIT)
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')

  return (
    <div className="vds-modal-scrim" data-testid="global-search">
      <div className="vds-modal-backdrop" onClick={close} />
      <div className="vds-search-modal relative flex flex-col gap-[var(--vds-space-4)] self-start mt-[var(--vds-global-search-panel-offset-top)] w-[var(--vds-global-search-panel-width)] max-h-[var(--vds-global-search-panel-max-height)] pb-[var(--vds-space-3)] border border-[var(--vds-border-default)] rounded-[var(--vds-radius-8)] bg-[var(--vds-bg-white-default)] shadow-[var(--vds-global-search-panel-shadow)]">
        <label className="vds-search-field flex items-center gap-[var(--vds-space-2)] pt-[var(--vds-space-5)] px-[var(--vds-space-5)] pb-[var(--vds-space-4)] border-b border-[var(--vds-divider-default)] text-[var(--vds-text-placeholder)] [&>.vds-field]:min-w-0 [&>.vds-field]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-[length:var(--vds-font-subhead)] [&_input]:leading-[var(--vds-lh-subhead)] [&_input]:text-[var(--vds-text-primary)] [&_input]:placeholder:text-[var(--vds-text-placeholder)] [&_input]:focus:outline-none">
          <Input
            autoFocus
            placeholder={t(
              filesOnly ? 'search.project.filesPlaceholder' : 'search.project.placeholder'
            )}
            data-testid="global-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') close()
            }}
          />
        </label>

        <div
          className="vds-search-results min-h-0 flex-1 overflow-y-auto px-[var(--vds-space-3)]"
          data-testid="global-search-results"
          ref={resultsRef}
        >
          {hits === null ? (
            <div className={SEARCH_GROUP_CLASS} data-testid="search-recent">
              <div className={SEARCH_GROUP_HEADING_CLASS}>
                <Clock3 size={14} strokeWidth={1.45} />
                <span>{t('search.recent.title')}</span>
              </div>
              {recentRows.length ? (
                recentRows.map(({ entry, project }) => (
                  <Button
                    key={`${entry.projectId}:${entry.path}`}
                    unstyled
                    type="button"
                    variant="ghost"
                    size="content"
                    className={SEARCH_ROW_CLASS}
                    data-testid="search-recent-file"
                    data-project-id={entry.projectId}
                    data-path={entry.path}
                    onClick={() => openRecentFile(entry)}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-[var(--vds-space-3)]">
                      <span
                        className={`${SEARCH_ROW_TITLE_CLASS} min-w-0 flex-1`}
                        title={resourceFileName(entry.path)}
                      >
                        {resourceFileName(entry.path)}
                      </span>
                      <span className="shrink-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-6)]">
                        {t('search.recent.openedAt', {
                          time: format.date(entry.openedAt, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          }),
                        })}
                      </span>
                    </span>
                    <span
                      className={`${SEARCH_ROW_SUBTITLE_CLASS} line-clamp-1`}
                      title={`${project.name}/${entry.path}`}
                    >
                      {t('search.recent.path', {
                        project: project.name,
                        path: resourceDisplayPath(entry.path),
                      })}
                    </span>
                  </Button>
                ))
              ) : (
                <EmptyState
                  variant="compact"
                  icon={<Clock3 />}
                  data-testid="search-recent-empty"
                  title={t('search.recent.empty')}
                />
              )}
            </div>
          ) : loading ? (
            <div className={SEARCH_HINT_CLASS}>{t('search.project.loading')}</div>
          ) : grouped.length === 0 ? (
            <div className={SEARCH_HINT_CLASS} data-testid="search-empty">
              {t('search.noHits')}
            </div>
          ) : (
            grouped.map((group) => {
              const meta = DOMAIN_META[group.domain]
              const DomainIcon = meta.icon
              const count = counts[group.domain]
              const total = count?.total ?? group.rows.length
              const truncated = count?.truncated === true
              const shown = Math.min(
                expanded[group.domain] ?? GROUP_INITIAL_ROWS,
                group.rows.length
              )
              const hasMore = shown < group.rows.length
              return (
                <div key={group.domain} className={SEARCH_GROUP_CLASS}>
                  <div className={SEARCH_GROUP_HEADING_CLASS}>
                    <DomainIcon size={14} strokeWidth={1.45} />
                    <span>
                      {String(
                        t(
                          group.domain === 'resource'
                            ? 'search.domain.resource'
                            : group.domain === 'literature'
                              ? 'search.domain.literature'
                              : 'search.domain.session'
                        )
                      )}
                    </span>
                    <span data-testid={`search-count-${group.domain}`}>
                      {`(${truncated ? `${total}+` : total})`}
                    </span>
                  </div>
                  {group.rows.slice(0, shown).map((hit) => (
                    <Button
                      key={`${hit.domain}:${hit.id}`}
                      unstyled
                      type="button"
                      variant="ghost"
                      size="content"
                      className={SEARCH_ROW_CLASS}
                      data-testid={`search-hit-${hit.domain}-${hit.id}`}
                      onClick={() => openHit(hit)}
                    >
                      <span className={SEARCH_ROW_TITLE_CLASS} title={hit.title}>
                        <Highlight text={hit.title} keyword={query} />
                      </span>
                      {hit.subtitle && (
                        <span className={SEARCH_ROW_SUBTITLE_CLASS} title={hit.subtitle}>
                          <Highlight text={hit.subtitle} keyword={query} />
                        </span>
                      )}
                    </Button>
                  ))}
                  {hasMore && (
                    <Button
                      type="button"
                      className="vds-search-more w-full justify-center border-0 bg-transparent text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-placeholder)] shadow-none"
                      data-testid={`search-more-${group.domain}`}
                      size="content"
                      variant="ghost"
                      onClick={() =>
                        setExpanded((current) => ({
                          ...current,
                          [group.domain]: shown + GROUP_EXPAND_STEP,
                        }))
                      }
                    >
                      {t('search.more')}
                    </Button>
                  )}
                  {!hasMore && truncated && (
                    <div className={SEARCH_HINT_CLASS}>
                      {t('search.truncated', { total: group.rows.length })}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
