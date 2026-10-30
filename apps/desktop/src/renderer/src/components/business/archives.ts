export interface ArchiveReader {
  request(): Promise<void>
  dispose(): void
}

export function createArchiveReader<Result>(
  read: (active: () => boolean) => Promise<Result>,
  publish: (result: Result) => void,
  failed: () => void
): ArchiveReader {
  let disposed = false
  let running = false
  let queued: Array<() => void> = []
  const waiting = new Set<() => void>()
  const active = (): boolean => !disposed
  const settle = (callers: readonly (() => void)[]): void => {
    for (const resolve of callers) {
      waiting.delete(resolve)
      resolve()
    }
  }
  const run = (callers: readonly (() => void)[]): void => {
    running = true
    void (async () => {
      try {
        const result = await read(active)
        if (active()) publish(result)
      } catch {
        if (active()) failed()
      } finally {
        running = false
        settle(callers)
        if (queued.length && active()) {
          const next = queued
          queued = []
          run(next)
        }
      }
    })()
  }
  const request = (): Promise<void> =>
    new Promise((resolve) => {
      if (disposed) {
        resolve()
        return
      }
      waiting.add(resolve)
      if (running) queued.push(resolve)
      else run([resolve])
    })
  return {
    request,
    dispose(): void {
      disposed = true
      queued = []
      settle([...waiting])
    },
  }
}
