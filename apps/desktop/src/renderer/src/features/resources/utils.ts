import type { ResourceNode } from './state.ts'
import { RESOURCE_PATH_SEPARATOR } from './lifecycle.ts'

export function resourceListingRows(
  nodes: ResourceNode[],
  expanded: Record<string, boolean>,
  matches?: ReadonlySet<string>,
  ascending?: boolean
): { node: ResourceNode; depth: number }[] {
  const directories = new Set(nodes.filter((node) => node.kind === 'dir').map((node) => node.path))
  const children = new Map<string, ResourceNode[]>()
  const included = matches ? new Set(matches) : null
  const parentOf = (path: string): string =>
    path.slice(0, Math.max(0, path.lastIndexOf(RESOURCE_PATH_SEPARATOR)))
  for (const node of nodes) {
    const parent = parentOf(node.path)
    const key = directories.has(parent) ? parent : ''
    const siblings = children.get(key) ?? []
    siblings.push(node)
    children.set(key, siblings)
    if (matches?.has(node.path)) {
      let ancestor = parent
      while (directories.has(ancestor)) {
        included!.add(ancestor)
        ancestor = parentOf(ancestor)
      }
    }
  }
  const rows: { node: ResourceNode; depth: number }[] = []
  if (ascending !== undefined) {
    for (const siblings of children.values()) {
      siblings.sort((left, right) => {
        const leftTime = left.updatedAt
        const rightTime = right.updatedAt
        if (leftTime == null || !Number.isFinite(leftTime))
          return rightTime == null || !Number.isFinite(rightTime) ? 0 : 1
        if (rightTime == null || !Number.isFinite(rightTime)) return -1
        return ascending ? leftTime - rightTime : rightTime - leftTime
      })
    }
  }
  const visit = (parent: string, depth: number): void => {
    for (const node of children.get(parent) ?? []) {
      if (included && !included.has(node.path)) continue
      rows.push({ node, depth })
      if (node.kind === 'dir' && (expanded[node.path] || included)) visit(node.path, depth + 1)
    }
  }
  visit('', 0)
  return rows
}

export const SUGGESTION_VIEWPORT_MARGIN = 12
export const SOURCE_PREVIEW_LINES = 3
export const SUGGESTION_MIN_WIDTH = 390
export const SUGGESTION_MIN_HEIGHT = 260

export function suggestionSize(
  size: { width: number; height: number },
  position: { left: number; top: number },
  viewport: { width: number; height: number }
): { width: number; height: number } {
  const availableWidth = Math.max(0, viewport.width - position.left - SUGGESTION_VIEWPORT_MARGIN)
  const availableHeight = Math.max(0, viewport.height - position.top - SUGGESTION_VIEWPORT_MARGIN)
  return {
    width: Math.min(availableWidth, Math.max(SUGGESTION_MIN_WIDTH, size.width)),
    height: Math.min(availableHeight, Math.max(SUGGESTION_MIN_HEIGHT, size.height)),
  }
}

export function sourceNeedsDisclosure(height: number, lineHeight: number): boolean {
  return height > lineHeight * SOURCE_PREVIEW_LINES
}

export function suggestionPosition(
  position: { left: number; top: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  return {
    left: Math.max(
      SUGGESTION_VIEWPORT_MARGIN,
      Math.min(position.left, viewport.width - size.width - SUGGESTION_VIEWPORT_MARGIN)
    ),
    top: Math.max(
      SUGGESTION_VIEWPORT_MARGIN,
      Math.min(position.top, viewport.height - size.height - SUGGESTION_VIEWPORT_MARGIN)
    ),
  }
}
