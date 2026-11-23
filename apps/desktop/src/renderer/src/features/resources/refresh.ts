import type { FileEvent } from '../../contracts/content'
import { RESOURCE_PATH_SEPARATOR, RESOURCE_ROOT_DIRECTORY } from './lifecycle.ts'
import type { ResourceNode } from './state'

export interface ResourceListingRefresh {
  request(paths?: readonly string[]): void
  dispose(): void
}

export const RESOURCE_LISTING_SCOPE_UNAVAILABLE = Symbol('resource listing scope unavailable')
type ResourceListingRead<Result> = Result | null | typeof RESOURCE_LISTING_SCOPE_UNAVAILABLE
const INVALID_SCOPE_STATUSES = new Set([400, 401, 403, 404, 410])

export function isResourceListingBoundaryFailure(status: number, detail?: string): boolean {
  return INVALID_SCOPE_STATUSES.has(status) || (status === 409 && detail !== 'root_busy')
}

export interface ResourceListingSnapshot<Item> {
  items: Item[]
  incremental?: {
    parents: string[]
    supported: boolean
  }
}

export interface ResourceListingDirectorySnapshot extends ResourceListingSnapshot<ResourceNode> {
  directory: string
  versionsLoaded: boolean
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
  return path.slice(0, Math.max(path.lastIndexOf(RESOURCE_PATH_SEPARATOR), 0))
}

export function resourceListingDirectories(
  directories: ReadonlyMap<string, { snapshot: ResourceListingDirectorySnapshot | null }>,
  expanded: Record<string, boolean>
): string[] {
  const visible = new Set([RESOURCE_ROOT_DIRECTORY])
  for (const parent of visible) {
    for (const entry of directories.get(parent)?.snapshot?.items ?? []) {
      if (entry.kind === 'dir' && expanded[entry.path] === true) visible.add(entry.path)
    }
  }
  return [...visible]
}

export function listingDirectoryNodes(
  directories: ReadonlyMap<string, { snapshot: ResourceListingDirectorySnapshot | null }>,
  visible: readonly string[]
): ResourceNode[] {
  const nodes = new Map<string, ResourceNode>()
  for (const parent of visible) {
    for (const entry of directories.get(parent)?.snapshot?.items ?? []) {
      if (!nodes.has(entry.path)) nodes.set(entry.path, entry)
    }
  }
  return [...nodes.values()]
}

export function resourceListingDirectoryEventPaths(
  directory: string | undefined,
  paths: readonly string[] | undefined
): string[] | undefined {
  if (
    !paths ||
    directory === undefined ||
    paths.some(
      (changed) =>
        directory === changed || directory.startsWith(`${changed}${RESOURCE_PATH_SEPARATOR}`)
    )
  )
    return undefined
  return paths.filter((path) => listingParent(path) === directory)
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
  read: () => Promise<ResourceListingRead<Result>>,
  publish: (result: Result | null, refreshing: boolean, invalidated?: boolean) => void,
  readDelta?: (snapshot: Result, paths: readonly string[]) => Promise<Result | null>,
  options?: {
    deltaWhileIdle?: boolean
    hydrate?: (snapshot: Result) => Promise<ResourceListingRead<Result>>
  }
): ResourceListingRefresh {
  let active = true
  let running = false
  let pending: true | Set<string> | undefined
  let snapshot: Result | null = null
  let revision = 0
  let hydrating = false
  let pendingHydration: { snapshot: Result; revision: number } | undefined

  const hydrate = options?.hydrate
  const drainHydration = async (): Promise<void> => {
    if (!hydrate) return
    while (active && pendingHydration) {
      const job = pendingHydration
      pendingHydration = undefined
      if (job.revision !== revision || snapshot !== job.snapshot) continue
      const result = await hydrate(job.snapshot).catch(() => null)
      if (
        active &&
        job.revision === revision &&
        snapshot === job.snapshot &&
        result !== null &&
        result !== snapshot
      ) {
        const invalidated = result === RESOURCE_LISTING_SCOPE_UNAVAILABLE
        snapshot = invalidated ? null : result
        publish(snapshot, false, invalidated)
      }
    }
    hydrating = false
  }

  const drain = async (): Promise<void> => {
    while (active && pending) {
      const next = pending
      pending = undefined
      const readingRevision = revision
      let result: ResourceListingRead<Result>
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
      const invalidated = result === RESOURCE_LISTING_SCOPE_UNAVAILABLE
      snapshot = result === RESOURCE_LISTING_SCOPE_UNAVAILABLE ? null : result
      if (active && (result !== null || !pending)) publish(snapshot, Boolean(pending), invalidated)
      if (active && hydrate && snapshot !== null && !pending) {
        pendingHydration = { snapshot, revision: readingRevision }
        if (!hydrating) {
          hydrating = true
          void drainHydration()
        }
      }
    }
    running = false
  }

  return {
    request(paths): void {
      if (!active) return
      revision += 1
      if (!paths?.length || !readDelta || (!running && !options?.deltaWhileIdle)) {
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
