import type { FileEvent } from '../../contracts/content'

export interface ResourceListingRefresh {
  request(paths?: readonly string[]): void
  dispose(): void
}

export interface ResourceListingSnapshot<Item> {
  items: Item[]
  incremental?: {
    parents: string[]
    supported: boolean
  }
}

export interface ResourceListingChanges<Item> {
  items: Item[]
  groups: { parent: string; paths: string[] }[]
}

function isListingEventPath(path: string | null | undefined): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part && !['.', '..', '.git', '.gitignore'].includes(part))
  )
}

export function resourceListingEventPaths(
  event: Pick<FileEvent, 'kind' | 'path' | 'previous_path'>
): string[] | undefined {
  if (!isListingEventPath(event.path)) return undefined
  switch (event.kind) {
    case 'created':
    case 'modified':
    case 'deleted':
      return [event.path]
    case 'moved':
      return isListingEventPath(event.previous_path) ? [event.previous_path, event.path] : undefined
    default:
      return undefined
  }
}

function listingParent(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), 0))
}

export function applyResourceListingChanges<
  Snapshot extends ResourceListingSnapshot<{ path: string; kind?: string }>,
>(
  snapshot: Snapshot,
  changes: ResourceListingChanges<Snapshot['items'][number]>,
  paths: readonly string[]
): Snapshot | null {
  if (!snapshot.incremental?.supported) return null
  type Item = Snapshot['items'][number]
  // Parent visitation order comes from Serve, including currently empty directories.
  const parents = new Map<string, Item[]>(
    snapshot.incremental.parents.map((parent) => [parent, []])
  )
  if (parents.size !== snapshot.incremental.parents.length) return null
  const previous = new Map<string, Item>()
  for (const item of snapshot.items) {
    const siblings = parents.get(listingParent(item.path))
    if (!siblings || previous.has(item.path)) return null
    siblings.push(item)
    previous.set(item.path, item)
  }

  const affected = new Set(paths)
  const replacements = new Map<string, Item>()
  for (const item of changes.items) {
    if (!affected.has(item.path)) return null
    replacements.set(item.path, item)
  }
  if (replacements.size !== changes.items.length) return null
  const expectedParents = new Set(paths.map(listingParent))
  for (const group of changes.groups) {
    const siblings = parents.get(group.parent)
    if (!siblings || !expectedParents.delete(group.parent)) return null
    const siblingPaths = new Set(group.paths)
    if (
      siblingPaths.size !== group.paths.length ||
      siblings.some((item) => !siblingPaths.has(item.path) && !affected.has(item.path))
    )
      return null
    const directories = siblings.filter((item) => item.kind === 'dir')
    let directoryIndex = 0
    const items: Item[] = []
    for (const path of group.paths) {
      const before = previous.get(path)
      const item = affected.has(path) ? replacements.get(path) : before
      if (!item || listingParent(path) !== group.parent) return null
      if ((item.kind === 'dir') !== (before?.kind === 'dir')) return null
      if (item.kind === 'dir' && directories[directoryIndex++]?.path !== path) return null
      items.push(item)
      replacements.delete(path)
    }
    if (directoryIndex !== directories.length) return null
    parents.set(group.parent, items)
  }
  if (replacements.size || expectedParents.size) return null
  return { ...snapshot, items: [...parents.values()].flat() }
}

export function createResourceListingRefresh<Result>(
  read: () => Promise<Result | null>,
  publish: (result: Result | null, refreshing: boolean) => void,
  readDelta?: (snapshot: Result, paths: readonly string[]) => Promise<Result | null>
): ResourceListingRefresh {
  let active = true
  let running = false
  let pending: true | Set<string> | undefined
  let snapshot: Result | null = null

  const drain = async (): Promise<void> => {
    while (active && pending) {
      const next = pending
      pending = undefined
      let result: Result | null
      if (readDelta && next !== true && snapshot !== null) {
        result = await readDelta(snapshot, [...next]).catch(() => null)
        if (result === null) {
          pending = true
          continue
        }
        // A full invalidation shadows a delta already in flight.
        if (pending === true) continue
      } else {
        result = await read().catch(() => null)
      }
      // Show the available snapshot while newer changes are read in the background.
      snapshot = result
      if (active && (result !== null || !pending)) publish(result, Boolean(pending))
    }
    running = false
  }

  return {
    request(paths): void {
      if (!active) return
      if (!paths?.length || !readDelta || !running) {
        pending = true
      } else if (pending !== true) {
        pending ??= new Set()
        for (const path of paths) pending.add(path)
      }
      if (running) return
      running = true
      queueMicrotask(() => void drain())
    },
    dispose(): void {
      active = false
    },
  }
}
