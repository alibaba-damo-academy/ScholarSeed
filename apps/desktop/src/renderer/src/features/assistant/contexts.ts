import type { MessageReference } from '../../model.ts'

export type OverviewReferenceKind = 'uploads' | 'files' | 'literature' | 'sessions'
export const OVERVIEW_REFERENCE_KINDS: OverviewReferenceKind[] = [
  'uploads',
  'files',
  'literature',
  'sessions',
]

export function overviewReferenceKind(reference: MessageReference): OverviewReferenceKind | null {
  if (reference.type === 'file' || reference.type === 'directory') return 'uploads'
  if (reference.kind === 'literature' || reference.kind === 'literature_collection')
    return 'literature'
  if (reference.kind === 'session') return 'sessions'
  if (['file', 'dir', 'resource', 'selection'].includes(reference.kind ?? '')) return 'files'
  return null
}

export function overviewReferenceGroups(
  references: MessageReference[]
): Array<{ kind: OverviewReferenceKind; items: MessageReference[] }> {
  return OVERVIEW_REFERENCE_KINDS.flatMap((kind) => {
    const items = references.filter((reference) => overviewReferenceKind(reference) === kind)
    return items.length ? [{ kind, items }] : []
  })
}
