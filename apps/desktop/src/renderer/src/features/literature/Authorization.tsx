import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { InteractionQuestion } from '../../contracts/features'
import { activeThread, useApp } from '../../store'
import { IconFont } from '../../components/primitive/Iconfont'
import { ExecutionActivityStatus, ExecutionBatch } from '../../components/business/Execution'
import { Button } from '../../components/ui'
import { retryFulltextAuthorization } from './api'
import {
  LITERATURE_AUTHORIZATION_LABELS,
  literatureRetrievalAuthorization,
  preciseFulltextSubsetAuthorization,
  literatureAuthorizationRequest,
  literatureAuthorizationSource,
  literatureAuthorizationRetryable,
  literatureResultAuthorization,
} from './interaction'
import { parseResult } from './Summary'
import { LiteratureAuthorizationCard } from './Scope'

function LiteratureAuthorizationHistory({
  label,
  warning,
  papers,
  selectedPaperIds,
}: {
  label: string
  warning?: string
  papers: NonNullable<InteractionQuestion['papers']>
  selectedPaperIds: string[]
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div role={warning ? 'alert' : undefined}>
      <ExecutionBatch
        label={label}
        icon={<IconFont type="icon-qingqiupizhun" className="text-[length:var(--vds-icon-6)]" />}
        warning={warning}
        expanded={expanded}
        onExpandedChange={setExpanded}
        animated={false}
      >
        <div
          className="mt-[var(--vds-space-2)] min-w-0"
          data-testid="literature-authorization-history"
        >
          <LiteratureAuthorizationCard
            historical
            selectable={papers.length > 0}
            papers={papers}
            selectedPaperIds={selectedPaperIds}
          />
        </div>
      </ExecutionBatch>
    </div>
  )
}

export function LiteratureAuthorizationNode({
  cardId,
  children,
}: {
  cardId: string
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: conversation } = useTranslation('conversation')
  const { state } = useApp()
  const thread = activeThread(state)
  const request = literatureAuthorizationRequest(thread.conversation, cardId)
  const { status, selectedIds } = literatureResultAuthorization(thread.conversation, cardId)
  const cancelled = request?.hilState === 'cancelled'
  const labels = {
    pending: 'review.authorization.waiting',
    authorized: 'review.authorization.granted',
    rejected: 'review.authorization.declined',
    unknown: 'review.authorization.unknownPapers',
  } as const
  const sourceLabel =
    status === 'authorized' && literatureAuthorizationSource(request?.decisionSource)
  const label = t(
    cancelled
      ? 'review.authorizationCancelled'
      : request?.timedOut
        ? 'review.authorization.timedOut'
        : sourceLabel || labels[status]
  )
  const icon = <IconFont type="icon-qingqiupizhun" className="text-[length:var(--vds-icon-6)]" />
  const question =
    request?.questions?.find((question) => question.resultCardId === cardId) ??
    (request?.questions?.length === 1 ? request.questions[0] : undefined)
  const papers = question?.papers ?? []
  return (
    <section
      className="mb-[var(--vds-conversation-block-gap)] min-w-0"
      data-testid="literature-authorization-node"
    >
      {request &&
      (cancelled || status === 'authorized' || status === 'rejected' || request.timedOut) ? (
        <LiteratureAuthorizationHistory
          label={label}
          warning={request.timedOut ? conversation('clarification.timedOut') : undefined}
          papers={papers}
          selectedPaperIds={cancelled ? [] : (request.selectedPaperIds ?? selectedIds ?? [])}
        />
      ) : (
        <ExecutionActivityStatus
          role={status === 'unknown' ? 'alert' : 'status'}
          label={label}
          icon={icon}
          warning={request?.timedOut ? conversation('clarification.timedOut') : undefined}
        />
      )}
      <div className="min-w-0" data-testid="literature-authorization-result">
        {children}
      </div>
      {status === 'rejected' && request && (
        <div className="mt-[var(--vds-space-2)] grid justify-items-start gap-[var(--vds-space-2)]">
          <p className="m-0 text-[var(--vds-text-secondary)]">
            {t('review.authorizationReplyRejected')}
          </p>
          <LiteratureReauthorization key={request.requestId} requestId={request.requestId} />
        </div>
      )}
    </section>
  )
}

