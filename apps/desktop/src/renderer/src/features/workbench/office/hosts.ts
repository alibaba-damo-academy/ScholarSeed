export interface OfficeRuntimeHost {
  id: string
  viewId: string | null
}

export interface OfficeHostState {
  hosts: readonly OfficeRuntimeHost[]
  queuedViewIds?: readonly string[]
}

function uniqueViewIds(viewIds: readonly string[]): string[] {
  return [...new Set(viewIds)]
}

function statesEqual(left: OfficeHostState, right: OfficeHostState): boolean {
  const leftQueue = left.queuedViewIds ?? []
  const rightQueue = right.queuedViewIds ?? []
  return left.hosts.length === right.hosts.length
    && leftQueue.length === rightQueue.length
    && left.hosts.every((host, index) => host.id === right.hosts[index]?.id && host.viewId === right.hosts[index]?.viewId)
    && leftQueue.every((viewId, index) => viewId === rightQueue[index])
}

export function reconcileOfficeHosts(
  previous: OfficeHostState,
  demandedViewIds: readonly string[],
  nextId: () => string
): OfficeHostState {
  const demanded = uniqueViewIds(demandedViewIds)
  const current = previous.hosts[0]
  const host = current
    ? { ...current, viewId: demanded[0] ?? null }
    : { id: nextId(), viewId: demanded[0] ?? null }
  const next = { hosts: [host], queuedViewIds: demanded.slice(1) }
  return statesEqual(previous, next) ? previous : next
}
