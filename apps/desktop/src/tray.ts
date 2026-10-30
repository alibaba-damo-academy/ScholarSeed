export const TRAY_CHANNEL = {
  request: 'scholarseed:tray-request',
  reply: 'scholarseed:tray-reply',
  navigate: 'scholarseed:tray-navigate',
} as const
export const TRAY_RECENT_LIMIT = 3
export const TRAY_REFRESH_TIMEOUT_MS = 3000
export const TRAY_TEXT_LIMIT = 512
export const TRAY_ACTION = {
  project: 'project',
  create: 'create',
  session: 'session',
  literature: 'literature',
} as const
export interface TraySnapshot {
  project: { id: string; name: string } | null
  sessions: { id: string; title: string }[]
}
export interface TrayReply {
  requestId: number
  snapshot: TraySnapshot | null
}
export type TrayNavigation =
  | { kind: typeof TRAY_ACTION.literature }
  | { kind: typeof TRAY_ACTION.project | typeof TRAY_ACTION.create; projectId: string }
  | { kind: typeof TRAY_ACTION.session; projectId: string; sessionId: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= TRAY_TEXT_LIMIT
}

export function isTrayReply(value: unknown): value is TrayReply {
  if (!record(value) || !Number.isSafeInteger(value.requestId) || Number(value.requestId) <= 0)
    return false
  if (value.snapshot === null) return true
  const snapshot = value.snapshot
  if (!record(snapshot) || !Array.isArray(snapshot.sessions) || snapshot.sessions.length > TRAY_RECENT_LIMIT)
    return false
  if (snapshot.project === null) return snapshot.sessions.length === 0
  if (!record(snapshot.project) || !text(snapshot.project.id) || !text(snapshot.project.name))
    return false
  return snapshot.sessions.every((session) => record(session) && text(session.id) && text(session.title)) &&
    new Set(snapshot.sessions.map((session) => session.id)).size === snapshot.sessions.length
}

export function isTrayNavigation(value: unknown): value is TrayNavigation {
  if (!record(value)) return false
  if (value.kind === TRAY_ACTION.literature) return true
  if (!text(value.projectId)) return false
  return value.kind === TRAY_ACTION.project || value.kind === TRAY_ACTION.create ||
    (value.kind === TRAY_ACTION.session && text(value.sessionId))
}
