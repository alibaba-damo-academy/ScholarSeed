import { useEffect, useState } from 'react'

import { sessionChildCount } from '../../api'

export function useSessionChildCount(sessionId: string | undefined): {
  count: number | null
  failed: boolean
} {
  const [result, setResult] = useState<{ id: string; count: number | null } | null>(null)
  useEffect(() => {
    let alive = true
    setResult(null)
    if (sessionId) {
      void sessionChildCount(sessionId).then((count) => {
        if (alive) setResult({ id: sessionId, count })
      })
    }
    return () => {
      alive = false
    }
  }, [sessionId])
  if (!sessionId) return { count: 0, failed: false }
  const current = result?.id === sessionId ? result : null
  return { count: current?.count ?? null, failed: current !== null && current.count === null }
}
