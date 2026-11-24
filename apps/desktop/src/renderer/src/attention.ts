import type { AttentionItem } from '../../attention'

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

type AnchorField = 'recoverySessionId' | 'interactionRequestId' | 'messageItemId' | 'messageTurnId'

function resolveAttentionAnchors<Anchor extends AttentionAnchor>(
  focus: AttentionFocus,
  find: (field: AnchorField, id: string) => Anchor[]
): Anchor[] {
  if (focus.kind === 'recovery') {
    if (!focus.sessionId || !focus.incidentId) return []
    return find('recoverySessionId', focus.sessionId).filter(
      (anchor) => anchor.recoveryIncidentId === focus.incidentId
    )
  }
  if (focus.requestId) return find('interactionRequestId', focus.requestId)
  if (focus.itemId && focus.kind !== 'failed') {
    const exact = find('messageItemId', focus.itemId)
    if (exact.length) return exact
  }
  const matchingTurn = focus.turnId ? find('messageTurnId', focus.turnId) : []
  if (!focus.kind) return matchingTurn.slice(0, 1)
  const matchingKind =
    focus.kind === 'progress'
      ? matchingTurn
      : matchingTurn.filter(
          (anchor) => anchor.messageKind === (focus.kind === 'failed' ? 'error' : 'agent')
        )
  return matchingKind.slice(-1)
}

export function matchingAttentionAnchors<Anchor extends AttentionAnchor>(
  anchors: readonly Anchor[],
  focus: AttentionFocus
): Anchor[] {
  return resolveAttentionAnchors(focus, (field, id) =>
    anchors.filter((anchor) => anchor[field] === id)
  )
}

/** Index each requested field once during a batch of reminder visibility checks. */
function indexAttentionAnchors<Anchor extends AttentionAnchor>(anchors: readonly Anchor[]) {
  const indexes = new Map<AnchorField, Map<string, Anchor[]>>()
  const find = (field: AnchorField, id: string): Anchor[] => {
    let index = indexes.get(field)
    if (!index) {
      index = new Map()
      for (const anchor of anchors) {
        const key = anchor[field]
        if (!key) continue
        const group = index.get(key)
        if (group) group.push(anchor)
        else index.set(key, [anchor])
      }
      indexes.set(field, index)
    }
    return index.get(id) ?? []
  }
  return (focus: AttentionFocus) => resolveAttentionAnchors(focus, find)
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

interface AttentionThread {
  sessionId?: string | null
  lastSeq: number
  recoveryIncidentId?: string | null
  recoverySourceSeq?: number
}

export function attentionRenderedSequence(
  thread: AttentionThread,
  reminder: { anchor_kind?: string; incident_id?: string | null }
): number {
  if (
    reminder.anchor_kind !== 'recovery' ||
    !reminder.incident_id ||
    reminder.incident_id !== thread.recoveryIncidentId ||
    !Number.isSafeInteger(thread.recoverySourceSeq)
  )
    return thread.lastSeq
  return Math.max(thread.lastSeq, thread.recoverySourceSeq ?? 0)
}

export function visibleAttentionIds<Anchor extends AttentionAnchor>(
  thread: AttentionThread,
  reminders: readonly AttentionItem[],
  readAnchors: () => Anchor[],
  visible: (anchor: Anchor) => boolean
): string[] {
  const loaded = reminders.filter(
    (item) =>
      item.session_id === thread.sessionId &&
      attentionContentLoaded(attentionRenderedSequence(thread, item), item.source_seq)
  )
  if (!loaded.length) return []
  const targetsFor = indexAttentionAnchors(readAnchors())
  return loaded
    .filter((item) =>
      targetsFor({
        sessionId: item.session_id,
        incidentId: item.incident_id,
        requestId: item.request_id,
        itemId: item.item_id,
        turnId: item.turn_id,
        kind: item.anchor_kind ?? item.kind,
      }).some(visible)
    )
    .map((item) => item.id)
}
