/** Pure resource lifecycle rules shared by the tree UI and cross-feature store orchestration. */

import type { TFunction } from 'i18next'
import {
  findResourceNode,
  withResourceChildren,
  type ResourceCreateMode,
  type ResourceNode,
  type ResourceState
} from './state.ts'
import type { AssistantContextRef } from '../../contracts/assistant'
import type { FileEvent, RootKind } from '../../contracts/content'

export const RESOURCE_DRAG_MIME = 'application/x-scholarseed-resource-path'
export const RESOURCE_PATH_SEPARATOR = '/'
/** Hidden tree root used by Content APIs; resource rows start below this directory. */
export const RESOURCE_ROOT_DIRECTORY = ''
/** The only Content watched root that the resource tree projects. */
export const RESOURCE_TREE_ROOT: RootKind = 'resources'

export interface ResourceTreePage {
  nodes: ResourceNode[]
  total: number
}

export function beginResourceTreeReload(resource: ResourceState): ResourceState {
  return {
    ...resource,
    loadState: resource.loadState === 'ready' || resource.loadState === 'refreshing'
      ? 'refreshing'
      : 'loading'
  }
}

export function finishResourceTreeReload(
  resource: ResourceState,
  result: (ResourceTreePage & { root: string }) | null
): ResourceState {
  if (!result) {
    return {
      ...resource,
      loadState: resource.loadState === 'refreshing' ? 'ready' : 'error'
    }
  }
  return {
    ...resource,
    tree: result.nodes,
    rootTotal: result.total,
    root: result.root,
    loadState: 'ready'
  }
}

export interface MaterializedResourcePath {
  found: boolean
  rootTotal: number
  tree: ResourceNode[]
}

export type ResourceTreePageLoader = (
  directory: string,
  offset: number
) => Promise<ResourceTreePage | null>

export type ResourceMoveError =
  | 'source_not_found'
  | 'target_not_found'
  | 'target_not_directory'
  | 'cannot_move_root'
  | 'move_into_self'
  | 'move_scope_mismatch'
  | 'same_parent'

export type ResourceMoveValidation =
  | { ok: true }
  | { ok: false; error: ResourceMoveError }

const PATH_CONTEXT_KINDS: ReadonlySet<AssistantContextRef['kind']> = new Set([
  'file',
  'dir',
  'selection'
])

/**
 * Whether one Content file event warrants a resource-tree reload.
 *
 * The watcher broadcasts every watched root over a single stream; only
 * `resources/` is this tree's source. Reacting to `sessions/` churn — an Agent's
 * private per-turn output dir — would reload the panel on every intermediate
 * write; for a new empty project that is a continuous loading↔empty flicker.
 * Mirrors the backend version supervisor's own root filter
 * (`resources/service/observe.py`) so both sides hold one boundary.
 */
export function refreshesResourceTree(event: Pick<FileEvent, 'root'>): boolean {
  return event.root === RESOURCE_TREE_ROOT
}

/** Split only the final real suffix. Dotfiles and trailing dots have no locked suffix. */
export function resourceNameParts(
  name: string,
  kind: ResourceNode['kind']
): { basename: string; suffix: string } {
  if (kind === 'dir') return { basename: name, suffix: '' }
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { basename: name, suffix: '' }
  return { basename: name.slice(0, dot), suffix: name.slice(dot) }
}

/** Initialize only a newly created draft; saved names and edited drafts remain original. */
export function resourceDefaultName(mode: ResourceCreateMode, t: TFunction<'resources'>): string {
  return mode === 'create_document' ? t('naming.defaultDocument') : t('naming.defaultFolder')
}

