import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { LiteratureSearchEvent, LiteratureSearchTask } from '../../contracts/literature'
import { useApp } from '../../store'
import { EmptyState, Spinner } from '../../components/ui'
import { JoinLibraryMenu } from './JoinMenu'
import { SearchSurface, type LiteratureSearchViewProps } from './Matches'
import { useJoinedPapers } from './joinState'
import {
  LiteratureApiError,
  listLiteratureSearches,
  loadSearchLibraryStatus,
  streamLiteratureSearch,
} from './api'
import { literatureErrorMessage, type LiteratureErrorMessage } from './error'
import { searchEventText, visibleSearchOutput } from './output'
import { searchResultPapers } from './result'

const TASK_ID_PREFIX = 'literature-search:'
const STREAM_RECONNECT_DELAY_MS = 1_000
const ELAPSED_TICK_MS = 1_000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

const TERMINAL_STATUSES = new Set<LiteratureSearchTask['status']>([
  'completed',
  'failed',
  'interrupted',
  'unknown',
  'empty',
  'search_interrupted',
])
function eventStatus(event: LiteratureSearchEvent): LiteratureSearchTask['status'] | undefined {
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
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / ELAPSED_TICK_MS))
  const hours = Math.floor(seconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR))
  const minutes = Math.floor(
    (seconds % (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)) / SECONDS_PER_MINUTE
  )
  const remainder = seconds % SECONDS_PER_MINUTE
  if (hours) return t('search.elapsedHours', { hours, minutes, seconds: remainder })
  if (minutes) return t('search.elapsedMinutes', { minutes, seconds: remainder })
  return t('search.elapsedSeconds', { seconds: remainder })
}

export function LiteratureSearchTab({ tabId }: { tabId: string }): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  return (
    <ScopedLiteratureSearchTab
      key={JSON.stringify([tabId, projectId])}
      tabId={tabId}
      projectId={projectId}
    />
  )
}

function ScopedLiteratureSearchTab({
  tabId,
  projectId,
}: {
  tabId: string
  projectId?: string
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const taskId = tabId.startsWith(TASK_ID_PREFIX) ? tabId.slice(TASK_ID_PREFIX.length) : tabId
  const [task, setTask] = useState<LiteratureSearchTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [streamError, setStreamError] = useState<LiteratureErrorMessage | null>(null)
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
              reason instanceof LiteratureApiError ? reason.failure.code : undefined,
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
                  error: errorText(event) ?? current.error,
                }
              })
            },
            controller.signal
          )
          const refreshed = (await listLiteratureSearches()).find((item) => item.id === task.id)
          if (!controller.signal.aborted && refreshed) setTask(refreshed)
          return
        } catch (reason) {
          if (controller.signal.aborted) return
          setStreamError(
            literatureErrorMessage(
              reason instanceof LiteratureApiError ? reason.failure.code : undefined,
              reason instanceof Error ? reason.message : undefined,
              'search.reconnecting'
            )
          )
          await new Promise((resolve) => window.setTimeout(resolve, STREAM_RECONNECT_DELAY_MS))
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
    ? literatureSearchElapsedLabel(task.created_at, running ? now : (task.completed_at ?? now), t)
    : ''

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner aria-label={t('search.restoring')} />
      </div>
    )
  if (!task)
    return <EmptyState title={t('search.missing')} description={t('search.missingDescription')} />

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
      streamError={streamError ? (streamError.detail ?? t(streamError.key)) : undefined}
      elapsed={elapsed}
      savedPaperIds={savedIds}
    />
  )
}

export function LiteratureSearchView(props: LiteratureSearchViewProps): React.JSX.Element {
  const { state } = useApp()
  const receipts = useJoinedPapers()
  return (
    <SearchSurface
      {...props}
      actions={{
        projectId: state.homeSelectedProjectId ?? undefined,
        receipts,
        Join: JoinLibraryMenu,
        openSource: async (_paper, url) => {
          await window.scholarseed.openExternal(url)
        },
      }}
    />
  )
}
