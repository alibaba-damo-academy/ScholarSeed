import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { Suggestions } from './Recommendations'
import { activeThread, useApp } from '../../store'
import { createNextStepSender, nextStepsAvailable, parseNextSteps } from './suggestions'

export function NextSteps({
  cardId,
  turnId,
  content,
}: {
  cardId: string
  turnId?: string
  content: Record<string, unknown>
}): React.JSX.Element | null {
  const { state, composerSubmission } = useApp()
  const thread = activeThread(state)
  const readySession = useSyncExternalStore(
    composerSubmission.subscribe,
    composerSubmission.getSnapshot
  )
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  const sessionId = thread.sessionId
  const currentThread = useRef(thread)
  currentThread.current = thread
  const sendNextStep = useMemo(
    () =>
      createNextStepSender(
        () => currentThread.current,
        { sessionId, cardId, turnId },
        composerSubmission
      ),
    [sessionId, cardId, turnId, composerSubmission]
  )
  const available = Boolean(
    sessionId &&
    readySession === sessionId &&
    nextStepsAvailable(thread, cardId, turnId) &&
    !composerSubmission.consumed(sessionId, cardId)
  )
  const latest = useRef({ sessionId, available })
  latest.current = { sessionId, available }
  const payload = parseNextSteps(content)
  if (!payload) return null

  const send = async (message: string): Promise<void> => {
    const current = latest.current
    if (!current.available || !current.sessionId || pending.current || !message.trim()) return
    pending.current = true
    setBusy(true)
    setFailed(false)
    try {
      const accepted = await sendNextStep(message)
      if (latest.current.sessionId === current.sessionId) {
        setFailed(!accepted)
        if (accepted) setDraft('')
      }
    } catch {
      if (latest.current.sessionId === current.sessionId) setFailed(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <Suggestions
      payload={payload}
      available={available}
      busy={busy}
      failed={failed}
      draft={draft}
      onDraft={setDraft}
      onSend={send}
    />
  )
}
