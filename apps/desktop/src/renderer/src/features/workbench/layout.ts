export type DockArea = 'primary' | 'secondary'
export type SplitDirection = 'horizontal' | 'vertical'
export type DropEdge = 'center' | 'left' | 'right' | 'top' | 'bottom'
export type TabInsertion = 'before' | 'after'
export type AdjacentDirection = 'left' | 'right' | 'top' | 'bottom'
export type AdjacentPosition =
  | AdjacentDirection
  | 'leftTop'
  | 'leftBottom'
  | 'rightTop'
  | 'rightBottom'
  | 'topLeft'
  | 'topRight'
  | 'bottomLeft'
  | 'bottomRight'

export interface DockLeaf {
  kind: 'leaf'
  id: string
  tabIds: string[]
  activeTabId: string | null
}

export interface DockSplit {
  kind: 'split'
  id: string
  direction: SplitDirection
  ratio: number
  first: DockNode
  second: DockNode
}

export type DockNode = DockLeaf | DockSplit

export interface DockLayout {
  areas: Record<DockArea, DockNode>
  areaRatio: number
}

export function hasSplitPanes(layout: DockLayout): boolean {
  return (
    layout.areas.primary.kind === 'split' ||
    layout.areas.secondary.kind === 'split' ||
    (nodeTabCount(layout.areas.primary) > 0 && nodeTabCount(layout.areas.secondary) > 0)
  )
}

export const MAX_DOCK_ROWS = 2
export const MAX_DOCK_COLUMNS = 2
export const MAX_DOCK_PANES = MAX_DOCK_ROWS * MAX_DOCK_COLUMNS
export const DOCK_DIVIDER_SIZE = 5
export const DOCK_AREA_DIVIDER_SIZE = 6
const GEOMETRY_EPSILON = Number.EPSILON * 16

interface LeafFrame {
  area: DockArea
  leaf: DockLeaf
  left: number
  top: number
  right: number
  bottom: number
}

export interface AdjacentLeaf {
  area: DockArea
  leaf: DockLeaf
  position: AdjacentPosition
}

const ADJACENT_DIRECTIONS: readonly AdjacentDirection[] = ['left', 'right', 'top', 'bottom']

function dimensions(node: DockNode): { rows: number; columns: number; panes: number } {
  if (node.kind === 'leaf')
    return node.tabIds.length
      ? { rows: 1, columns: 1, panes: 1 }
      : { rows: 0, columns: 0, panes: 0 }
  const first = dimensions(node.first)
  const second = dimensions(node.second)
  return {
    rows:
      node.direction === 'vertical' ? first.rows + second.rows : Math.max(first.rows, second.rows),
    columns:
      node.direction === 'horizontal'
        ? first.columns + second.columns
        : Math.max(first.columns, second.columns),
    panes: first.panes + second.panes,
  }
}

function collectLeafFrames(
  node: DockNode,
  area: DockArea,
  bounds: Omit<LeafFrame, 'area' | 'leaf'>
): LeafFrame[] {
  if (node.kind === 'leaf') return node.tabIds.length ? [{ area, leaf: node, ...bounds }] : []
  if (node.direction === 'horizontal') {
    const divider = bounds.left + (bounds.right - bounds.left) * node.ratio
    return [
      ...collectLeafFrames(node.first, area, { ...bounds, right: divider }),
      ...collectLeafFrames(node.second, area, { ...bounds, left: divider }),
    ]
  }
  const divider = bounds.top + (bounds.bottom - bounds.top) * node.ratio
  return [
    ...collectLeafFrames(node.first, area, { ...bounds, bottom: divider }),
    ...collectLeafFrames(node.second, area, { ...bounds, top: divider }),
  ]
}

