import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../app/api/client'

const PREDICTION_TIMEOUT_MS = 45_000

export function useComposerPrediction(
  sessionId: string | null,
  turnId: string,
  running: boolean,
  enabled: boolean,
  blocked: boolean,
  draft: string
): { text: string; dismiss: () => void } {
  const [result, setResult] = useState({ key: '', text: '' })
  const observed = useRef({ sessionId, turnId, running })
  const dismissed = useRef('')
  const abort = useRef<AbortController | null>(null)
  const key = `${sessionId}:${turnId}`
  useEffect(() => {
    const previous = observed.current
    observed.current = { sessionId, turnId, running }
    if (previous.sessionId !== sessionId || running || !enabled || blocked || draft) {
      setResult((current) => (current.text ? { key: '', text: '' } : current))
    }
    if (!enabled || blocked || running || draft || !sessionId || !turnId) return
    if (previous.sessionId !== sessionId || (!previous.running && previous.turnId === turnId))
      return
    const controller = new AbortController()
    abort.current = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PREDICTION_TIMEOUT_MS)])
    void apiFetch(`/api/serve/sessions/${encodeURIComponent(sessionId)}/prediction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_turn_id: turnId }),
      signal,
    })
      .then(async (response) => {
        if (!response.ok) return
        const prediction = (await response.json()) as {
          source_turn_id?: string
          text?: string | null
        }
        if (
          !signal.aborted &&
          prediction.source_turn_id === turnId &&
          typeof prediction.text === 'string'
        ) {
          setResult({ key, text: prediction.text })
        }
      })
      .catch(() => {
        if (!signal.aborted) setResult({ key, text: '' })
      })
    return () => {
      controller.abort()
      if (abort.current === controller) abort.current = null
    }
  }, [sessionId, turnId, running, enabled, blocked, draft, key])

  return {
    text:
      enabled && !blocked && !running && !draft && result.key === key && dismissed.current !== key
        ? result.text
        : '',
    dismiss: () => {
      dismissed.current = key
      abort.current?.abort()
      setResult({ key: '', text: '' })
    },
  }
}
