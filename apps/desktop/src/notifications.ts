const NOTIFICATION_TEXT_MAX_LENGTH = 500
const NOTIFICATION_SESSION_ID_MAX_LENGTH = 256

export interface DesktopNotificationInput {
  sessionId: string
  title: string
  body: string
}

export interface DesktopNotificationResult {
  ok: boolean
  error?: string
}

export function sanitizeDesktopNotification(payload: unknown): DesktopNotificationInput | null {
  if (!payload || typeof payload !== 'object') return null
  const input = payload as { sessionId?: unknown; title?: unknown; body?: unknown }
  const sessionId = String(input.sessionId || '').trim().slice(0, NOTIFICATION_SESSION_ID_MAX_LENGTH)
  const title = String(input.title || '').trim().slice(0, NOTIFICATION_TEXT_MAX_LENGTH)
  const body = String(input.body || '').trim().slice(0, NOTIFICATION_TEXT_MAX_LENGTH)
  return sessionId && title && body ? { sessionId, title, body } : null
}