function leafFrames(layout: DockLayout): LeafFrame[] {
  const primaryVisible = nodeTabCount(layout.areas.primary) > 0
  const secondaryVisible = nodeTabCount(layout.areas.secondary) > 0
  if (primaryVisible && secondaryVisible) {
    return [
      ...collectLeafFrames(layout.areas.primary, 'primary', {
        left: 0,
        top: 0,
        right: layout.areaRatio,
        bottom: 1,
      }),
      ...collectLeafFrames(layout.areas.secondary, 'secondary', {
        left: layout.areaRatio,
        top: 0,
        right: 1,
        bottom: 1,
      }),
    ]
  }
  const area: DockArea = primaryVisible ? 'primary' : 'secondary'
  return collectLeafFrames(layout.areas[area], area, { left: 0, top: 0, right: 1, bottom: 1 })
}

function overlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number
): number {
  return Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart)
}

function adjacentPosition(
  direction: AdjacentDirection,
  index: number,
  count: number
): AdjacentPosition {
  if (count === 1) return direction
  if (direction === 'left') return index === 0 ? 'leftTop' : 'leftBottom'
  if (direction === 'right') return index === 0 ? 'rightTop' : 'rightBottom'
  if (direction === 'top') return index === 0 ? 'topLeft' : 'topRight'
  return index === 0 ? 'bottomLeft' : 'bottomRight'
}

export function adjacentLeaves(
  layout: DockLayout,
  sourceArea: DockArea,
  sourceLeafId: string,
  direction: AdjacentDirection
): AdjacentLeaf[] {
  const frames = leafFrames(layout)
  const source = frames.find((frame) => frame.area === sourceArea && frame.leaf.id === sourceLeafId)
  if (!source) return []
  const candidates = frames.flatMap((frame) => {
    if (frame === source) return []
    const horizontal = direction === 'left' || direction === 'right'
    const perpendicularOverlap = horizontal
      ? overlap(source.top, source.bottom, frame.top, frame.bottom)
      : overlap(source.left, source.right, frame.left, frame.right)
    const distance =
      direction === 'left'
        ? source.left - frame.right
        : direction === 'right'
          ? frame.left - source.right
          : direction === 'top'
            ? source.top - frame.bottom
            : frame.top - source.bottom
    if (perpendicularOverlap <= GEOMETRY_EPSILON || distance < -GEOMETRY_EPSILON) return []
    return [{ frame, distance: Math.max(0, distance) }]
  })
  if (!candidates.length) return []
  const nearestDistance = Math.min(...candidates.map(({ distance }) => distance))
  const nearest = candidates
    .filter(({ distance }) => Math.abs(distance - nearestDistance) <= GEOMETRY_EPSILON)
    .map(({ frame }) => frame)
    .sort((first, second) =>
      direction === 'left' || direction === 'right'
        ? first.top - second.top
        : first.left - second.left
    )
  return nearest.map((frame, index) => ({
    area: frame.area,
    leaf: frame.leaf,
    position: adjacentPosition(direction, index, nearest.length),
  }))
}

export function adjacentLeaf(
  layout: DockLayout,
  sourceArea: DockArea,
  sourceLeafId: string,
  direction: AdjacentDirection
): AdjacentLeaf | null {
  const targets = adjacentLeaves(layout, sourceArea, sourceLeafId, direction)
  return targets.length === 1 ? targets[0] : null
}

export function moveTargets(
  layout: DockLayout,
  sourceArea: DockArea,
  sourceLeafId: string
): AdjacentLeaf[] {
  return ADJACENT_DIRECTIONS.flatMap((direction) =>
    adjacentLeaves(layout, sourceArea, sourceLeafId, direction)
  )
}

function validGrid(layout: DockLayout): boolean {
  const first = dimensions(layout.areas.primary)
  const second = dimensions(layout.areas.secondary)
  return (
    Math.max(first.rows, second.rows) <= MAX_DOCK_ROWS &&
    first.columns + second.columns <= MAX_DOCK_COLUMNS &&
    first.panes + second.panes <= MAX_DOCK_PANES
  )
}

