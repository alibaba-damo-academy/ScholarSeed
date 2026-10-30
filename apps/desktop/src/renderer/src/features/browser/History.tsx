import { BROWSER_ERROR_KEYS } from './messages'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BROWSER_ERROR, type BrowserErrorCode, type BrowserHistoryPage } from '../../../../browser'
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  Pagination,
  SearchBox,
} from '../../components/ui'

const HISTORY_PAGE_SIZE = 20
const FIRST_PAGE = 1

export interface HistoryActionLease {
  current(): boolean
  finish(): void
}

interface HistoryProps {
  onReopened: () => void
  invalidationGeneration: number
  disabled: boolean
  acquireAction: () => HistoryActionLease | null
  isCurrent: (expectedInvalidationGeneration: number) => boolean
}

export function History({
  onReopened,
  invalidationGeneration,
  disabled,
  acquireAction,
  isCurrent,
}: HistoryProps): React.JSX.Element {
  const { t } = useTranslation('browser')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(FIRST_PAGE)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ key: string; page: BrowserHistoryPage } | null>(null)
  const [queryError, setQueryError] = useState<BrowserErrorCode | null>(null)
  const [actionError, setActionError] = useState<BrowserErrorCode | null>(null)
  const key = JSON.stringify([search, page, revision, invalidationGeneration])
  const currentKey = useRef(key)
  currentKey.current = key
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

  const action = async (kind: 'delete' | 'reopen', id: string): Promise<void> => {
    const lease = acquireAction()
    if (!lease) return
    const sequence = ++actionSequence.current
    querySequence.current += 1
    setActionError(null)
    const current = () => mounted.current && sequence === actionSequence.current && lease.current()
    try {
      const reply = await window.scholarseed.browser.history({ kind, id })
      if (!current()) return
      if (!reply.ok) setActionError(reply.error)
      else if (kind === 'delete') {
        setResult(null)
        setRevision((value) => value + 1)
      } else onReopened()
    } catch {
      if (current()) setActionError(BROWSER_ERROR.operationFailed)
    } finally {
      lease.finish()
    }
  }
  const history = result?.key === key ? result.page : null
  return (
    <Card className="grid gap-[var(--vds-space-4)]" data-testid="browser-settings-history">
      <div>
        <CardTitle>{t('settings.historyTitle')}</CardTitle>
        <CardDescription>{t('settings.historyDescription')}</CardDescription>
      </div>
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
      {!history ? (
        !queryError && (
          <p role="status" className="text-[var(--vds-text-secondary)]">
            {t('settings.historyLoading')}
          </p>
        )
      ) : history.items.length === 0 ? (
        <p className="text-[var(--vds-text-secondary)]">{t('settings.historyEmpty')}</p>
      ) : (
        <ul className="grid gap-[var(--vds-space-3)]" data-testid="browser-history-list">
          {history.items.map((visit) => (
            <li
              key={visit.id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--vds-space-3)] border-b border-[var(--vds-border-default)] pb-[var(--vds-space-3)]"
            >
              <div className="min-w-0">
                <p className="truncate" title={visit.title || visit.url}>
                  {visit.title || visit.url}
                </p>
                <p className="truncate text-[var(--vds-text-secondary)]" title={visit.url}>
                  {visit.url}
                </p>
                <p className="text-[var(--vds-text-tertiary)]">
                  {new Date(visit.visitedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-[var(--vds-space-2)]">
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    void action('reopen', visit.id)
                  }}
                >
                  {t('settings.reopenHistory')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    void action('delete', visit.id)
                  }}
                >
                  {t('settings.deleteHistory')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {history && history.total > HISTORY_PAGE_SIZE && (
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
    </Card>
  )
}
