import {
  ZOTERO_LIBRARY_ROOT_KEY,
  type ZoteroCollectionNode,
  type ZoteroSelectionDirective
} from './api.ts'

export type ZoteroCheckState = boolean | 'mixed'

export function inheritedZoteroSelection(
  key: string,
  parentSelected: boolean,
  directives: ReadonlyMap<string, boolean>
): boolean {
  return directives.get(key) ?? parentSelected
}

export function zoteroNodeState(
  node: ZoteroCollectionNode,
  parentSelected: boolean,
  directives: ReadonlyMap<string, boolean>
): ZoteroCheckState {
  const selected = inheritedZoteroSelection(node.key, parentSelected, directives)
  const childStates = node.children.map((child) => zoteroNodeState(child, selected, directives))
  const ownStateRelevant = (
    node.key !== ZOTERO_LIBRARY_ROOT_KEY &&
    (node.direct_item_count > 0 || node.children.length === 0)
  )
  const states: ZoteroCheckState[] = [...childStates, ...(ownStateRelevant ? [selected] : [])]
  if (states.length === 0) return false
  if (states.every((state) => state === true)) return true
  if (states.every((state) => state === false)) return false
  return 'mixed'
}

export function updateZoteroSelection(
  directives: ReadonlyMap<string, boolean>,
  node: ZoteroCollectionNode,
  selected: boolean
): Map<string, boolean> {
  const next = new Map(directives)
  const visit = (current: ZoteroCollectionNode): void => {
    next.delete(current.key)
    current.children.forEach(visit)
  }
  visit(node)
  next.set(node.key, selected)
  return next
}

export function zoteroSelectionDirectives(
  selection: ReadonlyMap<string, boolean>
): ZoteroSelectionDirective[] {
  return [...selection].map(([key, selected]) => ({ key, selected }))
}
