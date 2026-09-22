import type { DocumentViewKind } from './workspace.ts'

const BYTES_PER_UTF16_CODE_UNIT = 2
const MEBIBYTE = 1024 * 1024

export const DEFAULT_EDITOR_LIMIT = 10

export const MAX_TEXT_HISTORY_ENTRIES = 200
export const MAX_TEXT_HISTORY_BYTES = 32 * MEBIBYTE

export interface EditorLimitCandidate {
  id: string
  lastSelectedSequence: number
  protected: boolean
}

export interface TextHistoryEntry {
  text: string
  sequence: number
}

export interface TextHistoryState {
  past: TextHistoryEntry[]
  future: TextHistoryEntry[]
}

export function selectLruTabClosures(
  candidates: readonly EditorLimitCandidate[],
  limit: number
): string[] {
  const overflow = Math.max(0, candidates.length - limit)
  if (overflow === 0) return []
  const evictable = candidates
    .filter((candidate) => !candidate.protected)
    .sort(
      (left, right) =>
        left.lastSelectedSequence - right.lastSelectedSequence ||
        left.id.localeCompare(right.id)
    )
  return evictable.slice(0, overflow).map((candidate) => candidate.id)
}

export function shouldMountDocumentView(
  active: boolean,
  viewKind: DocumentViewKind
): boolean {
  return active || viewKind === 'edit'
}

export function trimTextHistory(
  history: TextHistoryState,
  maxBytes: number,
  maxEntries = Number.MAX_SAFE_INTEGER
): void {
  let bytes = [...history.past, ...history.future].reduce(
    (total, entry) => total + entry.text.length * BYTES_PER_UTF16_CODE_UNIT,
    0
  )
  while (bytes > maxBytes || history.past.length + history.future.length > maxEntries) {
    const past = history.past[0]
    const future = history.future[0]
    if (!past && !future) return
    const removePast = !future || Boolean(past && past.sequence <= future.sequence)
    const removed = removePast ? history.past.shift() : history.future.shift()
    if (removed) bytes -= removed.text.length * BYTES_PER_UTF16_CODE_UNIT
  }
}
