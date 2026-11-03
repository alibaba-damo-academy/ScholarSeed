import type { PreferenceSubmission } from './preference-diagnostics.ts'

export const PREFERENCE_SHUTDOWN_CHANNEL = {
  request: 'scholarseed:preferences-shutdown',
  reply: 'scholarseed:preferences-shutdown-reply',
} as const
export const PREFERENCE_SHUTDOWN_TIMEOUT_MS = 15_000
export const PREFERENCE_SHUTDOWN_ERROR = {
  unsaved: 'ERR_PREFERENCES_UNSAVED',
  frozen: 'ERR_PREFERENCES_FROZEN',
  timeout: 'ERR_PREFERENCES_TIMEOUT',
  receipt: 'ERR_PREFERENCES_RECEIPT',
} as const
export type PreferenceShutdownMode = 'shutdown' | 'maintenance'
export type PreferenceShutdownRequest = {
  requestId: number
  mode: PreferenceShutdownMode
} | null
export interface PreferenceShutdownReply {
  requestId: number
  ok: boolean
  writerId?: string
  acknowledgedRevision?: number
}

export class PreferenceQuiescence {
  private sequence = 0
  private request: PreferenceShutdownRequest = null
  private registered = false
  private ready = false
  private waiting: Promise<void> | undefined
  private resolve: (() => void) | undefined
  private reject: ((error: Error) => void) | undefined
  private receipts = new Map<string, number>()
  private writes = new Set<Promise<unknown>>()

  constructor(private readonly publish: (request: PreferenceShutdownRequest) => void) {}

  register(): PreferenceShutdownRequest {
    this.registered = true
    return this.request
  }

  acknowledged(writerId: string): number {
    return this.receipts.get(writerId) ?? 0
  }

  isPreparing(): boolean {
    return this.request !== null && !this.ready
  }

  async save<Value>(
    submission: PreferenceSubmission | undefined,
    operation: () => Promise<Value>
  ): Promise<Value> {
    if (this.ready) throw new Error(PREFERENCE_SHUTDOWN_ERROR.frozen)
    const write = operation()
    this.writes.add(write)
    try {
      const result = await write
      if (submission) this.receipts.set(submission.writerId, submission.submittedRevision)
      return result
    } finally {
      this.writes.delete(write)
    }
  }

  prepare(
    timeoutMs = PREFERENCE_SHUTDOWN_TIMEOUT_MS,
    mode: PreferenceShutdownMode = 'shutdown'
  ): Promise<void> {
    if (this.waiting) {
      // A real exit may reuse the saved receipt, but must still block interaction.
      if (mode === 'shutdown' && this.request?.mode === 'maintenance') {
        this.request = { ...this.request, mode }
        this.publish(this.request)
      }
      return this.waiting
    }
    if (!this.registered && !this.writes.size) return Promise.resolve()
    this.request = { requestId: ++this.sequence, mode }
    this.waiting = new Promise<void>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    const deadline = setTimeout(
      () => this.reject?.(new Error(PREFERENCE_SHUTDOWN_ERROR.timeout)),
      timeoutMs
    )
    this.waiting = this.waiting.finally(() => clearTimeout(deadline))
    this.publish(this.request)
    return this.waiting
  }

  accept(value: unknown): boolean {
    if (!value || typeof value !== 'object' || this.request === null || this.ready) return false
    const reply = value as PreferenceShutdownReply
    if (reply.requestId !== this.request.requestId || typeof reply.ok !== 'boolean') return false
    if (!reply.ok) {
      this.reject?.(new Error(PREFERENCE_SHUTDOWN_ERROR.unsaved))
      return true
    }
    if (
      typeof reply.writerId !== 'string' ||
      !Number.isSafeInteger(reply.acknowledgedRevision) ||
      reply.acknowledgedRevision !== (this.receipts.get(reply.writerId) ?? 0) ||
      this.writes.size
    )
      return false
    this.ready = true
    this.resolve?.()
    return true
  }

  allowInteraction(): void {
    if (this.request?.mode !== 'shutdown') return
    this.request = { ...this.request, mode: 'maintenance' }
    this.publish(this.request)
  }

  resume(): void {
    this.request = null
    this.ready = false
    this.waiting = undefined
    this.resolve = undefined
    this.reject = undefined
    this.publish(null)
  }
}
