import type { DocumentViewKind, DocumentResidency } from './workspace.ts'

const BYTES_PER_UTF16_CODE_UNIT = 2
const MEBIBYTE = 1024 * 1024

export const DEFAULT_DOCUMENT_RESIDENCY_BUDGET: DocumentResidencyBudget = {
  maxBackgroundSessions: 6,
  maxBackgroundBytes: 256 * MEBIBYTE
}

export const MAX_TEXT_HISTORY_ENTRIES = 200
export const MAX_TEXT_HISTORY_BYTES = 32 * MEBIBYTE

export interface DocumentResidencyBudget {
  maxBackgroundSessions: number
  maxBackgroundBytes: number
}

export interface DocumentResidencyCandidate {
  id: string
  residentBytes: number
  selectionCount: number
  lastSelectedSequence: number
  protected: boolean
  budgeted?: boolean
}

export interface ResidentDocumentPayload {
  bytes: Uint8Array
  savedBytes: Uint8Array
  text: string | null
  savedText: string | null
}

export interface TextHistoryEntry {
  text: string
  sequence: number
}

export interface TextHistoryState {
  past: TextHistoryEntry[]
  future: TextHistoryEntry[]
}

export function estimateDocumentResidentBytes(payload: ResidentDocumentPayload): number {
  const buffers = new Set<ArrayBufferLike>()
  let total = 0
  for (const bytes of [payload.bytes, payload.savedBytes]) {
    if (buffers.has(bytes.buffer)) continue
    buffers.add(bytes.buffer)
    total += bytes.buffer.byteLength
  }
  if (payload.text !== null) total += payload.text.length * BYTES_PER_UTF16_CODE_UNIT
  if (payload.savedText !== null && payload.savedText !== payload.text) {
    total += payload.savedText.length * BYTES_PER_UTF16_CODE_UNIT
  }
  return total
}

export function selectLfsEvictions(
  candidates: readonly DocumentResidencyCandidate[],
  budget: DocumentResidencyBudget
): string[] {
  const evictable = candidates
    .filter((candidate) => !candidate.protected)
    .sort(
      (left, right) =>
        left.selectionCount - right.selectionCount ||
        left.lastSelectedSequence - right.lastSelectedSequence ||
        left.id.localeCompare(right.id)
    )
  const budgeted = candidates.filter((candidate) => candidate.budgeted !== false)
  let count = budgeted.length
  let bytes = budgeted.reduce((total, candidate) => total + candidate.residentBytes, 0)
  const evictions: string[] = []
  for (const candidate of evictable) {
    if (count <= budget.maxBackgroundSessions && bytes <= budget.maxBackgroundBytes) break
    evictions.push(candidate.id)
    count -= 1
    bytes -= candidate.residentBytes
  }
  return evictions
}

export function shouldMountDocumentView(
  active: boolean,
  viewKind: DocumentViewKind,
  residency: DocumentResidency
): boolean {
  return active || (viewKind === 'edit' && residency === 'resident')
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
