import type { CsvState } from './model.ts'
import { CsvQueue, type CsvCommand, type CsvRequest, type CsvResponse } from './protocol.ts'

/** Renderer creates once per source revision/epoch and closes on unmount. */
export class CsvClient {
  private readonly worker: Worker
  private readonly pending = new Map<
    number,
    { resolve: (response: CsvResponse) => void; reject: (error: Error) => void }
  >()
  private readonly queue: CsvQueue
  private version = 0
  private closed = false
  constructor(
    readonly identity: string,
    receiveState?: (state: CsvState) => void
  ) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.queue = new CsvQueue(identity, (message) => this.send(message))
    this.worker.onmessage = (event: MessageEvent<CsvResponse>) => {
      const response = event.data,
        pending = this.pending.get(response.requestId)
      if (!pending) return
      this.pending.delete(response.requestId)
      if (response.identity !== this.identity) {
        pending.reject(new Error('csv_identity_stale'))
        return
      }
      if (!response.ok) {
        pending.reject(new Error(response.error ?? 'csv_request_failed'))
        return
      }
      this.version = Math.max(this.version, response.version)
      const state = response.value as CsvState | undefined
      if (state && typeof state.dirty === 'boolean' && typeof state.rowCount === 'number')
        receiveState?.(state)
      pending.resolve(response)
    }
    this.worker.onerror = () => this.stop(new Error('csv_worker_failed'))
    this.worker.onmessageerror = () => this.stop(new Error('csv_worker_message_invalid'))
  }
  get currentVersion(): number {
    return this.version
  }
  request(command: CsvCommand, expectedVersion?: number): Promise<CsvResponse> {
    if (this.closed) return Promise.reject(new Error('csv_client_closed'))
    return this.queue.request(command, expectedVersion)
  }
  private send(message: CsvRequest): Promise<CsvResponse> {
    const requestId = message.requestId
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      try {
        this.worker.postMessage(message)
      } catch (error) {
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error('csv_worker_failed'))
      }
    })
  }
  /** New window generation and returned version must also match current viewport before render. */
  current(response: CsvResponse): boolean {
    return !this.closed && response.identity === this.identity && response.version === this.version
  }
  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
  private stop(error: Error): void {
    this.closed = true
    this.queue.dispose()
    this.worker.terminate()
    this.fail(error)
  }
  dispose(): void {
    this.stop(new Error('csv_client_closed'))
  }
}
