import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Textarea,
} from '../../components/ui'
import { activeThread, useApp } from '../../store'
import {
  createNextStepSender,
  nextStepMessage,
  nextStepsAvailable,
  parseNextSteps,
} from './suggestions'

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
  const { t } = useTranslation('conversation')
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
    <Card data-testid="next-steps-card" aria-busy={busy}>
      <CardHeader>
        <CardTitle>{payload.title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-[var(--vds-space-3)]">
        {payload.options.map((option) => (
          <Button
            key={option.label}
            variant="secondary"
            size="content"
            className="w-full min-w-0 flex-col items-start !whitespace-normal text-left"
            disabled={!available || busy}
            onClick={() => void send(nextStepMessage(option))}
          >
            <span className="w-full break-words">{option.label}</span>
            <span className="w-full break-words">{option.description}</span>
          </Button>
        ))}
        <Textarea
          label={payload.free_text_label}
          value={draft}
          rows={2}
          disabled={!available || busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        {failed && (
          <Alert tone="error">
            <AlertDescription>{t('retry.continueUnconfirmed')}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end">
          <Button
            loading={busy}
            disabled={!available || !draft.trim()}
            onClick={() => void send(draft)}
          >
            {payload.submit_label}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
