import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LITERATURE_RESULT_PREFIX } from '../workbench/tabs'
import { LiteratureSearchView } from './Search'
import { loadConversationLibraryStatus, requestConversationSearch } from './api'
import { libraryStatusCache, useLibraryStatusRevision } from './status'
import { PRECISE_SEARCH_ORIGIN, presentedSearchArtifacts } from './result'
import { ResultReport } from './Report'
import type { ConvItem } from '../../model'
import { getHistoryWithTodos } from '../../api'
import { projectActivityEvents } from '../../transcript'
import { literatureResultAuthorization } from './interaction'
import { parseResult } from './Summary'
import { LiteratureCard } from './Card'

import { useApp } from '../../store'
import { Alert, Button } from '../../components/ui'

export function LiteratureResultTab({
  tabId,
  active = true,
}: {
  tabId: string
  active?: boolean
}): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  const review = state.tabs.find((tab) => tab.id === tabId)?.literatureReview
  if (review)
    return (
      <div className="h-full min-w-0 overflow-auto p-[var(--vds-layout-page-padding)]">
        <LiteratureCard type="literature-review" content={review} cardId={tabId} detail />
      </div>
    )
  return (
    <ScopedLiteratureResultTab
      key={JSON.stringify([tabId, projectId])}
      tabId={tabId}
      projectId={projectId}
      active={active}
    />
  )
}

function ScopedLiteratureResultTab({
  tabId,
  projectId,
  active,
}: {
  tabId: string
  projectId?: string
  active: boolean
}): React.JSX.Element {
  const { state } = useApp()
  const { t } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const [content, setContent] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState(false)
  const scope = projectId ?? ''
  const revision = useLibraryStatusRevision(scope)
  const [lookup, setLookup] = useState<{
    revision: number
    value: Awaited<ReturnType<typeof loadConversationLibraryStatus>>
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [history, setHistory] = useState<ConvItem[]>([])
  const [session, card] = tabId
    .slice(LITERATURE_RESULT_PREFIX.length)
    .split('/')
    .map(decodeURIComponent)
  const conversation = Object.values(state.threads).find(
    (thread) => thread.sessionId === session
  )?.conversation
  useEffect(() => {
    if (conversation) return
    let active = true
    void getHistoryWithTodos(session, 'literature').then((snapshot) => {
      if (active) setHistory(snapshot ? projectActivityEvents([], snapshot.activity_events) : [])
    })
    return () => {
      active = false
    }
  }, [session, conversation])
  useEffect(() => {
    const controller = new AbortController()
    setContent(null)
    setError(false)
    setLookup(null)
    void requestConversationSearch(session, card, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setContent(result as unknown as Record<string, unknown>)
          if (!parseResult(result as unknown as Record<string, unknown>)) setError(true)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [session, card, attempt])
  const result = useMemo(() => (content ? parseResult(content) : null), [content])
  useEffect(() => {
    if (!active || !result) return
    let current = true
    const key = JSON.stringify([
      tabId,
      result.papers.map(({ id, title, doi, year }) => [id, title, doi, year]),
    ])
    void libraryStatusCache
      .load(scope, key, (signal) =>
        loadConversationLibraryStatus(session, card, result, signal, projectId)
      )
      .then((value) => {
        if (current && libraryStatusCache.revision(scope) === revision)
          setLookup({ revision, value })
      })
      .catch((error: unknown) => {
        if (current && libraryStatusCache.revision(scope) === revision)
          console.warn('[literature-result-status]', error)
      })
    return () => {
      current = false
    }
  }, [active, result, scope, revision, tabId, session, card, projectId])
  if (error)
    return (
      <Alert
        action={
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            {ui('retry')}
          </Button>
        }
        description={t('result.retryDescription')}
        layout="stacked"
        tone="warning"
      />
    )
  if (!result) return <p>{t('result.opening')}</p>
  const status = lookup?.revision === revision ? lookup.value : undefined
  return (
    <ResultReport
      View={LiteratureSearchView}
      result={result}
      saved={status?.saved}
      libraryStatuses={status?.libraryStatuses ?? {}}
      statusWarning={status?.warning}
      authorization={literatureResultAuthorization(conversation ?? history, card)}
      heldSource={
        result.origin === PRECISE_SEARCH_ORIGIN && card
          ? { sessionId: session, cardId: card }
          : undefined
      }
    />
  )
}

export function literatureResultArtifacts(content: Record<string, unknown>): readonly string[] {
  const result = parseResult(content)
  return result ? presentedSearchArtifacts(result) : []
}
