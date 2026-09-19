import React from 'react'

import { useTranslation } from 'react-i18next'
import { createFormatters } from '../../../../localization/format'

import { Alert, AlertDescription, AlertTitle, Button } from '../../components/ui'
import { useApp } from '../../store'
import { useWorkspaceController } from '../workbench/workspace'
import {
  fetchFinalizations, finalizationMessage, retryFinalization,
  type ResourceFinalization
} from './finalization'

/** Mounted with the project/session key; pending archives survive conversation reload. */
export function Finalizations({ project, sessionId, running, revision }: {
  project: string
  sessionId: string
  running: boolean
  revision: number
}): React.JSX.Element | null {
  const { act } = useApp()
  const { t, i18n } = useTranslation('resources')
  const format = createFormatters(i18n.resolvedLanguage === 'en' ? 'en' : 'zh')
  const workspace = useWorkspaceController()
  const [entries, setEntries] = React.useState<ResourceFinalization[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [error, setError] = React.useState<{ key: 'finalizations.loadFailed' | 'finalizations.retryFailed' | 'finalizations.openFailed'; detail?: string; path?: string } | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [retrying, setRetrying] = React.useState<string | null>(null)
  const request = React.useRef<AbortController | null>(null)
  const mounted = React.useRef(false)

  const load = React.useCallback(async (nextCursor?: string | null): Promise<void> => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    const page = await fetchFinalizations(project, sessionId, nextCursor, controller.signal)
    if (!mounted.current || controller.signal.aborted) return
    setLoading(false)
    if (!page) {
      setError({ key: 'finalizations.loadFailed' })
      return
    }
    setEntries((current) => nextCursor
      ? [...new Map([...current, ...page.entries].map((entry) => [entry.turn_id, entry])).values()]
      : page.entries)
    setCursor(page.next_cursor)
    setError(null)
    // Read at the terminal writer boundary before invalidating resource state.
    act.invalidateResources()
  }, [act, project, sessionId])

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current?.abort()
    }
  }, [])

  React.useEffect(() => {
    if (!running) void load()
    return () => request.current?.abort()
  }, [running, revision, load])

  const retry = async (entry: ResourceFinalization): Promise<void> => {
    setRetrying(entry.turn_id)
    const result = await retryFinalization(project, sessionId, entry.turn_id)
    if (!mounted.current) return
    setRetrying(null)
    await load()
    if (!mounted.current) return
    if (!result.ok) setError({ key: 'finalizations.retryFailed', detail: result.error ?? 'archive_retry_failed' })
  }

  const inspect = async (path: string): Promise<void> => {
    try {
      await workspace.open({ kind: 'project', project, path }, 'preview')
    } catch {
      if (mounted.current) setError({ key: 'finalizations.openFailed', path })
    }
  }

  if (entries.length === 0 && !error) return null
  return (
    <section aria-label={t('finalizations.label')} data-testid="resource-finalizations">
      {error && <Alert tone="error" description={t(error.key, { detail: error.detail ?? '', path: error.path ?? '' })} />}
      {entries.map((entry) => (
        <Alert key={entry.turn_id} tone="warning" data-testid="resource-finalization-warning">
          <AlertTitle>{t('finalizations.notReadyTitle')}</AlertTitle>
          <AlertDescription truncate={false}>{t(finalizationMessage(entry))}</AlertDescription>
          <AlertDescription truncate={false}>{t('finalizations.startedAt')} {format.date(entry.created_at_ms, { dateStyle: 'short', timeStyle: 'medium' })}</AlertDescription>
          {entry.error && <AlertDescription truncate={false}>{t('finalizations.reason')} <code>{entry.error}</code></AlertDescription>}
          <ul>{entry.paths.map((path) => (
            <li key={path}>
              <Button variant="ghost" size="sm" onClick={() => void inspect(path)}>{path}</Button>
            </li>
          ))}</ul>
          {entry.retryable && (
            <Button size="sm" disabled={running || retrying !== null} onClick={() => void retry(entry)}>
              {retrying === entry.turn_id ? t('finalizations.retrying') : t('finalizations.retry')}
            </Button>
          )}
        </Alert>
      ))}
      <Button variant="ghost" size="sm" disabled={running || loading || retrying !== null} onClick={() => void load()}>{t('finalizations.refresh')}</Button>
      {cursor && <Button variant="ghost" size="sm" disabled={running || loading || retrying !== null} onClick={() => void load(cursor)}>{t('finalizations.more')}</Button>}
    </section>
  )
}
