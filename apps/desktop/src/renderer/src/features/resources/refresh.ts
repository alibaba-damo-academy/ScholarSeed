export interface ResourceListingRefresh {
  request(): void
  dispose(): void
}

export function createResourceListingRefresh<Result>(
  read: () => Promise<Result | null>,
  publish: (result: Result | null) => void
): ResourceListingRefresh {
  let active = true
  let running = false
  let pending = false

  const drain = async (): Promise<void> => {
    while (active && pending) {
      pending = false
      const result = await read().catch(() => null)
      // A change during the read requires a fresh result before publication.
      if (active && !pending) publish(result)
    }
    running = false
  }

  return {
    request(): void {
      if (!active) return
      pending = true
      if (running) return
      running = true
      queueMicrotask(() => void drain())
    },
    dispose(): void {
      active = false
    },
  }
}
