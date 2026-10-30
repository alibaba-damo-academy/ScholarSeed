const revisions = new Map<string, number>()
const listeners = new Set<() => void>()

export function resourceProjectRevision(project: string | null): number {
  return project ? (revisions.get(project) ?? 0) : 0
}

export function invalidateResourceProject(project: string): void {
  revisions.set(project, resourceProjectRevision(project) + 1)
  listeners.forEach((listener) => listener())
}

export function subscribeResourceRevisions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
