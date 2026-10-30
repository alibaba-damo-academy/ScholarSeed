import type { UpdateCheckResult } from '../updates.ts'

export interface UpdateCheckTiming {
  now: number
  periodicAt: number
  preparationAt?: number
  retryAt: number
}
export function nextUpdateCheckAt(timing: UpdateCheckTiming): number {
  const due =
    timing.preparationAt === undefined
      ? timing.periodicAt
      : Math.min(timing.periodicAt, timing.preparationAt)
  return Math.max(timing.now, timing.retryAt, due)
}

/** UI, wake and timer checks share a request; activation still checks explicitly. */
export class UpdateChecks {
  private revision = 0
  private pending: Promise<UpdateCheckResult> | null = null

  constructor(private readonly check: () => Promise<UpdateCheckResult>) {}

  invalidate(): void {
    this.revision += 1
    this.pending = null
  }

  isCurrent(result: UpdateCheckResult): boolean {
    return result.checkRevision === this.revision
  }

  run(): Promise<UpdateCheckResult> {
    if (!this.pending) {
      const revision = this.revision
      const pending = Promise.resolve()
        .then(this.check)
        .then((result) => ({ ...result, checkRevision: revision }))
        .finally(() => {
          if (this.pending === pending) this.pending = null
        })
      this.pending = pending
    }
    return this.pending
  }
}
