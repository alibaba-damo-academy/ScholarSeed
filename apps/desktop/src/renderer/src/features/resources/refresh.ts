export interface ResourceListingRefresh {
  request(): void
  dispose(): void
}

export function createResourceListingRefresh<Result>(
  read: () => Promise<Result | null>,
  publish: (result: Result | null, refreshing: boolean) => void
): ResourceListingRefresh {
  let active = true
  let running = false
  let pending = false

  const drain = async (): Promise<void> => {
    while (active && pending) {
      pending = false
      const result = await read().catch(() => null)
      // Show the available snapshot while newer changes are read in the background.
      if (active && (result !== null || !pending)) publish(result, pending)
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
