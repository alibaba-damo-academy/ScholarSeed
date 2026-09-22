/** Durable review-capture failures, separate from runtime terminal outcome. */

export interface ResourceFinalization {
  session_id: string
  turn_id: string
  terminal_outcome: 'completed' | 'failed' | 'interrupted'
  error: string | null
  paths: string[]
  created_at_ms: number
  snapshot_available: boolean
  retryable: boolean
}

export interface FinalizationPage {
  entries: ResourceFinalization[]
  next_cursor: string | null
}

const ROUTE = '/api/resource/finalizations'
const base = (): string => window.scholarseed?.getApiBase() ?? ''

export async function fetchFinalizations(
  project: string, sessionId: string, cursor?: string | null, signal?: AbortSignal
): Promise<FinalizationPage | null> {
  const query = new URLSearchParams({ project, session_id: sessionId })
  if (cursor) query.set('cursor', cursor)
  try {
    const response = await fetch(`${base()}${ROUTE}?${query}`, { credentials: 'include', signal })
    if (!response.ok) return null
    return await response.json() as FinalizationPage
  } catch { return null }
}

export async function retryFinalization(
  project: string, sessionId: string, turnId: string
): Promise<{ ok: boolean; error?: string }> {
  const query = new URLSearchParams({ project, session_id: sessionId })
  try {
    const response = await fetch(`${base()}${ROUTE}/${encodeURIComponent(turnId)}/retry?${query}`, {
      method: 'POST', credentials: 'include', headers: { 'Idempotency-Key': crypto.randomUUID() }
    })
    if (response.ok) return { ok: true }
    const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null
    return { ok: false, error: payload?.error?.code ?? 'archive_retry_failed' }
  } catch { return { ok: false, error: 'archive_retry_unavailable' } }
}

export function finalizationMessage(
  entry: Pick<ResourceFinalization, 'error' | 'snapshot_available' | 'retryable'>
) {
  if (entry.error === 'turn_baseline_unavailable') {
    return 'finalizations.baselineUnavailable' as const
  }
  if (!entry.snapshot_available) {
    return 'finalizations.snapshotUnavailable' as const
  }
  if (!entry.retryable) {
    return 'finalizations.retryUnsafe' as const
  }
  return 'finalizations.snapshotRetained' as const
}
