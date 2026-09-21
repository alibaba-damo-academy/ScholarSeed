import { JoinLibraryMenu } from './JoinMenu'
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { LITERATURE_RESULT_PREFIX } from '../workbench/tabs'
import { LiteratureSearchView } from './Search'
import { loadConversationSearch } from './api'
import { conversationSearchPapers, presentedSearchArtifacts } from './result'
import type { ConversationSearchResult } from '../../contracts/literature'

import { useApp } from '../../store'
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui'

const PREVIEW_PAPERS = 3
const SEARCH_CARD_VERSION = '1.0'
const RESULT_LABELS = {
  success: 'result.status.success',
  partial: 'result.status.partial',
  no_confident_match: 'result.status.no_confident_match',
  source_failed: 'result.status.source_failed',
  execution_blocked: 'result.status.execution_blocked',
  invalid_result: 'result.status.invalid_result',
} as const
const SOURCE_LABELS = {
  success: 'result.sourceStatus.success',
  partial: 'result.sourceStatus.partial',
  failed: 'result.sourceStatus.failed',
  unavailable: 'result.sourceStatus.unavailable',
  execution_blocked: 'result.sourceStatus.execution_blocked',
  transport_error: 'result.sourceStatus.transport_error',
  authentication_error: 'result.sourceStatus.authentication_error',
  unknown: 'result.sourceStatus.unknown',
} as const
const numberLabel = (value: number | null, t: TFunction<'literature'>): string => value === null ? t('searchResult.notRecorded') : String(value)

function parseResult(content: Record<string, unknown>): ConversationSearchResult | null {
  if (content.schema_version !== SEARCH_CARD_VERSION || typeof content.session_id !== 'string'
    || typeof content.status !== 'string' || !Object.prototype.hasOwnProperty.call(RESULT_LABELS, content.status)
    || !Array.isArray(content.papers) || !Array.isArray(content.criteria)
    || !Array.isArray(content.sources) || !Array.isArray(content.warnings)) return null
  return content as unknown as ConversationSearchResult
}

export function LiteratureResults({ content, cardId }: { content: Record<string, unknown>; cardId: string }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { act } = useApp()
  const result = parseResult(content)
  if (!result) return <Alert tone="warning"><AlertDescription>{t('result.unreadable')}</AlertDescription></Alert>
  const selectedCorpus = Boolean(result.selection?.artifact_id)
  return <Card data-testid="literature-search-preview">
    <CardHeader><CardTitle>{t('result.heading', { heading: selectedCorpus ? t('searchResult.authorizationPending') : t(RESULT_LABELS[result.status as keyof typeof RESULT_LABELS]), count: result.retained })}</CardTitle>
      <CardDescription className="line-clamp-2">{result.criteria[0] || t('result.search')}</CardDescription></CardHeader>
    <CardContent><div className="grid gap-[var(--vds-space-2)]">
      {conversationSearchPapers(result.papers.slice(0, PREVIEW_PAPERS)).map(paper => <div key={paper.paper_id} className="grid gap-[var(--vds-space-1)]"><p className="m-0 line-clamp-2">{paper.title}{paper.year ? ` · ${paper.year}` : ''}</p><div><JoinLibraryMenu papers={[paper]} /></div></div>)}
      <p className="m-0 text-[var(--vds-text-secondary)]">{t('result.summary', { sources: result.sources.length, candidates: numberLabel(result.candidates, t), deduplicated: numberLabel(result.deduplicated, t), retained: result.retained })}</p>
      {result.warnings.length > 0 && <p className="m-0 line-clamp-2 text-[var(--vds-text-secondary)]">{result.warnings[0]}</p>}
      <Button variant="secondary" onClick={() => act.openLiteratureResult({ session_id: result.session_id, card_id: cardId, title: result.criteria[0] || '' })}>{t('result.viewAll')}</Button>
    </div></CardContent>
  </Card>
}

export function LiteratureResultTab({ tabId }: { tabId: string }): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  return <ScopedLiteratureResultTab key={JSON.stringify([tabId, projectId])} tabId={tabId} projectId={projectId} />
}

function ScopedLiteratureResultTab({ tabId, projectId }: { tabId: string; projectId?: string }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const [content, setContent] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState(false)
  const [saved, setSaved] = useState<string[]>([])
  const [statusWarning, setStatusWarning] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setContent(null); setError(false); setStatusWarning(false); setSaved([])
    const [session, card] = tabId.slice(LITERATURE_RESULT_PREFIX.length).split('/')
    void loadConversationSearch(decodeURIComponent(session), decodeURIComponent(card), controller.signal, projectId)
      .then(({ result, saved, warning }) => {
        if (!controller.signal.aborted) {
          setSaved(saved); setStatusWarning(warning)
          setContent(result as unknown as Record<string, unknown>)
          if (!parseResult(result as unknown as Record<string, unknown>)) setError(true)
        }
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [tabId, attempt, projectId])
  if (error) return <Alert tone="warning"><AlertDescription>{t('result.retryDescription')}</AlertDescription><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>{ui('retry')}</Button></Alert>
  const result = content ? parseResult(content) : null
  if (!result) return <p>{t('result.opening')}</p>
  const statusWarningText = statusWarning ? t('result.statusUnavailable') : ''
  const overview = [
    ...result.criteria,
    result.selection?.artifact_id
      ? t('result.pending', { count: result.retained })
      : t('result.counts', { candidates: numberLabel(result.candidates, t), deduplicated: numberLabel(result.deduplicated, t), retained: result.retained }),
    ...result.sources.map(source => t('result.source', { name: source.name, status: t(Object.prototype.hasOwnProperty.call(SOURCE_LABELS, source.status) ? SOURCE_LABELS[source.status as keyof typeof SOURCE_LABELS] : 'searchResult.notRecorded'), queries: numberLabel(source.queries, t), candidates: numberLabel(source.candidates, t) })),
    ...result.warnings, statusWarningText
  ].join('\n\n')
  const status = result.papers.length ? 'completed' : result.status === 'no_confident_match' ? 'empty' : 'failed'
  return <LiteratureSearchView key={tabId} query={result.criteria[0] || t('result.query')}
    papers={conversationSearchPapers(result.papers)} status={status} output={overview}
    warning={[statusWarningText, ...(result.status === 'success' || result.status === 'no_confident_match' ? [] : [t(RESULT_LABELS[result.status as keyof typeof RESULT_LABELS])])].filter(Boolean).join('；')}
    savedPaperIds={saved} />
}

export function literatureResultArtifacts(content: Record<string, unknown>): readonly string[] {
  const result = parseResult(content)
  return result ? presentedSearchArtifacts(result) : []
}
