import { BROWSER_ERROR_KEYS } from './messages'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Ellipsis, ExternalLink, History as HistoryIcon, Trash2 } from 'lucide-react'

import { BROWSER_ERROR, type BrowserErrorCode, type BrowserHistoryPage } from '../../../../browser'
import {
  Button,
  CardDescription,
  CardTitle,
  Pagination,
  SearchBox,
  Checkbox,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  IconButton,
  EmptyState,
  Separator,
  ScrollArea,
} from '../../components/ui'

const HISTORY_PAGE_SIZE = 20
const FIRST_PAGE = 1

export interface HistoryActionLease {
  current(): boolean
  finish(): void
}

interface HistoryProps {
  onClear?: () => void
  clearDialogOpen?: boolean
  onManage?: () => void
  onReopened: (pageId: string) => void
  invalidationGeneration: number
  disabled: boolean
  acquireAction: () => HistoryActionLease | null
  isCurrent: (expectedInvalidationGeneration: number) => boolean
}

export function History({
  onClear,
  clearDialogOpen = false,
  onManage,
  onReopened,
  invalidationGeneration,
  disabled,
  acquireAction,
  isCurrent,
}: HistoryProps): React.JSX.Element {
  const { t, i18n } = useTranslation('browser')
  const [openVisitMenuId, setOpenVisitMenuId] = useState<string | null>(null)
  if (clearDialogOpen && openVisitMenuId !== null) setOpenVisitMenuId(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(FIRST_PAGE)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ key: string; page: BrowserHistoryPage } | null>(null)
  const [queryError, setQueryError] = useState<BrowserErrorCode | null>(null)
  const [actionError, setActionError] = useState<BrowserErrorCode | null>(null)
  const key = JSON.stringify([search, page, revision, invalidationGeneration])
  const currentKey = useRef(key)
  currentKey.current = key
  useEffect(() => setSelected([]), [key])
  const mounted = useRef(false)
  const querySequence = useRef(0)
  const actionSequence = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      querySequence.current += 1
      actionSequence.current += 1
    }
  }, [])
  useEffect(() => {
    let active = true
    const sequence = ++querySequence.current
    if (disabled)
      return () => {
        active = false
      }
    setResult(null)
    setQueryError(null)
    const current = () =>
      active &&
      mounted.current &&
      sequence === querySequence.current &&
      currentKey.current === key &&
      isCurrent(invalidationGeneration)
    // Parent mount effects settle before the bridge call; revoked surfaces never issue a reread.
    void Promise.resolve()
      .then(async () => {
        if (!current()) return
        const reply = await window.scholarseed.browser.history({
          kind: 'query',
          query: {
            search,
            offset: (page - FIRST_PAGE) * HISTORY_PAGE_SIZE,
            limit: HISTORY_PAGE_SIZE,
          },
        })
        if (!current()) return
        if (reply.ok && reply.page) {
          const last = Math.max(FIRST_PAGE, Math.ceil(reply.page.total / HISTORY_PAGE_SIZE))
          if (page > last) setPage(last)
          else setResult({ key, page: reply.page })
        } else if (!reply.ok) setQueryError(reply.error)
      })
      .catch(() => {
        if (current()) setQueryError(BROWSER_ERROR.operationFailed)
      })
    return () => {
      active = false
    }
  }, [search, page, revision, invalidationGeneration, disabled, isCurrent, key])

  const action = async (kind: 'delete' | 'reopen', ids: string[]): Promise<void> => {
    const lease = acquireAction()
    if (!lease) return
    const sequence = ++actionSequence.current
    querySequence.current += 1
    setActionError(null)
    const current = () => mounted.current && sequence === actionSequence.current && lease.current()
    try {
      for (const id of ids) {
        if (!current()) return
        const reply = await window.scholarseed.browser.history({ kind, id })
        if (!current()) return
        if (!reply.ok) {
          setActionError(reply.error)
          break
        }
        if (kind === 'reopen') {
          const pageId = reply.snapshot?.activeTabId
          if (!pageId) {
            setActionError(BROWSER_ERROR.operationFailed)
            break
          }
          onReopened(pageId)
        }
      }
    } catch {
      if (current()) setActionError(BROWSER_ERROR.operationFailed)
    } finally {
      if (kind === 'delete' && current()) {
        setSelected([])
        setResult(null)
        setRevision((value) => value + 1)
      }
      lease.finish()
    }
  }
  const history = result?.key === key ? result.page : null
  const VisitTarget = selecting ? 'div' : Button
  const groups = new Map<string, NonNullable<typeof history>['items']>()
  for (const visit of history?.items ?? []) {
    const date = new Date(visit.visitedAt).toLocaleDateString(i18n.language)
    const visits = groups.get(date) ?? []
    visits.push(visit)
    groups.set(date, visits)
  }
  return (
    <div
      className={`flex flex-col gap-[var(--vds-space-4)]${!onManage ? ' -mr-[var(--vds-space-4)] h-full min-h-0 overflow-hidden' : ''}`}
      data-testid="browser-settings-history"
    >
      {onManage && (
        <div className="flex items-center justify-between gap-[var(--vds-space-4)]">
          <div className="min-w-0">
            <CardTitle>{t('settings.historyTitle')}</CardTitle>
            <CardDescription>{t('settings.historyDescription')}</CardDescription>
          </div>
          <Button variant="outline" onClick={onManage}>
            {t('settings.manageHistory')}
          </Button>
        </div>
      )}
      <div
        className={`flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-[var(--vds-space-3)]${!onManage ? ' mr-[var(--vds-space-4)]' : ''}`}
        data-testid="browser-history-toolbar"
      >
        <div className="mr-auto w-1/3 min-w-0">
          <SearchBox
            aria-label={t('settings.searchHistory')}
            placeholder={t('settings.searchHistory')}
            value={search}
            disabled={disabled}
            onChange={(event) => {
              querySequence.current += 1
              setResult(null)
              setSearch(event.target.value)
              setPage(FIRST_PAGE)
              setActionError(null)
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-[var(--vds-space-3)]">
          {selecting ? (
            <>
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setSelecting(false)
                  setSelected([])
                }}
              >
                {t('settings.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={disabled || !history?.items.length}
                title={selected.length === 0 ? t('settings.selectAllHistoryOnPage') : undefined}
                onClick={() => {
                  if (selected.length > 0) void action('delete', selected)
                  else setSelected(history?.items.map((visit) => visit.id) ?? [])
                }}
              >
                {selected.length > 0
                  ? t('settings.removeSelectedHistory')
                  : t('settings.selectAllHistory')}
              </Button>
            </>
          ) : (
            <>
              {onClear && (
                <Button variant="secondary" disabled={disabled} onClick={onClear}>
                  {t('settings.dataTitle')}
                </Button>
              )}
              <Button
                variant="primary"
                disabled={disabled || !history?.items.length}
                onClick={() => setSelecting(true)}
              >
                {t('settings.batchClearHistory')}
              </Button>
            </>
          )}
        </div>
      </div>
      {queryError && (
        <p role="alert" className="text-[var(--vds-error-text-primary)]">
          {t(BROWSER_ERROR_KEYS[queryError])}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-[var(--vds-error-text-primary)]">
          {t(BROWSER_ERROR_KEYS[actionError])}
        </p>
      )}
      <ScrollArea
        overlay
        className={
          !onManage ? 'flex min-h-0 flex-1 flex-col overflow-hidden !rounded-none' : undefined
        }
        viewportClassName={!onManage ? '!min-h-0 flex-1' : undefined}
        viewportProps={{ tabIndex: 0, 'aria-label': t('settings.historyTitle') }}
        data-testid="browser-history-scroll"
      >
        <div
          className={`flex flex-col gap-[var(--vds-space-4)]${!onManage ? ' pr-[var(--vds-space-4)]' : ''}`}
        >
          {!history ? (
            !queryError && (
              <p role="status" className="text-[var(--vds-text-secondary)]">
                {t('settings.historyLoading')}
              </p>
            )
          ) : history.items.length === 0 ? (
            <EmptyState
              variant="compact"
              iconTone="subtle"
              icon={<HistoryIcon />}
              title={t('settings.historyEmpty')}
              className="flex-1"
            />
          ) : (
            <ul
              className="flex flex-col gap-[var(--vds-space-3)]"
              data-testid="browser-history-list"
            >
              {[...groups].map(([date, visits], index) => (
                <li key={date}>
                  <Collapsible
                    key={selecting ? 'selection' : 'browse'}
                    defaultOpen={selecting || index === 0}
                  >
                    <CollapsibleTrigger className="group flex w-full items-center justify-between">
                      {date}
                      <ChevronDown
                        aria-hidden="true"
                        strokeWidth={1.5}
                        className="size-[var(--vds-icon-8)] group-data-[state=open]:rotate-180"
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="bg-[var(--vds-bg-white-default)]">
                      <ul>
                        {visits.map((visit, visitIndex) => (
                          <li
                            key={visit.id}
                            className="relative flex min-w-0 items-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] px-[var(--vds-space-3)] hover:bg-[var(--vds-surface-hover)] focus-within:bg-[var(--vds-surface-hover)]"
                          >
                            {selecting && (
                              <Checkbox
                                aria-label={t('settings.selectHistory', {
                                  title: visit.title || visit.url,
                                })}
                                checked={selected.includes(visit.id)}
                                disabled={disabled}
                                onCheckedChange={(checked) =>
                                  setSelected((current) =>
                                    checked
                                      ? [...current, visit.id]
                                      : current.filter((id) => id !== visit.id)
                                  )
                                }
                              />
                            )}
                            <div className="flex min-w-0 flex-1 items-end gap-[var(--vds-space-4)] py-[var(--vds-space-3)]">
                              <VisitTarget
                                className={
                                  selecting
                                    ? 'min-w-0 flex-1'
                                    : 'min-w-0 flex-1 cursor-pointer rounded-[var(--vds-radius-3)] text-left focus-visible:shadow-[var(--vds-focus-ring)]'
                                }
                                {...(selecting
                                  ? {}
                                  : {
                                      unstyled: true,
                                      disabled,
                                      'data-testid': 'browser-history-open',
                                      onClick: () => void action('reopen', [visit.id]),
                                    })}
                              >
                                <span className="block truncate text-[var(--vds-text-primary)]">
                                  {visit.title || visit.url}
                                </span>
                                <span className="block truncate text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                                  {visit.url}
                                </span>
                              </VisitTarget>
                              <p className="shrink-0 whitespace-nowrap text-[var(--vds-text-tertiary)]">
                                {new Date(visit.visitedAt).toLocaleString()}
                              </p>
                            </div>
                            <DropdownMenu
                              open={openVisitMenuId === visit.id}
                              onOpenChange={(open) =>
                                setOpenVisitMenuId((current) =>
                                  open && !clearDialogOpen
                                    ? visit.id
                                    : current === visit.id
                                      ? null
                                      : current
                                )
                              }
                            >
                              <DropdownMenuTrigger asChild>
                                <IconButton
                                  label={t('settings.historyActions')}
                                  icon={
                                    <Ellipsis className="!size-[var(--vds-icon-8)] text-[var(--vds-icon-outline-default)]" />
                                  }
                                  size="md"
                                  variant="ghost"
                                  disabled={disabled}
                                />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="z-[var(--vds-z-modal-nested-flyout)]"
                              >
                                <DropdownMenuItem
                                  disabled={disabled}
                                  onSelect={() => void action('reopen', [visit.id])}
                                >
                                  <ExternalLink aria-hidden="true" />
                                  {t('settings.reopenHistory')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="!text-[var(--vds-error-text-primary)]"
                                  disabled={disabled}
                                  onSelect={() => void action('delete', [visit.id])}
                                >
                                  <Trash2
                                    aria-hidden="true"
                                    className="!text-[var(--vds-error-text-primary)]"
                                  />
                                  {t('settings.deleteHistory')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {visitIndex < visits.length - 1 && (
                              <Separator className="absolute left-[var(--vds-space-2)]! right-[var(--vds-space-2)]! bottom-0 !m-0 w-auto! rounded-none" />
                            )}
                          </li>
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                </li>
              ))}
            </ul>
          )}
          {history && history.items.length > 0 && history.total > HISTORY_PAGE_SIZE && (
            <Pagination
              page={page}
              pageCount={Math.ceil(history.total / HISTORY_PAGE_SIZE)}
              onPageChange={(next) => {
                querySequence.current += 1
                setResult(null)
                setPage(next)
              }}
              disabled={disabled}
              ariaLabel={t('settings.historyPages')}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
