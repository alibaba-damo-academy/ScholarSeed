/** Readiness belongs to one document and one live backend, never to the process.
 * This gate is an observation only; native activation must separately consume
 * its authenticated, attempt-bound challenge before committing Current.
 */
export class WorkbenchHealth {
  private document = this.newDocument()
  private confirmed: object | null = null
  private pending: { backend: object; document: object; result: Promise<boolean> } | null = null

  private newDocument() {
    let cancel!: () => void
    const cancelled = new Promise<false>((resolve) => {
      cancel = () => resolve(false)
    })
    return { cancelled, cancel, confirmations: new Set<() => void>() }
  }

  invalidate(): void {
    this.document.cancel()
    this.document = this.newDocument()
    this.confirmed = null
    this.pending = null
  }

  confirmedFor(backend: object | null): boolean {
    return backend !== null && this.confirmed === backend
  }

  /** Initialization writes may arrive before the renderer's painted-workbench receipt.
   * Observe that receipt; never manufacture one or carry a write across documents.
   */
  async waitForConfirmation(
    backend: { exited: Promise<unknown> },
    isCurrent: () => boolean
  ): Promise<boolean> {
    const document = this.document
    if (this.confirmedFor(backend)) return isCurrent()
    let observe!: () => void
    const confirmed = new Promise<boolean>((resolve) => {
      observe = () => {
        if (this.confirmedFor(backend)) resolve(true)
      }
      document.confirmations.add(observe)
    })
    let timer!: ReturnType<typeof setTimeout>
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 60_000)
    })
    try {
      const accepted = await Promise.race([
        confirmed,
        document.cancelled,
        backend.exited.then(
          () => false,
          () => false
        ),
        expired,
      ])
      return !!accepted && document === this.document && this.confirmedFor(backend) && isCurrent()
    } finally {
      clearTimeout(timer)
      document.confirmations.delete(observe)
    }
  }

  async confirm(
    backend: { ready: Promise<boolean>; exited: Promise<unknown> },
    isCurrent: () => boolean,
    commit: (stillCurrent: () => boolean) => void | Promise<void>
  ): Promise<boolean> {
    const document = this.document
    if (!isCurrent()) return false
    const ready = await Promise.race([
      backend.ready.catch(() => false),
      backend.exited.then(
        () => false,
        () => false
      ),
      document.cancelled,
    ])
    if (!ready || document !== this.document || !isCurrent()) return false
    if (this.confirmed === backend) return true
    if (this.pending?.backend === backend && this.pending.document === document)
      return this.pending.result
    // A single transport exchange owns this document/backend observation.
    // Recheck after async challenge and acknowledgement; navigation never
    // inherits a completed observation from an earlier document.
    const stillCurrent = () => document === this.document && isCurrent()
    const result = Promise.resolve().then(async () => {
      if (!stillCurrent()) return false
      await commit(stillCurrent)
      if (!stillCurrent()) return false
      this.confirmed = backend
      for (const observe of document.confirmations) observe()
      return true
    })
    const pending = { backend, document, result }
    this.pending = pending
    try {
      return await result
    } finally {
      if (this.pending === pending) this.pending = null
    }
  }
}