/** Boundary-safe exact-or-descendant match; `folder-copy` is not below `folder`. */
export function isResourcePathAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${RESOURCE_PATH_SEPARATOR}`)
}

export function relocateResourcePath(candidate: string, before: string, after: string): string {
  return isResourcePathAtOrBelow(candidate, before)
    ? `${after}${candidate.slice(before.length)}`
    : candidate
}

/** Visible tree parent. Empty string is the hidden resources root; null means not projected. */
export function resourceParentDirectory(nodes: ResourceNode[], path: string): string | null {
  const visit = (items: ResourceNode[], parent: string): string | null => {
    for (const item of items) {
      if (item.path === path) return parent
      const nested = item.children ? visit(item.children, item.path) : null
      if (nested !== null) return nested
    }
    return null
  }
  return visit(nodes, '')
}

export function resourceDropDirectory(
  nodes: ResourceNode[],
  path: string,
  kind: ResourceNode['kind']
): string | null {
  return kind === 'dir' ? path : resourceParentDirectory(nodes, path)
}

export function expandedResourceAncestors(
  nodes: ResourceNode[],
  path: string,
  expanded: Record<string, boolean>
): Record<string, boolean> {
  const next = { ...expanded }
  let parent = resourceParentDirectory(nodes, path)
  while (parent) {
    next[parent] = true
    parent = resourceParentDirectory(nodes, parent)
  }
  return next
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf(RESOURCE_PATH_SEPARATOR)
  return separator < 0 ? RESOURCE_ROOT_DIRECTORY : path.slice(0, separator)
}

function resourcePathLineage(nodes: ResourceNode[], path: string): string[] {
  const hiddenRoot = nodes.length > 0
    ? parentPath(nodes[0].path)
    : path.split(RESOURCE_PATH_SEPARATOR)[0] ?? RESOURCE_ROOT_DIRECTORY
  if (!hiddenRoot || !path.startsWith(`${hiddenRoot}${RESOURCE_PATH_SEPARATOR}`)) return []
  const relative = path.slice(hiddenRoot.length + RESOURCE_PATH_SEPARATOR.length)
  const names = relative.split(RESOURCE_PATH_SEPARATOR).filter(Boolean)
  return names.map((_, index) =>
    `${hiddenRoot}${RESOURCE_PATH_SEPARATOR}${names.slice(0, index + 1).join(RESOURCE_PATH_SEPARATOR)}`)
}

/**
 * Materialize every row needed to reveal one resource path.
 *
 * The tree is a depth- and width-paged projection. Search, however, can return a
 * file outside that projection. Walk the stable path one directory at a time and
 * fetch only the missing pages so the existing selection/scroll behavior has a
 * real DOM row to target.
 */
export async function materializeResourcePath(
  nodes: ResourceNode[],
  rootTotal: number,
  path: string,
  loadPage: ResourceTreePageLoader
): Promise<MaterializedResourcePath> {
  const lineage = resourcePathLineage(nodes, path)
  if (!lineage.length) return { found: false, rootTotal, tree: nodes }

  let tree = nodes
  let nextRootTotal = Math.max(rootTotal, nodes.length)
  let parent = RESOURCE_ROOT_DIRECTORY

  for (const target of lineage) {
    if (!findResourceNode(tree, target)) {
      const parentNode = parent ? findResourceNode(tree, parent) : null
      let offset = parent ? parentNode?.children?.length ?? 0 : tree.length
      let total = parent
        ? parentNode?.count ?? Number.POSITIVE_INFINITY
        : nextRootTotal

      while (!findResourceNode(tree, target) && (offset === 0 || offset < total)) {
        const page = await loadPage(parent, offset)
        if (!page) return { found: false, rootTotal: nextRootTotal, tree }
        total = page.total
        if (parent) {
          tree = withResourceChildren(
            tree,
            parent,
            page.nodes,
            page.total,
            offset === 0 ? 'replace' : 'append'
          )
        } else {
          tree = offset === 0 ? page.nodes : [...tree, ...page.nodes]
          nextRootTotal = page.total
        }
        if (!page.nodes.length) break
        offset += page.nodes.length
      }
    }
    if (!findResourceNode(tree, target)) {
      return { found: false, rootTotal: nextRootTotal, tree }
    }
    parent = target
  }

  return { found: true, rootTotal: nextRootTotal, tree }
}

export function validateResourceMove(
  nodes: ResourceNode[],
  sourcePath: string,
  targetDirectory: string
): ResourceMoveValidation {
  const source = findNode(nodes, sourcePath)
  if (!source) return { ok: false, error: 'source_not_found' }
  if (source.linkRoot?.mountPath === source.path) {
    return { ok: false, error: 'cannot_move_root' }
  }
  const target = targetDirectory ? findNode(nodes, targetDirectory) : null
  if (targetDirectory && !target) return { ok: false, error: 'target_not_found' }
  if (target && target.kind !== 'dir') return { ok: false, error: 'target_not_directory' }
  if (source.path === targetDirectory || isResourcePathAtOrBelow(targetDirectory, source.path)) {
    return { ok: false, error: 'move_into_self' }
  }
  const sourceScope = source.linkRoot?.rootId ?? null
  const targetScope = target?.linkRoot?.rootId ?? null
  if (sourceScope !== targetScope) return { ok: false, error: 'move_scope_mismatch' }
  if (resourceParentDirectory(nodes, source.path) === targetDirectory) {
    return { ok: false, error: 'same_parent' }
  }
  return { ok: true }
}

export function relocateExpandedResourcePaths(
  expanded: Record<string, boolean>,
  before: string,
  after: string
): Record<string, boolean> {
  const relocated: Record<string, boolean> = {}
  for (const [path, value] of Object.entries(expanded)) {
    relocated[relocateResourcePath(path, before, after)] = value
  }
  return relocated
}

export function removeExpandedResourcePaths(
  expanded: Record<string, boolean>,
  removed: string
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(expanded).filter(([path]) => !isResourcePathAtOrBelow(path, removed))
  )
}

/**
 * Transform only mutable, path-addressed refs in the current selection.
 * Submitted refs belong to an accepted/queued Turn and therefore remain immutable.
 */
export function transformResourceContextRefs(
  refs: readonly AssistantContextRef[],
  submittedRefIds: readonly string[],
  before: string,
  after: string | null,
  exactLabel?: string
): AssistantContextRef[] {
  const submitted = new Set(submittedRefIds)
  return refs.flatMap((ref) => {
    if (
      submitted.has(ref.ref_id)
      || !PATH_CONTEXT_KINDS.has(ref.kind)
      || !isResourcePathAtOrBelow(ref.source_id, before)
    ) {
      return [ref]
    }
    if (after === null) return []
    return [{
      ...ref,
      source_id: relocateResourcePath(ref.source_id, before, after),
      source_revision: null,
      label: ref.source_id === before && exactLabel ? exactLabel : ref.label
    }]
  })
}

function findNode(nodes: ResourceNode[], path: string): ResourceNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    const nested = node.children ? findNode(node.children, path) : null
    if (nested) return nested
  }
  return null
}
