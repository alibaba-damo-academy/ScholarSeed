import type { SessionTitleFallback } from './session'
import type { SessionNode, SessionStatus } from './model'

const TERMINAL_STATUSES = new Set<SessionStatus>(['done', 'failed', 'abandon'])

export interface NotificationIntent {
  sessionId: string
  title: string
  title_fallback?: SessionTitleFallback
  bodyKey: 'notifications.waiting' | 'notifications.done' | 'notifications.failed' | 'notifications.abandoned'
  terminal: boolean
}

export function sessionStatusMap(sessions: SessionNode[]): Record<string, SessionStatus> {
  return Object.fromEntries(
    sessions.filter((session) => !session.container).map((session) => [session.id, session.status])
  )
}

export function sessionNeedsAttention(
  session: SessionNode,
  seenAt: number
): boolean {
  if (session.container) return false
  if (session.status === 'waiting') return true
  if (!TERMINAL_STATUSES.has(session.status)) return false
  return (session.activityAt ?? 0) > seenAt
}

export function notificationIntents(
  previous: Record<string, SessionStatus>,
  sessions: SessionNode[],
  activeSession: string | null,
  windowFocused: boolean
): NotificationIntent[] {
  const intents: NotificationIntent[] = []
  for (const session of sessions) {
    if (session.container || (windowFocused && session.id === activeSession)) continue
    const before = previous[session.id]
    const after = session.status
    if (before === after) continue
    if (before === 'running' && after === 'waiting') {
      intents.push({
        sessionId: session.id,
        title: session.title,
        ...(session.title_fallback !== undefined ? { title_fallback: session.title_fallback } : {}),
        bodyKey: 'notifications.waiting',
        terminal: false
      })
      continue
    }
    if ((before === 'running' || before === 'waiting') && TERMINAL_STATUSES.has(after)) {
      intents.push({
        sessionId: session.id,
        title: session.title,
        ...(session.title_fallback !== undefined ? { title_fallback: session.title_fallback } : {}),
        bodyKey: after === 'done' ? 'notifications.done' : after === 'failed' ? 'notifications.failed' : 'notifications.abandoned',
        terminal: true
      })
    }
  }
  return intents
}
