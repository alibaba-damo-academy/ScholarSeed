import { useCallback, useEffect, useRef, useState } from 'react'

import { apiFetch } from '../../api'
import { useApp } from '../../store'
import { parseForkOrigin, type ForkOrigin } from './fork'

const FORK_ORIGIN_UNAVAILABLE = 'fork_origin_unavailable'
const FORK_ORIGIN_TIMEOUT_MS = 15_000

export function useForkOrigin(sessionId: string | null): {
  origin: ForkOrigin | null
  failed: boolean
  refresh: () => Promise<ForkOrigin | null>
} {
  const { state } = useApp()
  const [snapshot, setSnapshot] = useState<{
    sessionId: string | null
    origin: ForkOrigin | null
    failed: boolean
  }>({ sessionId: null, origin: null, failed: false })
  const requests = useRef({ generation: 0, sessionId }).current
  requests.sessionId = sessionId
  const refresh = useCallback(async (): Promise<ForkOrigin | null> => {
    if (!sessionId) return null
    const request = ++requests.generation
    try {
      const response = await apiFetch(
        `/api/serve/sessions/${encodeURIComponent(sessionId)}/fork-origin`,
        { cache: 'no-store', timeoutMs: FORK_ORIGIN_TIMEOUT_MS }
      )
      if (!response.ok) throw new Error(FORK_ORIGIN_UNAVAILABLE)
      const data = (await response.json()) as { origin?: unknown }
      const origin = parseForkOrigin(data.origin)
      if (request !== requests.generation || sessionId !== requests.sessionId) return null
      setSnapshot({ sessionId, origin, failed: false })
      return origin
    } catch {
      if (request === requests.generation && sessionId === requests.sessionId)
        setSnapshot((previous) => ({
          sessionId,
          origin: previous.sessionId === sessionId ? previous.origin : null,
          failed: true,
        }))
      return null
    }
  }, [sessionId, requests])
  useEffect(() => {
    void refresh()
    return () => {
      requests.generation++
    }
  }, [refresh, requests, state.sessionCatalogRevision])
  return {
    origin: snapshot.sessionId === sessionId ? snapshot.origin : null,
    failed: snapshot.sessionId === sessionId && snapshot.failed,
    refresh,
  }
}
