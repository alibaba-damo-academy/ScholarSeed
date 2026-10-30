import type { AttentionItem, AttentionSnapshot } from '../attention.ts'

export interface AttentionCursor {
  epoch: string
  revision: number
}

export interface AttentionDeliveryDependencies {
  persist(cursor: AttentionCursor): void
  foreground(): boolean
  show(item: AttentionItem): void
  reconcile(snapshot: AttentionSnapshot): void
  decision?(item: AttentionItem, decision: 'foreground' | 'submit'): void
}

export class AttentionDelivery {
  private cursor: AttentionCursor | null = null
  constructor(private readonly dependencies: AttentionDeliveryDependencies) {}

  accept(snapshot: AttentionSnapshot): void {
    const previous = this.cursor
    const baseline = !previous || previous.epoch !== snapshot.epoch
    if (!baseline && snapshot.revision < previous.revision) return
    const cursor = { epoch: snapshot.epoch, revision: snapshot.revision }
    this.dependencies.reconcile(snapshot)
    if (baseline || previous.revision !== snapshot.revision) this.dependencies.persist(cursor)
    this.cursor = cursor
    if (baseline) return
    for (const item of snapshot.items) {
      if (item.revision <= previous.revision) continue
      const foreground = this.dependencies.foreground()
      this.dependencies.decision?.(item, foreground ? 'foreground' : 'submit')
      if (!foreground) this.dependencies.show(item)
    }
  }

  reset(): void {
    this.cursor = null
  }
}
