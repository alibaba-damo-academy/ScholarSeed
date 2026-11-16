import type { MessageReference } from '../../model.ts'

export function isSelectionReference(reference: MessageReference): boolean {
  return (
    reference.type === 'assistant_context' &&
    Boolean(reference.anchor) &&
    (reference.kind === 'selection' || reference.kind === 'literature')
  )
}

export function selectionReferenceGroups(
  references: readonly MessageReference[]
): Array<{ key: string; items: MessageReference[] }> {
  const groups = new Map<string, { key: string; items: MessageReference[] }>()
  references.forEach((reference, index) => {
    if (!isSelectionReference(reference)) return
    const key = reference.sourceId
      ? JSON.stringify([reference.kind, reference.sourceId, reference.anchor?.documentId ?? null])
      : JSON.stringify([reference.kind, null, reference.id, index])
    const group = groups.get(key)
    if (group) group.items.push(reference)
    else groups.set(key, { key, items: [reference] })
  })
  return [...groups.values()]
}

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
