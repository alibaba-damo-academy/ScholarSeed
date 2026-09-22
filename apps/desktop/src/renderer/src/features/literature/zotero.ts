import {
  ZOTERO_LIBRARY_ROOT_KEY,
  type ZoteroCollectionNode,
  type ZoteroPreview,
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

/**
 * 「开始导入」的闭锁条件。
 *
 * `busy` 必须包含提交中这一段: 受理请求返回前对话框还开着, 按钮不禁用就能再点一次,
 * 而文献库是追加语义 (proposal 91) —— 连点两下就是两份条目。
 */
export function zoteroImportBlocked(
  preview: ZoteroPreview | null,
  unfiled: boolean,
  selection: ReadonlyMap<string, boolean>,
  busy: boolean
): boolean {
  if (busy || preview === null) return true
  return zoteroNodeState(preview.library, false, selection) === false && !unfiled
}