/** Parallel separators share a ratio so the four-pane layout stays a grid. */
function alignGrid(layout: DockLayout, direction?: SplitDirection, ratio?: number): DockLayout {
  const ratios = new Map<SplitDirection, number>()
  if (direction && ratio !== undefined) ratios.set(direction, ratio)
  const align = (node: DockNode): DockNode => {
    if (node.kind === 'leaf') return node
    const shared = ratios.get(node.direction) ?? node.ratio
    ratios.set(node.direction, shared)
    return { ...node, ratio: shared, first: align(node.first), second: align(node.second) }
  }
  return {
    ...layout,
    areas: { primary: align(layout.areas.primary), secondary: align(layout.areas.secondary) },
  }
}

export const MIN_SPLIT_RATIO = 0.2
export const MAX_SPLIT_RATIO = 0.8
export const DEFAULT_SPLIT_RATIO = 0.5

export function initialLayout(): DockLayout {
  return {
    areas: {
      primary: { kind: 'leaf', id: 'primary-root', tabIds: [], activeTabId: null },
      secondary: { kind: 'leaf', id: 'secondary-root', tabIds: [], activeTabId: null },
    },
    areaRatio: DEFAULT_SPLIT_RATIO,
  }
}

export function clampRatio(value: number): number {
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value))
}

export function firstLeaf(node: DockNode): DockLeaf {
  return node.kind === 'leaf' ? node : firstLeaf(node.first)
}

export function findLeaf(node: DockNode, leafId: string): DockLeaf | null {
  if (node.kind === 'leaf') return node.id === leafId ? node : null
  return findLeaf(node.first, leafId) ?? findLeaf(node.second, leafId)
}

export function nodeTabCount(node: DockNode): number {
  return node.kind === 'leaf'
    ? node.tabIds.length
    : nodeTabCount(node.first) + nodeTabCount(node.second)
}

export function nodeTabIds(node: DockNode): string[] {
  return node.kind === 'leaf'
    ? node.tabIds
    : [...nodeTabIds(node.first), ...nodeTabIds(node.second)]
}

function nodeHasHorizontalSplit(node: DockNode): boolean {
  if (node.kind === 'leaf') return false
  return (
    node.direction === 'horizontal' ||
    nodeHasHorizontalSplit(node.first) ||
    nodeHasHorizontalSplit(node.second)
  )
}

export function hasHorizontalSplit(layout: DockLayout): boolean {
  const primaryVisible = nodeTabCount(layout.areas.primary) > 0
  const secondaryVisible = nodeTabCount(layout.areas.secondary) > 0
  if (primaryVisible && secondaryVisible) return true
  const visibleArea = primaryVisible ? layout.areas.primary : layout.areas.secondary
  return nodeHasHorizontalSplit(visibleArea)
}

