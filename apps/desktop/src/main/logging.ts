import { LOG_MAX_BYTES, LOG_BACKUPS, LOG_BUFFER_MAX_CHUNKS } from './logfile.ts'
import { desktopPersistence, type PersistenceClient } from './persistence.ts'

export class AsyncFileLog {
  private buffered: { chunk: string; resolve(value: boolean): void; telemetry: boolean }[] = []
  private bytes = 0
  private omitted = 0
  private running: Promise<void> | undefined
  private ending: Promise<void> | undefined
  private deferred: boolean
  private failure: unknown

  constructor(
    private readonly path: string,
    private readonly options: {
      maxBytes?: number
      backups?: number
      deferred?: boolean
      scope?: 'window' | 'backend'
    } = {},
    private readonly persistence: PersistenceClient = desktopPersistence()
  ) {
    this.deferred = options.deferred === true
  }

  write(chunk: string, telemetry = false): Promise<boolean> {
    if (this.ending || this.failure) return Promise.resolve(false)
    const acknowledgement = new Promise<boolean>((resolve) => {
      this.buffered.push({ chunk, resolve, telemetry })
    })
    this.bytes += Buffer.byteLength(chunk)
    while (
      this.bytes > (this.options.maxBytes ?? LOG_MAX_BYTES) ||
      this.buffered.length > LOG_BUFFER_MAX_CHUNKS
    ) {
      const removed = this.buffered.shift()!
      const bytes = Buffer.byteLength(removed.chunk)
      this.bytes -= bytes
      this.omitted += bytes
      removed.resolve(false)
    }
    this.schedule()
    return acknowledgement
  }

  resume(): void {
    this.deferred = false
    this.schedule()
  }

  async flush(): Promise<void> {
    if (this.failure) throw this.failure
    this.schedule()
    while (this.running) await this.running
  }

  end(): Promise<void> {
    if (!this.ending) {
      this.resume()
      this.ending = this.flush().then(() =>
        this.persistence.request('logEnd', { path: this.path }, { telemetryOnly: true })
      )
    }
    return this.ending
  }

  private schedule(): void {
    if (this.deferred || this.running || (!this.buffered.length && !this.omitted)) return
    this.running = Promise.resolve()
      .then(async () => {
        while (this.buffered.length || this.omitted) {
          const batch = this.buffered.splice(0)
          const omitted = this.omitted
          this.bytes = this.omitted = 0
          const chunk =
            (omitted ? `[log] diagnostics capacity exceeded: ${omitted} bytes omitted\n` : '') +
            batch.map((entry) => entry.chunk).join('')
          let accepted = false
          try {
            accepted = await this.persistence.request(
              'log',
              {
                path: this.path,
                chunk,
                maxBytes: this.options.maxBytes ?? LOG_MAX_BYTES,
                backups: this.options.backups ?? LOG_BACKUPS,
                scope: this.options.scope,
                entries: batch.length,
              },
              { telemetryOnly: batch.every((entry) => entry.telemetry) }
            )
          } finally {
            for (const entry of batch) entry.resolve(accepted)
          }
        }
      })
      .catch((error) => {
        this.failure = error
        for (const entry of this.buffered.splice(0)) entry.resolve(false)
        this.bytes = this.omitted = 0
        throw error
      })
      .finally(() => {
        this.running = undefined
        this.schedule()
      })
    void this.running.catch(() => undefined)
  }
}
