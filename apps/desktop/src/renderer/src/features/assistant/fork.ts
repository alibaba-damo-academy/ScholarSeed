import type { ActivityRow } from '../../activity.ts'
import type { NavigationSession } from '../../api.ts'

export const FORK_ORIGIN_STATUSES = [
  'available',
  'deleted',
  'forbidden',
  'archived',
  'anchor_unavailable',
  'unavailable',
] as const

export interface ForkMessageAnchor {
  turn_id: string
  item_id: string
}

export interface ForkOrigin {
  source_session_id: string
  source_product_seq: number
  source_turn_id: string | null
  inherited_messages: ForkMessageAnchor[]
  anchor: ForkMessageAnchor | null
  title: string | null
  title_fallback: 'new_session' | null
  navigation: NavigationSession | null
  status: (typeof FORK_ORIGIN_STATUSES)[number]
}

const INVALID_FORK_ORIGIN = 'invalid_fork_origin'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function messageAnchor(value: unknown): value is ForkMessageAnchor {
  return (
    record(value) &&
    typeof value.turn_id === 'string' &&
    typeof value.item_id === 'string' &&
    Boolean(value.item_id)
  )
}

export function parseForkOrigin(value: unknown): ForkOrigin | null {
  if (value === null) return null
  if (
    !record(value) ||
    typeof value.source_session_id !== 'string' ||
    !value.source_session_id ||
    !Number.isSafeInteger(value.source_product_seq) ||
    Number(value.source_product_seq) < 0 ||
    (value.source_turn_id !== null && typeof value.source_turn_id !== 'string') ||
    !Array.isArray(value.inherited_messages) ||
    !value.inherited_messages.every(messageAnchor) ||
    (value.anchor !== null && !messageAnchor(value.anchor)) ||
    (value.title !== null && typeof value.title !== 'string') ||
    (value.title_fallback !== null && value.title_fallback !== 'new_session') ||
    !FORK_ORIGIN_STATUSES.some((status) => status === value.status)
  )
    throw new Error(INVALID_FORK_ORIGIN)
  if (value.status === 'available') {
    const navigation = value.navigation
    if (
      !messageAnchor(value.anchor) ||
      !record(navigation) ||
      navigation.session_id !== value.source_session_id ||
      typeof value.title !== 'string' ||
      typeof navigation.title !== 'string' ||
      (navigation.title_fallback !== null && navigation.title_fallback !== 'new_session') ||
      typeof navigation.runtime_workdir !== 'string' ||
      (navigation.project_path !== null && typeof navigation.project_path !== 'string') ||
      typeof navigation.runtime_id !== 'string' ||
      typeof navigation.running !== 'boolean'
    )
      throw new Error(INVALID_FORK_ORIGIN)
  }
  return value as unknown as ForkOrigin
}

export function forkBoundaryIndex(
  rows: readonly ActivityRow[],
  inherited: readonly ForkMessageAnchor[]
): number {
  const turnIds = new Set(inherited.map((anchor) => anchor.turn_id).filter(Boolean))
  const itemIds = new Set(inherited.map((anchor) => anchor.item_id))
  let boundary = 0
  rows.forEach((row, index) => {
    const inherited =
      row.kind === 'item'
        ? Boolean(row.item.turnId && turnIds.has(row.item.turnId)) ||
          Boolean(row.item.itemId && itemIds.has(row.item.itemId))
        : Boolean(row.turnId && turnIds.has(row.turnId))
    if (inherited) boundary = index + 1
  })
  return boundary
}