function LiteratureReauthorization({ requestId }: { requestId: string }): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { state, act } = useApp()
  const thread = activeThread(state)
  const [submitting, setSubmitting] = useState(false)
  const [requested, setRequested] = useState(false)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const retry = async (): Promise<void> => {
    if (!thread.sessionId || thread.readOnly || thread.running || inFlight.current || requested)
      return
    inFlight.current = true
    setSubmitting(true)
    setError(false)
    try {
      const revision = await act.prepareAiContext(thread.sessionId)
      if (revision === null) throw new Error('assistant_context_unavailable')
      await retryFulltextAuthorization(thread.sessionId, requestId, revision)
      setRequested(true)
    } catch {
      setError(true)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }
  return (
    <>
      <Button
        variant="secondary"
        size="xs"
        disabled={thread.readOnly || thread.running || submitting || requested}
        loading={submitting}
        data-testid="literature-reauthorize"
        onClick={() => void retry()}
      >
        {t(requested ? 'review.authorization.retryRequested' : 'review.authorization.retry')}
      </Button>
      {error && (
        <p role="alert" className="m-0 text-[var(--vds-error-text-primary)]">
          {t('review.authorization.retryFailed')}
        </p>
      )}
    </>
  )
}

export function LiteratureAuthorizationReceipt({
  cancelled,
  requestId,
  questions,
  answers,
  selectedPaperIds,
  decisionSource,
  timedOut,
}: {
  cancelled?: boolean
  requestId: string
  questions: InteractionQuestion[]
  answers: Record<string, string>
  selectedPaperIds?: string[]
  decisionSource?: string
  timedOut?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation('literature')
  const { t: conversation } = useTranslation('conversation')
  const { state } = useApp()
  const thread = activeThread(state)
  const question = questions[0]
  const answer = answers[question.id || question.header || question.question]
  const subset = preciseFulltextSubsetAuthorization.matches(questions)
  const policy = subset ? preciseFulltextSubsetAuthorization : literatureRetrievalAuthorization
  const label = policy.optionLabel?.({ label: answer ?? '' })
  const rejected = !cancelled && !timedOut && label === LITERATURE_AUTHORIZATION_LABELS[1]
  const granted =
    !cancelled &&
    !timedOut &&
    label === LITERATURE_AUTHORIZATION_LABELS[0] &&
    (!subset || selectedPaperIds?.length !== 0)
  const sourceLabel = granted && literatureAuthorizationSource(decisionSource)
  const papers = question.papers ?? []
  const resultCard = thread.conversation.find(
    (item) => item.kind === 'display_card' && item.card.cardId === question.resultCardId
  )
  if (resultCard?.kind === 'display_card' && resultCard.card.type === 'literature-search') {
    const result = parseResult(resultCard.card.content)
    const cardId = resultCard.card.cardId
    if (result?.selection?.artifact_id) return null
    if (
      result &&
      literatureAuthorizationRequest(thread.conversation, cardId)?.requestId === requestId &&
      ((granted &&
        literatureResultAuthorization(thread.conversation, cardId).status === 'authorized') ||
        (rejected &&
          literatureResultAuthorization(thread.conversation, cardId).status === 'rejected') ||
        timedOut ||
        (cancelled &&
          literatureAuthorizationRequest(thread.conversation, cardId)?.hilState === 'cancelled'))
    )
      return null
  }
  return (
    <div className="min-w-0" data-testid="literature-authorization-receipt">
      <LiteratureAuthorizationHistory
        label={
          cancelled
            ? t('review.authorizationCancelled')
            : timedOut
              ? t('review.authorization.timedOut')
              : sourceLabel
                ? t(sourceLabel)
                : t(
                    rejected
                      ? 'review.authorization.declined'
                      : granted
                        ? 'review.authorization.granted'
                        : 'review.authorization.unknownPapers'
                  )
        }
        warning={timedOut ? conversation('clarification.timedOut') : undefined}
        papers={papers}
        selectedPaperIds={
          cancelled ? [] : (selectedPaperIds ?? (granted ? papers.map((paper) => paper.id) : []))
        }
      />
      {rejected && literatureAuthorizationRetryable(question) && (
        <div className="grid justify-items-start gap-[var(--vds-space-2)]">
          <p className="m-0 text-[var(--vds-text-secondary)]">
            {t('review.authorizationReplyRejected')}
          </p>
          <LiteratureReauthorization requestId={requestId} />
        </div>
      )}
    </div>
  )
}
