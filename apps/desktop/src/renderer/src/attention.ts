export function sessionNeedsAttention(unreadCount: number): boolean {
  return unreadCount > 0
}

export function attentionRequest<Request extends { requestId: string }>(
  requests: readonly Request[], requestId: string | null | undefined
): Request | undefined {
  return requests.find((request) => request.requestId === requestId) ?? requests[0]
}

export interface AttentionFocus {
  sessionId?: string
  incidentId?: string | null
  requestId?: string | null
  itemId?: string | null
  turnId?: string | null
  kind?: 'waiting' | 'completed' | 'failed' | 'progress' | 'recovery'
}

export interface AttentionAnchor {
  recoverySessionId?: string
  recoveryIncidentId?: string
  interactionRequestId?: string
  messageItemId?: string
  messageTurnId?: string
  messageKind?: string
}

export function matchingAttentionAnchors<Anchor extends AttentionAnchor>(
  anchors: readonly Anchor[], focus: AttentionFocus
): Anchor[] {
  if (focus.kind === 'recovery')
    return anchors.filter((anchor) => Boolean(focus.sessionId) && Boolean(focus.incidentId) &&
      anchor.recoverySessionId === focus.sessionId && anchor.recoveryIncidentId === focus.incidentId)
  if (focus.requestId)
    return anchors.filter((anchor) => anchor.interactionRequestId === focus.requestId)
  if (focus.itemId && focus.kind !== 'failed') {
    const exact = anchors.filter((anchor) => anchor.messageItemId === focus.itemId)
    if (exact.length) return exact
  }
  const matchingTurn = anchors.filter((anchor) => Boolean(focus.turnId) && anchor.messageTurnId === focus.turnId)
  if (!focus.kind) return matchingTurn.slice(0, 1)
  const matchingKind = focus.kind === 'progress' ? matchingTurn : matchingTurn.filter((anchor) =>
    anchor.messageKind === (focus.kind === 'failed' ? 'error' : 'agent')
  )
  return matchingKind.slice(-1)
}

export function canReadAttention(state: {
  focused: boolean
  visible: boolean
  loaded: boolean
  covered: boolean
}): boolean {
  return state.focused && state.visible && state.loaded && !state.covered
}

export function attentionContentLoaded(lastSequence: number, sourceSequence: number): boolean {
  return Number.isSafeInteger(sourceSequence) && sourceSequence > 0 && lastSequence >= sourceSequence
}

export function attentionRenderedSequence(
  thread: { lastSeq: number; recoveryIncidentId?: string | null; recoverySourceSeq?: number },
  reminder: { anchor_kind?: string; incident_id?: string | null }
): number {
  if (reminder.anchor_kind !== 'recovery' || !reminder.incident_id ||
    reminder.incident_id !== thread.recoveryIncidentId ||
    !Number.isSafeInteger(thread.recoverySourceSeq)) return thread.lastSeq
  return Math.max(thread.lastSeq, thread.recoverySourceSeq ?? 0)
}
