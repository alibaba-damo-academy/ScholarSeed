import { SESSION_ORDER_PLACEMENTS, type SessionOrderPlacement } from '../../api.ts'

export const SESSION_DRAG_TYPE = 'application/x-scholarseed-session'
export const SESSION_DROP_KINDS = { order: 'order', detach: 'detach', restore: 'restore' } as const

export type SessionDropTarget =
  | { kind: typeof SESSION_DROP_KINDS.order; id: string; placement: SessionOrderPlacement }
  | { kind: typeof SESSION_DROP_KINDS.detach }
  | { kind: typeof SESSION_DROP_KINDS.restore; id: string }

const DROP_POSITION_DIVISOR = 2
const RESTORE_EDGE_DIVISOR = 4

interface SessionDragRow {
  session_id: string
  project_path?: string | null
  display_parent_session_id?: string | null
  detached_parent_session_id?: string | null
  pinned?: boolean
}

export function canDragSession(
  row: { project_path?: string | null },
  projectPath: string | undefined
): boolean {
  return Boolean(projectPath && row.project_path === projectPath)
}

export function canDetachSession(
  row: { project_path?: string | null; display_parent_session_id?: string | null },
  projectPath: string | undefined
): boolean {
  return canDragSession(row, projectPath) && Boolean(row.display_parent_session_id)
}

export function canOrderSession(
  source: SessionDragRow,
  target: SessionDragRow,
  projectPath: string | undefined,
  rows: SessionDragRow[]
): boolean {
  if (
    !canDragSession(source, projectPath) ||
    !canDragSession(target, projectPath) ||
    source.session_id === target.session_id ||
    (source.display_parent_session_id ?? null) !== (target.display_parent_session_id ?? null)
  )
    return false
  if (source.display_parent_session_id) return true
  const pinned = (root: SessionDragRow): boolean =>
    rows.some(
      (row) =>
        row.pinned &&
        (row.session_id === root.session_id || row.display_parent_session_id === root.session_id)
    )
  return pinned(source) === pinned(target)
}

export function sessionDropPlacement(
  clientY: number,
  bounds: Pick<DOMRect, 'top' | 'height'>
): SessionOrderPlacement {
  return clientY < bounds.top + bounds.height / DROP_POSITION_DIVISOR
    ? SESSION_ORDER_PLACEMENTS.before
    : SESSION_ORDER_PLACEMENTS.after
}

export function canRestoreSession(
  source: SessionDragRow,
  target: SessionDragRow,
  projectPath: string | undefined,
  rows: SessionDragRow[]
): boolean {
  return Boolean(
    source.detached_parent_session_id === target.session_id &&
    !source.display_parent_session_id &&
    !target.display_parent_session_id &&
    !rows.some((row) => row.display_parent_session_id === source.session_id) &&
    canOrderSession(source, target, projectPath, [...rows, source])
  )
}

export function isSessionRestorePosition(
  clientY: number,
  bounds: Pick<DOMRect, 'top' | 'height'>
): boolean {
  const edge = bounds.height / RESTORE_EDGE_DIVISOR
  return clientY >= bounds.top + edge && clientY <= bounds.top + bounds.height - edge
}
