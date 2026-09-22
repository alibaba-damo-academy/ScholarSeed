import {
  rendererPreferencesEqual,
  sanitizeRendererPreferences,
  type RendererPreferences
} from './preferences.ts'

export interface PreferencePersistence {
  save: (value: RendererPreferences) => Promise<RendererPreferences>
  reconcile: () => Promise<RendererPreferences>
  apply: (value: RendererPreferences) => Promise<void>
  failed: () => void
}

/** Single writer for all renderer preferences. Pending patches never contain stale language projections. */
export class PreferenceWriter {
  private committed: RendererPreferences
  private pending: Partial<RendererPreferences> = {}
  private retryPatch: Partial<RendererPreferences> = {}
  private needsReconciliation = false
  private running: Promise<void> | undefined

  constructor(initial: RendererPreferences, private readonly port: PreferencePersistence) {
    this.committed = sanitizeRendererPreferences(initial, initial.language)
  }

  submit(patch: Partial<RendererPreferences>): Promise<void> {
    for (const key of Object.keys(patch) as (keyof RendererPreferences)[]) delete this.retryPatch[key]
    this.pending = { ...this.pending, ...patch }
    return this.start()
  }

  retry(): Promise<void> {
    this.pending = { ...this.retryPatch, ...this.pending }
    this.retryPatch = {}
    return this.start()
  }

  current(): RendererPreferences {
    return this.committed
  }

  private start(): Promise<void> {
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = undefined
        if (Object.keys(this.pending).length) void this.start()
      })
    }
    return this.running
  }

  private async drain(): Promise<void> {
    while (Object.keys(this.pending).length) {
      if (this.needsReconciliation) {
        try {
          const authoritative = await this.port.reconcile()
          await this.port.apply(authoritative)
          this.committed = authoritative
          this.needsReconciliation = false
        } catch {
          this.retryPatch = { ...this.retryPatch, ...this.pending }
          this.pending = {}
          this.port.failed()
          return
        }
      }
      const patch = this.pending
      for (const key of Object.keys(patch) as (keyof RendererPreferences)[]) delete this.retryPatch[key]
      this.pending = {}
      const desired = sanitizeRendererPreferences(
        { ...this.committed, ...patch },
        this.committed.language
      )
      if (rendererPreferencesEqual(desired, this.committed)) continue
      try {
        const saved = await this.port.save(desired)
        this.committed = saved
        await this.port.apply(saved)
        for (const key of Object.keys(patch) as (keyof RendererPreferences)[]) delete this.retryPatch[key]
      } catch {
        // Preserve the failed intent, but never spin on a failing disk or IPC.
        this.needsReconciliation = true
        this.retryPatch = { ...this.retryPatch, ...patch }
        try {
          const authoritative = await this.port.reconcile()
          this.committed = authoritative
          await this.port.apply(authoritative)
          this.needsReconciliation = false
        } catch {
          // Failed reconciliation is still a failed synchronization, not a successful read.
        }
        this.port.failed()
      }
    }
  }
}
