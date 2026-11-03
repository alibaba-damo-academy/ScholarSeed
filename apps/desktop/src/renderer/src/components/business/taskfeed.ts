import type { TaskSourceContribution } from '../../contracts/features.ts'
import { isActiveProductTask, type ProductTask } from '../../contracts/tasks.ts'

interface TaskWatcher {
  connected: boolean
  stop: () => void
}

export class TaskFeed {
  private tasks = new Map<string, ProductTask>()
  private initialized = new Set<string>()
  private watchers = new Map<string, TaskWatcher>()
  private unsubscribers: Array<() => void> = []
  private generation = 0
  private active = false
  private refreshing: Promise<void> | null = null

  constructor(
    private sources: readonly TaskSourceContribution[],
    private changed: (tasks: ProductTask[]) => void,
    private announce: (task: ProductTask) => void
  ) {}

  start(): void {
    this.active = true
    const generation = ++this.generation
    this.unsubscribers = this.sources.flatMap((source) =>
      source.subscribe
        ? [
            source.subscribe((task) => {
              if (generation === this.generation) this.accept(task, true)
            }),
          ]
        : []
    )
    for (const task of this.tasks.values()) this.watch(task)
    void this.refresh()
  }

  stop(): void {
    this.active = false
    this.generation += 1
    this.refreshing = null
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers = []
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
  }

  needsRefresh(): boolean {
    return (
      this.sources.some((source) => !this.initialized.has(source.id)) ||
      [...this.tasks.entries()].some(
        ([key, task]) => isActiveProductTask(task) && !this.watchers.get(key)?.connected
      )
    )
  }

  accept(task: ProductTask, live: boolean): void {
    if (!this.active) return
    const key = `${task.sourceId}:${task.id}`
    const previous = this.tasks.get(key)
    if (previous && task.eventSeq <= previous.eventSeq) return
    this.tasks.set(key, task)
    this.changed([...this.tasks.values()].sort((left, right) => right.updatedAt - left.updatedAt))
    this.watch(task)
    if (isActiveProductTask(task)) return
    try {
      this.sources.find((source) => source.id === task.sourceId)?.onTerminal?.(task)
    } catch (error) {
      console.error('Task projection invalidation failed', error)
    }
    if (previous?.status !== task.status && (live || (previous && isActiveProductTask(previous))))
      this.announce(task)
  }

  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve()
    if (this.refreshing) return this.refreshing
    const generation = this.generation
    const operation = Promise.allSettled(
      this.sources.map(async (source) => {
        const snapshots = await source.list()
        if (!this.active || generation !== this.generation) return
        const live = this.initialized.has(source.id)
        for (const task of snapshots) this.accept(task, live)
        this.initialized.add(source.id)
      })
    ).then(() => undefined)
    this.refreshing = operation
    void operation.then(() => {
      if (this.refreshing === operation) this.refreshing = null
    })
    return operation
  }

  async mutate(task: ProductTask, action: 'cancel' | 'retry'): Promise<void> {
    const source = this.sources.find((candidate) => candidate.id === task.sourceId)
    if (!source || !this.active) return
    const generation = this.generation
    const updated = await source[action](task.id)
    if (generation === this.generation) this.accept(updated, true)
  }

  private watch(task: ProductTask): void {
    const key = `${task.sourceId}:${task.id}`
    const current = this.watchers.get(key)
    if (!isActiveProductTask(task)) {
      this.watchers.delete(key)
      current?.stop()
      return
    }
    if (current) return
    const source = this.sources.find((candidate) => candidate.id === task.sourceId)
    if (!source?.watch) return
    const watcher: TaskWatcher = { connected: false, stop: () => undefined }
    this.watchers.set(key, watcher)
    watcher.stop = source.watch(task, {
      onTask: (updated) => {
        if (this.watchers.get(key) === watcher) this.accept(updated, true)
      },
      onConnectionChange: (connected) => {
        if (this.watchers.get(key) === watcher) watcher.connected = connected
      },
    })
    if (this.watchers.get(key) !== watcher) watcher.stop()
  }
}
