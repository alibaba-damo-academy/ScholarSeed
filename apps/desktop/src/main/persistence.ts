import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { RendererPreferences, PreferenceLanguage } from '../preferences.ts'
import type { PreferenceDiagnostics } from '../preference-diagnostics.ts'
import type { OfficeFontCache } from '../fonts.ts'
import { retainUncertainDirectoryOwnership } from './writer.ts'

export const PERSISTENCE_DIAGNOSTIC_PREFIX = '[persistence]'
export const PERSISTENCE_ERROR = {
  closed: 'ERR_PERSISTENCE_CLOSED',
  unavailable: 'ERR_PERSISTENCE_UNAVAILABLE',
} as const

export interface PersistenceOperations {
  log: {
    input: {
      path: string
      chunk: string
      maxBytes: number
      backups: number
      scope?: 'window' | 'backend'
      entries?: number
    }
    output: boolean
  }
  logEnd: { input: { path: string }; output: undefined }
  preferences: {
    input: {
      path: string
      language: PreferenceLanguage
      mode: 'read' | 'save' | 'automation'
      value?: unknown
      enabled?: boolean
      diagnostics: ReturnType<PreferenceDiagnostics['context']>
    }
    output: RendererPreferences
  }
  cache: {
    input: {
      directory: string
      namespace: string
      fingerprint: string
      mode: 'load' | 'save'
      value?: unknown
    }
    output: OfficeFontCache | null
  }
  close: { input: undefined; output: undefined }
}

export type PersistenceOperation = keyof PersistenceOperations
export interface PersistenceRequest<Kind extends PersistenceOperation = PersistenceOperation> {
  id: number
  kind: Kind
  input: PersistenceOperations[Kind]['input']
  submittedAt: number
  telemetryOnly?: boolean
}
export interface PersistenceReply {
  id: number
  value?: unknown
  error?: { code?: string; message: string }
  fatal?: boolean
  diagnostic?: string
  timing?: Record<string, unknown>
  finishedAt?: number
}

export interface PersistencePort {
  postMessage(message: PersistenceRequest): void
  on(event: 'message', listener: (message: PersistenceReply) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
}

export class PersistenceClient {
  private sequence = 0
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      diagnostic?: (line: string) => void
    }
  >()
  private failure: Error | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private exit: Promise<void>
  private exited!: () => void
  private exitFailed!: (error: Error) => void
  private closeAcknowledged = false
  private sink?: (line: string) => void

  constructor(
    private readonly port: PersistencePort,
    private readonly uncertain: (owner: unknown) => void = retainUncertainDirectoryOwnership
  ) {
    this.exit = new Promise((resolve, reject) => {
      this.exited = resolve
      this.exitFailed = reject
    })
    void this.exit.catch(() => undefined)
    port.on('message', (reply) => {
      if (reply.fatal) this.fail(new Error(PERSISTENCE_ERROR.unavailable))
      const job = this.pending.get(reply.id)
      if (!job) return
      if (reply.diagnostic !== undefined) {
        try {
          job.diagnostic?.(reply.diagnostic)
        } catch {}
        return
      }
      if (reply.timing) {
        try {
          this.sink?.(
            `${PERSISTENCE_DIAGNOSTIC_PREFIX} ${JSON.stringify({ ...reply.timing, deliveryMs: reply.finishedAt === undefined ? undefined : performance.now() - reply.finishedAt })}\n`
          )
        } catch {}
      }
      this.pending.delete(reply.id)
      if (reply.error)
        job.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }))
      else job.resolve(reply.value)
    })
    port.on('error', (error) => this.fail(error))
    port.on('exit', (code) => {
      if (code !== 0 || !this.closeAcknowledged || this.pending.size) {
        const error = new Error(PERSISTENCE_ERROR.unavailable)
        this.fail(error)
        this.exitFailed(error)
      } else this.exited()
    })
  }

  diagnostics(sink: (line: string) => void): void {
    this.sink = sink
  }

  request<Kind extends PersistenceOperation>(
    kind: Kind,
    input: PersistenceOperations[Kind]['input'],
    options: { telemetryOnly?: boolean; diagnostic?: (line: string) => void } = {}
  ): Promise<PersistenceOperations[Kind]['output']> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new Error(PERSISTENCE_ERROR.closed))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        diagnostic: options.diagnostic,
      })
      try {
        this.port.postMessage({
          id,
          kind,
          input,
          submittedAt: performance.now(),
          telemetryOnly: options.telemetryOnly,
        })
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(PERSISTENCE_ERROR.unavailable))
      }
    })
  }

  close(): Promise<void> {
    if (!this.closing) {
      const acknowledgement = this.request('close', undefined, { telemetryOnly: true })
      this.closed = true
      this.closing = acknowledgement.then(async () => {
        this.closeAcknowledged = true
        await this.exit
        if (this.failure) throw this.failure
      })
    }
    return this.closing
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.uncertain(this.port)
    for (const job of this.pending.values()) job.reject(error)
    this.pending.clear()
  }
}

let shared: PersistenceClient | undefined
export function desktopPersistence(): PersistenceClient {
  return (shared ??= new PersistenceClient(new Worker(join(__dirname, 'persistor.js'))))
}
export async function closeDesktopPersistence(): Promise<void> {
  await shared?.close()
}