function mapLeaf(
  node: DockNode,
  leafId: string,
  transform: (leaf: DockLeaf) => DockNode
): DockNode {
  if (node.kind === 'leaf') return node.id === leafId ? transform(node) : node
  const first = mapLeaf(node.first, leafId, transform)
  const second = mapLeaf(node.second, leafId, transform)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function removeTab(node: DockNode, tabId: string): DockNode {
  if (node.kind === 'leaf') {
    const index = node.tabIds.indexOf(tabId)
    if (index < 0) return node
    const tabIds = node.tabIds.filter((candidate) => candidate !== tabId)
    const activeTabId =
      node.activeTabId === tabId ? (tabIds[index] ?? tabIds[index - 1] ?? null) : node.activeTabId
    return { ...node, tabIds, activeTabId }
  }
  const first = removeTab(node.first, tabId)
  const second = removeTab(node.second, tabId)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function compactNode(node: DockNode): DockNode {
  if (node.kind === 'leaf') return node
  const first = compactNode(node.first)
  const second = compactNode(node.second)
  if (nodeTabCount(first) === 0) return second
  if (nodeTabCount(second) === 0) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

export function removeTabFromLayout(layout: DockLayout, tabId: string): DockLayout {
  return {
    ...layout,
    areas: {
      primary: compactNode(removeTab(layout.areas.primary, tabId)),
      secondary: compactNode(removeTab(layout.areas.secondary, tabId)),
    },
  }
}

export function activateTab(layout: DockLayout, leafId: string, tabId: string): DockLayout {
  for (const area of ['primary', 'secondary'] as const) {
    if (!findLeaf(layout.areas[area], leafId)) continue
    return {
      ...layout,
      areas: {
        ...layout.areas,
        [area]: mapLeaf(layout.areas[area], leafId, (leaf) =>
          leaf.tabIds.includes(tabId) ? { ...leaf, activeTabId: tabId } : leaf
        ),
      },
    }
  }
  return layout
}

export function reorderTabInLeaf(
  layout: DockLayout,
  area: DockArea,
  leafId: string,
  tabId: string,
  targetTabId: string,
  insertion: TabInsertion
): DockLayout {
  if (tabId === targetTabId) return layout
  const leaf = findLeaf(layout.areas[area], leafId)
  if (!leaf || !leaf.tabIds.includes(tabId) || !leaf.tabIds.includes(targetTabId)) return layout
  const withoutDragged = leaf.tabIds.filter((candidate) => candidate !== tabId)
  const targetIndex = withoutDragged.indexOf(targetTabId)
  const insertionIndex = insertion === 'before' ? targetIndex : targetIndex + 1
  const tabIds = [
    ...withoutDragged.slice(0, insertionIndex),
    tabId,
    ...withoutDragged.slice(insertionIndex),
  ]
  if (tabIds.every((candidate, index) => candidate === leaf.tabIds[index])) return layout
  return {
    ...layout,
    areas: {
      ...layout.areas,
      [area]: mapLeaf(layout.areas[area], leafId, (current) => ({ ...current, tabIds })),
    },
  }
}

export function placeTab(
  layout: DockLayout,
  tabId: string,
  targetArea: DockArea,
  targetLeafId?: string,
  edge: DropEdge = 'center',
  idFactory: () => string = () => crypto.randomUUID()
): DockLayout {
  const without = removeTabFromLayout(layout, tabId)
  const root = without.areas[targetArea]
  const leaf = targetLeafId ? findLeaf(root, targetLeafId) : firstLeaf(root)
  if (!leaf) return layout
  const nextRoot = mapLeaf(root, leaf.id, (current) => {
    if (edge === 'center') {
      return {
        ...current,
        tabIds: [...current.tabIds, tabId],
        activeTabId: tabId,
      }
    }
    if (current.tabIds.length === 0) return { ...current, tabIds: [tabId], activeTabId: tabId }
    const added: DockLeaf = {
      kind: 'leaf',
      id: idFactory(),
      tabIds: [tabId],
      activeTabId: tabId,
    }
    const horizontal = edge === 'left' || edge === 'right'
    const addedFirst = edge === 'left' || edge === 'top'
    return {
      kind: 'split',
      id: idFactory(),
      direction: horizontal ? 'horizontal' : 'vertical',
      ratio: DEFAULT_SPLIT_RATIO,
      first: addedFirst ? added : current,
      second: addedFirst ? current : added,
    }
  })
  const candidate = { ...without, areas: { ...without.areas, [targetArea]: nextRoot } }
  return validGrid(candidate) ? alignGrid(candidate) : layout
}

export function canPlaceTab(
  layout: DockLayout,
  tabId: string,
  area: DockArea,
  leafId: string,
  edge: DropEdge
): boolean {
  return placeTab(layout, tabId, area, leafId, edge, () => tabId) !== layout
}

export function resizeSplit(
  layout: DockLayout,
  area: DockArea,
  splitId: string,
  ratio: number
): DockLayout {
  let direction: SplitDirection | undefined
  const update = (node: DockNode): DockNode => {
    if (node.kind === 'leaf') return node
    if (node.id === splitId) {
      direction = node.direction
      return { ...node, ratio: clampRatio(ratio) }
    }
    const first = update(node.first)
    const second = update(node.second)
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  const candidate = { ...layout, areas: { ...layout.areas, [area]: update(layout.areas[area]) } }
  return alignGrid(candidate, direction, clampRatio(ratio))
}
