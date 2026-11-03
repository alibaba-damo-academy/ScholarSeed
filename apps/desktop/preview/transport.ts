import { PREVIEW_CONVERSATION } from './conversation.ts'
import type { PreviewConversationPolicy } from './conversation.ts'

const CLOSED = Object.freeze({ code: 'preview_transport_disposed', status: 410 })

export class PreviewTransportError extends Error {
  readonly code = CLOSED.code
  readonly status = CLOSED.status

  constructor() {
    super(CLOSED.code)
  }
}

export class PreviewTransport {
  private readonly policy: Readonly<PreviewConversationPolicy>
  private deltas = 0
  private faulted = false
  private ready = false
  private disposed = false
  private timer?: ReturnType<typeof setTimeout>
  private readonly pending = new Set<(error?: PreviewTransportError) => void>()

  constructor(policy: PreviewConversationPolicy) {
    this.policy = { ...policy }
  }

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewTransportError()
  }

  observeDelta(hasSubscribers: boolean): boolean {
    this.active()
    if (this.faulted) return false
    const threshold = this.policy.disconnectAfterDeltas
    if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold <= 0) return false
    this.deltas = Math.min(this.deltas + 1, threshold)
    if (!hasSubscribers || this.deltas < threshold) return false
    this.faulted = true
    return true
  }

  async wait(signal?: AbortSignal): Promise<void> {
    this.active(signal)
    if (!this.faulted || this.ready) return
    const configured = this.policy.reconnectDelayMs ?? PREVIEW_CONVERSATION.reconnectDelayMs
    const delay = Number.isFinite(configured) && configured >= 0
      ? Math.min(configured, PREVIEW_CONVERSATION.reconnectDelayMs)
      : PREVIEW_CONVERSATION.reconnectDelayMs
    if (delay === 0) {
      this.ready = true
      return
    }
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: PreviewTransportError): void => {
        this.pending.delete(settle)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = (): void => settle(new PreviewTransportError())
      this.pending.add(settle)
      signal?.addEventListener('abort', abort, { once: true })
      if (this.timer === undefined) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          this.ready = true
          for (const finish of this.pending) finish()
        }, delay)
      }
    })
    this.active(signal)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const finish of this.pending) finish(new PreviewTransportError())
  }
}
