export const ATTENTION_PATH = '/api/serve/attention'
export const ATTENTION_CLICK_CHANNEL = 'scholarseed:notification-click'
export const ATTENTION_READY_CHANNEL = 'scholarseed:notification-ready'

export interface AttentionItem {
  id: string
  session_id: string
  kind: 'waiting' | 'completed' | 'failed'
  turn_id: string | null
  request_id: string | null
  item_id: string | null
  incident_id?: string | null
  anchor_kind?: 'recovery' | 'waiting' | 'completed' | 'failed'
  title: string
  title_fallback?: 'new_session' | null
  body: string
  created_at: number
  source_seq: number
  revision: number
}

export interface AttentionSnapshot {
  epoch: string
  revision: number
  unread_count: number
  by_session: Record<string, number>
  items: AttentionItem[]
}

const ATTENTION_KINDS = new Set(['waiting', 'completed', 'failed'])
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isOptionalId = (value: unknown): boolean => value === null || (typeof value === 'string' && value.length > 0)

export function attentionSnapshot(value: unknown): AttentionSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid attention snapshot')
  const snapshot = value as AttentionSnapshot
  if (typeof snapshot.epoch !== 'string' || !snapshot.epoch || !isCount(snapshot.revision) ||
      !isCount(snapshot.unread_count) || !Array.isArray(snapshot.items) ||
      snapshot.unread_count !== snapshot.items.length || !snapshot.by_session ||
      typeof snapshot.by_session !== 'object' ||
      !Object.values(snapshot.by_session).every(isCount)) throw new Error('Invalid attention snapshot')
  const ids = new Set<string>()
  const counts: Record<string, number> = Object.create(null)
  for (const item of snapshot.items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        typeof item.session_id !== 'string' || !item.session_id || !ATTENTION_KINDS.has(item.kind) ||
        typeof item.title !== 'string' || typeof item.body !== 'string' ||
        !isOptionalId(item.request_id) || !isOptionalId(item.turn_id) || !isOptionalId(item.item_id) ||
        (item.incident_id !== undefined && !isOptionalId(item.incident_id)) ||
        (item.title_fallback != null && item.title_fallback !== 'new_session') ||
        (item.anchor_kind !== undefined && item.anchor_kind !== 'recovery' && !ATTENTION_KINDS.has(item.anchor_kind)) ||
        !isCount(item.source_seq) || !isCount(item.revision) || item.revision > snapshot.revision ||
        typeof item.created_at !== 'number' || !Number.isFinite(item.created_at))
      throw new Error('Invalid attention item')
    ids.add(item.id)
    counts[item.session_id] = (counts[item.session_id] ?? 0) + 1
  }
  if (Object.keys(counts).length !== Object.keys(snapshot.by_session).length ||
      Object.entries(counts).some(([sessionId, count]) => snapshot.by_session[sessionId] !== count))
    throw new Error('Invalid attention counts')
  return snapshot
}
