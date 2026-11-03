import type { DestinationNode } from '../../components/business/Destination'
import type { LiteratureDeliveryChoice } from '../../contracts/literature'

export const RESOURCE_ROOT = ''
const PATH_SEPARATOR = '/'
const LOCAL_DESTINATION = 'directory'

export const DELIVERY_STATUS_KEYS = {
  acquiring: 'delivery.status.acquiring',
  pending: 'delivery.status.pending',
  saving: 'delivery.status.saving',
  saved: 'delivery.status.saved',
  partial: 'delivery.status.partial',
  canceled: 'delivery.status.canceled',
} as const

export function deliveryProjectMatches(
  batchProjectId: string,
  projectId: string | undefined,
  projectPath: string | null | undefined
): boolean {
  return (!projectPath || Boolean(projectId)) && batchProjectId === (projectId ?? '')
}

export function deliveryChoiceMatches(
  recorded: LiteratureDeliveryChoice | null | undefined,
  current: LiteratureDeliveryChoice
): boolean {
  return Boolean(
    recorded &&
    recorded.target === current.target &&
    (recorded.project_id ?? '') === (current.project_id ?? '') &&
    recorded.parent === current.parent &&
    recorded.add_to_library === current.add_to_library &&
    recorded.collection_id === current.collection_id &&
    (current.target !== LOCAL_DESTINATION || recorded.ticket === current.ticket)
  )
}

export function resourceFolderNodes(
  nodes: DestinationNode[],
  resourceRoot: string,
  parent = RESOURCE_ROOT
): DestinationNode[] {
  const rootPrefix = resourceRoot ? `${resourceRoot}${PATH_SEPARATOR}` : RESOURCE_ROOT
  const prefix = parent ? `${parent}${PATH_SEPARATOR}` : RESOURCE_ROOT
  const folders = new Map<string, DestinationNode>()
  for (const node of nodes) {
    if (node.origin === 'link' || !node.path.startsWith(rootPrefix)) continue
    const relative = node.path.slice(rootPrefix.length)
    if (!relative.startsWith(prefix)) continue
    const segments = relative.slice(prefix.length).split(PATH_SEPARATOR)
    if (!segments[0] || (node.kind === 'file' && segments.length === 1)) continue
    const path = `${prefix}${segments[0]}`
    if (node.kind === 'dir' && relative === path)
      folders.set(path, {
        ...node,
        path,
        ...(node.children && { children: resourceFolderNodes(node.children, resourceRoot, path) }),
      })
    else if (!folders.has(path)) folders.set(path, { path, name: segments[0], kind: 'dir' })
  }
  return [...folders.values()]
}
