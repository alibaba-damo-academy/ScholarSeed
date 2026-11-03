import { reclaimCoordination, uncertainRelease, type ReclamationNative } from '../../native/reclamation.cjs'

/** Startup precedes our writers; ready also covers the first run after an update.
 * Active domains are skipped in both passes, including this process's own domains.
 */
export class CoordinationReclamation {
  private completed = new Set<'startup' | 'ready'>()

  constructor(
    private readonly native: ReclamationNative,
    private readonly directory: () => string,
    private readonly log: (line: string) => void
  ) {}

  run(reason: 'startup' | 'ready'): void {
    if (this.completed.has(reason)) return
    try {
      const result = reclaimCoordination(this.native, this.directory())
      this.log(`[coordination] reclaim reason=${reason} ${JSON.stringify(result)}\n`)
      this.completed.add(reason)
    } catch (error) {
      this.log(`[coordination] reclaim reason=${reason} failed: ${String(error)}\n`)
      // Ordinary cleanup errors do not invalidate an installed update. An
      // uncertain native release does invalidate further writer admission.
      if (uncertainRelease(error)) throw error
    }
  }
}
