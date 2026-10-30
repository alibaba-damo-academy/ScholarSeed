export const PREVIEW_CONTENT = {
  delayMs: 2_000,
  failureCode: 'preview_content_unavailable',
  cancelledCode: 'preview_content_cancelled',
  recoveryPath: '/__preview/content/recover',
  recoveryUnavailable: 'preview_content_recovery_unavailable',
  disposedCode: 'preview_content_disposed',
} as const

export type PreviewContentMode = 'delayed' | 'failed' | 'fail-once'
export interface PreviewContentTarget { readonly project: string; readonly identity: string }
type ReadOutcome = 'ready' | 'failed' | 'cancelled'

export class PreviewContentError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export class PreviewContent {
  private failed = false
  private recovered = false
  private disposed = false
  private readonly pending = new Set<() => void>()
  private readonly target: PreviewContentTarget
  private readonly mode: PreviewContentMode

  constructor(target: PreviewContentTarget, mode: PreviewContentMode) {
    this.target = { ...target }
    this.mode = mode
  }

  async read(target: PreviewContentTarget, signal?: AbortSignal): Promise<ReadOutcome> {
    if (this.disposed || signal?.aborted) return 'cancelled'
    if (target.project !== this.target.project || target.identity !== this.target.identity) return 'ready'
    if (this.mode === 'failed') return this.recovered ? 'ready' : 'failed'
    if (this.mode === 'fail-once') {
      if (this.failed) return 'ready'
      this.failed = true
      return 'failed'
    }
    const outcome = await new Promise<ReadOutcome>(resolve => {
      const finish = (outcome: ReadOutcome): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        resolve(outcome)
      }
      const cancel = (): void => finish('cancelled')
      const timer = setTimeout(() => finish('ready'), PREVIEW_CONTENT.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    return this.disposed || signal?.aborted ? 'cancelled' : outcome
  }

  recover(): void {
    if (this.disposed) throw new PreviewContentError(PREVIEW_CONTENT.disposedCode, 410)
    if (this.mode !== 'failed') throw new PreviewContentError(PREVIEW_CONTENT.recoveryUnavailable, 409)
    this.recovered = true
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }
}
