export type HistoryDiffKind = 'same' | 'added' | 'removed'

import type {
  ResourceCapability,
  ResourceDeliveryRestorePreview,
  ResourceDeliveryRestoreResult
} from '../../contracts/resources.ts'
import type { RestoredProjectFile } from './workspace.ts'

export interface HistoryDiffLine {
  kind: HistoryDiffKind
  text: string
}

const MAX_DIFF_LINES = 1500
const MAX_DIFF_CELLS = 1_000_000

function lines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n')
}

function coarseDiff(before: string[], after: string[]): HistoryDiffLine[] {
  return [
    ...before.map((text) => ({ kind: 'removed' as const, text })),
    ...after.map((text) => ({ kind: 'added' as const, text }))
  ]
}

export function buildHistoryDiff(beforeText: string, afterText: string): HistoryDiffLine[] {
  const before = lines(beforeText)
  const after = lines(afterText)
  if (
    before.length > MAX_DIFF_LINES ||
    after.length > MAX_DIFF_LINES ||
    before.length * after.length > MAX_DIFF_CELLS
  ) {
    return coarseDiff(before, after)
  }

  const width = after.length + 1
  const matrix = new Uint32Array((before.length + 1) * width)
  for (let left = 1; left <= before.length; left += 1) {
    for (let right = 1; right <= after.length; right += 1) {
      const index = left * width + right
      matrix[index] = before[left - 1] === after[right - 1]
        ? matrix[(left - 1) * width + right - 1] + 1
        : Math.max(matrix[(left - 1) * width + right], matrix[left * width + right - 1])
    }
  }

  const reversed: HistoryDiffLine[] = []
  let left = before.length
  let right = after.length
  while (left > 0 || right > 0) {
    if (left > 0 && right > 0 && before[left - 1] === after[right - 1]) {
      reversed.push({ kind: 'same', text: before[left - 1] })
      left -= 1
      right -= 1
    } else if (right > 0 && (left === 0 || matrix[left * width + right - 1] >= matrix[(left - 1) * width + right])) {
      reversed.push({ kind: 'added', text: after[right - 1] })
      right -= 1
    } else {
      reversed.push({ kind: 'removed', text: before[left - 1] })
      left -= 1
    }
  }
  return reversed.reverse()
}

export function restoredDeliveryFiles(
  preview: ResourceDeliveryRestorePreview,
  result: ResourceDeliveryRestoreResult
): RestoredProjectFile[] {
  const members = new Map(preview.members.map((member) => [member.file_id, member]))
  return result.versions.map((version) => ({
    fileId: version.file_id,
    versionId: version.id,
    previousPath: members.get(version.file_id)?.path ?? version.path,
    path: version.path,
    state: version.state
  }))
}

/** Retained history identity is independent of the format's preview support. */
export function historyAccess(capability: Pick<ResourceCapability, 'file_id' | 'can_preview_history'> | null | undefined): { available: boolean; canPreview: boolean } {
  return { available: Boolean(capability?.file_id), canPreview: Boolean(capability?.file_id && capability.can_preview_history) }
}
