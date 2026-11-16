export interface DraftReceipt {
  state: Record<string, unknown>
  revision: number
}

type DraftWriter = (state: Record<string, unknown>, revision: number) => Promise<DraftReceipt>

export class DraftBuffer {
  private saved: DraftReceipt
  private input: Record<string, unknown> | undefined
  private version = 0
  private queued = 0
  private tail = Promise.resolve()
  private listeners = new Set<() => void>()
  failed = false

  constructor(snapshot: DraftReceipt) { this.saved = snapshot }
  get state(): Record<string, unknown> { return this.input ?? this.saved.state }
  get revision(): number { return this.saved.revision }
  get retained(): boolean { return this.input !== undefined || this.listeners.size > 0 }
  async idle(): Promise<void> { await this.tail }

  rebase(snapshot: DraftReceipt, terminal = false): void {
    if (this.queued || snapshot.revision < this.saved.revision) return
    this.saved = snapshot
    if (terminal) { this.input = undefined; this.failed = false }
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void { for (const listener of this.listeners) listener() }

  save(values: Record<string, unknown>, write: DraftWriter, recover: () => Promise<DraftReceipt>): Promise<DraftReceipt> {
    const state = structuredClone(values)
    const version = ++this.version
    this.queued += 1
    this.input = state
    this.emit()
    const operation = this.tail.then(async () => {
      try {
        let receipt: DraftReceipt
        try { receipt = await write(state, this.saved.revision) }
        catch (failure) {
          const snapshot = await recover()
          this.saved = snapshot
          if (JSON.stringify(snapshot.state) !== JSON.stringify(state)) throw failure
          receipt = snapshot
        }
        this.saved = receipt
        if (version === this.version) this.input = undefined
        this.failed = false
        this.emit()
        return receipt
      } catch (failure) {
        this.failed = true
        this.emit()
        throw failure
      }
    }).finally(() => { this.queued -= 1 })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

const buffers = new Map<string, DraftBuffer>()

export async function waitForDraft(key: string): Promise<void> { await buffers.get(key)?.idle() }

export function retainDraft(key: string, snapshot: DraftReceipt, terminal = false): DraftBuffer {
  const existing = buffers.get(key)
  if (existing) { existing.rebase(snapshot, terminal); return existing }
  const buffer = new DraftBuffer(snapshot)
  buffers.set(key, buffer)
  return buffer
}

export async function releaseDraft(key: string, buffer: DraftBuffer): Promise<void> {
  await buffer.idle()
  if (!buffer.retained && buffers.get(key) === buffer) buffers.delete(key)
}
