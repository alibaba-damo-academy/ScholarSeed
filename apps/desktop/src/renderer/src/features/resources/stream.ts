import { createResourceListingRefresh } from './refresh.ts'

type SearchRead<Item, Snapshot> = (
  signal: AbortSignal,
  onBatch: (items: Item[]) => void
) => Promise<Snapshot | null>

export function createResourceListingSearch<
  Item extends { path: string },
  Snapshot extends { items: Item[] },
>(
  read: SearchRead<Item, Snapshot>,
  readDelta: (snapshot: Snapshot, paths: readonly string[]) => Promise<Snapshot | null>,
  publish: (items: Item[] | null, refreshing: boolean, failed: boolean) => void,
  schedulePaint: (callback: () => void) => void
) {
  let wanted = false
  let dirty = true
  let disposed = false
  let refreshing = true
  let currentItems: Item[] | null = null
  let current: AbortController | null = null

  const update = (items: Item[] | null, pending: boolean, failed: boolean): void => {
    currentItems = items
    refreshing = pending
    publish(items, pending, failed)
  }

  const createReader = () =>
    createResourceListingRefresh(
      async () => {
        const task = new AbortController()
        current = task
        if (currentItems !== null) update(null, true, false)
        const candidates = new Map<string, Item>()
        let published = false
        let paintQueued = false
        const publishCandidates = (): void => {
          paintQueued = false
          if (current === task) update([...candidates.values()], true, false)
        }
        try {
          const result = await read(task.signal, (batch) => {
            if (current !== task || !batch.length) return
            for (const item of batch) candidates.set(item.path, item)
            if (!published) {
              published = true
              publishCandidates()
            } else if (!paintQueued) {
              paintQueued = true
              schedulePaint(publishCandidates)
            }
          }).catch(() => null)
          if (result === null && current === task) update(null, true, false)
          return result
        } finally {
          if (current === task) current = null
        }
      },
      (result, pending) => {
        dirty = result === null
        update(result?.items ?? null, pending, dirty)
      },
      readDelta,
      { deltaWhileIdle: true }
    )
  let reader = createReader()

  const start = (): void => {
    if (disposed || !wanted || !dirty) return
    dirty = false
    if (!refreshing) update(currentItems, true, false)
    reader.request()
  }

  const closeReader = (): void => {
    reader.dispose()
    const previous = current
    current = null
    previous?.abort()
  }

  return {
    setWanted(value: boolean): void {
      wanted = value
      start()
    },
    invalidate(paths?: readonly string[]): void {
      if (disposed) return
      if (wanted && paths?.length) {
        if (dirty) start()
        else {
          if (!refreshing) update(currentItems, true, false)
          reader.request(paths)
        }
        return
      }
      if (dirty && refreshing) return
      closeReader()
      reader = createReader()
      dirty = true
      update(null, true, false)
      start()
    },
    dispose(): void {
      disposed = true
      closeReader()
    },
  }
}
