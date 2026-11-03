import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { LITERATURE_RESULT_PREFIX } from '../workbench/tabs'
import { LiteratureSearchView } from './Search'
import { loadConversationSearch } from './api'
import { presentedSearchArtifacts } from './result'
import { ResultReport } from './Report'
import type { ResultLibraryState } from '../../contracts/literature'
import { parseResult } from './Summary'

import { useApp } from '../../store'
import { Alert, Button } from '../../components/ui'

export function LiteratureResultTab({ tabId }: { tabId: string }): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  return (
    <ScopedLiteratureResultTab
      key={JSON.stringify([tabId, projectId])}
      tabId={tabId}
      projectId={projectId}
    />
  )
}

function ScopedLiteratureResultTab({
  tabId,
  projectId,
}: {
  tabId: string
  projectId?: string
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const [content, setContent] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState<string[]>([])
  const [statusWarning, setStatusWarning] = useState(false)
  const [libraryStatuses, setLibraryStatuses] = useState<Record<string, ResultLibraryState>>({})
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setContent(null)
    setError(false)
    setStatusWarning(false)
    setSaved([])
    setLibraryStatuses({})
    const [session, card] = tabId.slice(LITERATURE_RESULT_PREFIX.length).split('/')
    void loadConversationSearch(
      decodeURIComponent(session),
      decodeURIComponent(card),
      controller.signal,
      projectId
    )
      .then(({ result, saved, warning, libraryStatuses }) => {
        if (!controller.signal.aborted) {
          setSaved(saved)
          setStatusWarning(warning)
          setLibraryStatuses(libraryStatuses)
          setContent(result as unknown as Record<string, unknown>)
          if (!parseResult(result as unknown as Record<string, unknown>)) setError(true)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => controller.abort()
  }, [tabId, attempt, projectId])
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
  const result = content ? parseResult(content) : null
  if (!result) return <p>{t('result.opening')}</p>
  return (
    <ResultReport
      View={LiteratureSearchView}
      result={result}
      saved={saved}
      libraryStatuses={libraryStatuses}
      statusWarning={statusWarning}
    />
  )
}

export function literatureResultArtifacts(content: Record<string, unknown>): readonly string[] {
  const result = parseResult(content)
  return result ? presentedSearchArtifacts(result) : []
}
