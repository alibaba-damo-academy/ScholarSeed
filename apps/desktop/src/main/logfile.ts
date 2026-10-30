// logfile.ts — size-capped append log with gzipped numbered backups.
//
// The backend log is written for the whole lifetime of a desktop launch and, in a
// packaged app, carries the backend's debug-level console output. Plain append mode
// therefore grows without bound. Rotation follows the same scheme as the Python
// side's system log (damoagent/core/host/obs/log.py): cap the live file, keep a few
// gzipped generations, drop the oldest. Every filesystem failure is swallowed —
// diagnostics must never break a launch.

import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs'
import { dirname } from 'path'
import { pipeline } from 'stream/promises'
import { createGzip } from 'zlib'
import type { DirectoryWriter } from './writer'
import { PREFERENCE_DIAGNOSTIC_PREFIX } from '../preference-diagnostics.ts'
import { LOGIN_DIAGNOSTIC_PREFIX } from '../authentication.ts'
import { NAVIGATION_DIAGNOSTIC_PREFIX } from '../navigation.ts'
import { API_DIAGNOSTIC_PREFIX } from '../requests.ts'

export const LOG_MAX_BYTES = 50 * 1024 * 1024
export const LOG_BACKUPS = 3
export const LOG_BACKUP_SUFFIX = '.gz'
const LOG_BUFFER_MAX_CHUNKS = 4096
const LOG_COMPRESSING_SUFFIX = '.compressing'
const RENDERER_DIAGNOSTIC_PREFIXES = [
  LOGIN_DIAGNOSTIC_PREFIX,
  PREFERENCE_DIAGNOSTIC_PREFIX,
  NAVIGATION_DIAGNOSTIC_PREFIX,
  '[office-runtime]',
  '[session-stream]',
  '[session-recovery]',
  '[notification]',
  '[account-menu]',
  API_DIAGNOSTIC_PREFIX,
]

export function isRendererDiagnostic(message: string): boolean {
  return RENDERER_DIAGNOSTIC_PREFIXES.some((prefix) => message.startsWith(prefix))
}

export interface RotatingLogOptions {
  maxBytes?: number
  backups?: number
  acquireWriter?: () => DirectoryWriter
  /** Caller resumes after its competing startup writer is ready or drained. */
  deferred?: boolean
}

let pendingSequence = 0

function fileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

export class RotatingFileLog {
  private size = 0
  private archiving: Promise<void> = Promise.resolve()
  private ending: Promise<void> | null = null
  private deferred: boolean
  private buffered: string[] = []
  private bufferedBytes = 0
  private droppedBytes = 0

  constructor(
    private readonly path: string,
    private readonly options: RotatingLogOptions = {}
  ) {
    this.deferred = options.deferred === true
    this.size = fileSize(path)
  }

  get maxBytes(): number {
    return this.options.maxBytes ?? LOG_MAX_BYTES
  }

  get backups(): number {
    return this.options.backups ?? LOG_BACKUPS
  }

  write(chunk: string): void {
    if (this.ending) return
    if (this.deferred) {
      this.buffered.push(chunk)
      this.bufferedBytes += Buffer.byteLength(chunk)
      while (this.bufferedBytes > this.maxBytes || this.buffered.length > LOG_BUFFER_MAX_CHUNKS) {
        const removed = this.buffered.shift()!
        const bytes = Buffer.byteLength(removed)
        this.bufferedBytes -= bytes
        this.droppedBytes += bytes
      }
      return
    }
    let writer: DirectoryWriter | undefined
    let pending = ''
    try {
      // A log is idle between appends. Holding a child directory for the whole
      // application lifetime would prevent Serve's authorized home maintenance.
      writer = this.options.acquireWriter?.()
      mkdirSync(dirname(this.path), { recursive: true })
      this.size = fileSize(this.path)
      const bytes = Buffer.byteLength(chunk)
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        const candidate = `${this.path}.rotating-${++pendingSequence}`
        renameSync(this.path, candidate)
        pending = candidate
        this.size = 0
      }
      // Complete this incoming chunk before releasing activity. No idle
      // writable descriptor can later point outside a requalified namespace.
      appendFileSync(this.path, chunk)
      this.size += bytes
    } catch {
      // A busy maintenance owner causes this best-effort write to be skipped;
      // later writes acquire again instead of permanently disabling the logger.
    } finally {
      if (pending) {
        // Transfer this operation's qualification through queued compression
        // and final rename/removal. It is released only after all IO completes.
        const retained = writer
        this.archiving = this.archiving
          .then(() => this.archive(pending))
          .finally(() => {
            try {
              retained?.close()
            } catch {
              /* native owner retains uncertainty */
            }
          })
      } else {
        try {
          writer?.close()
        } catch {
          /* native owner retains uncertainty */
        }
      }
    }
  }

  /** Replays stamped lines without holding any qualification while deferred. */
  resume(): void {
    if (!this.deferred) return
    this.deferred = false
    const chunks = this.buffered
    const dropped = this.droppedBytes
    this.buffered = []
    this.bufferedBytes = 0
    this.droppedBytes = 0
    if (dropped)
      this.write(`[log] deferred diagnostics capacity exceeded: ${dropped} bytes omitted\n`)
    if (chunks.length) this.write(chunks.join(''))
  }

  async flush(): Promise<void> {
    await this.archiving
  }

  end(): Promise<void> {
    if (!this.ending) {
      this.resume()
      this.ending = this.archiving
    }
    return this.ending
  }

  private generation(index: number): [string, string] {
    return [`${this.path}.${index}${LOG_BACKUP_SUFFIX}`, `${this.path}.${index}`]
  }

  private async archive(pending: string): Promise<void> {
    const [target, fallback] = this.generation(1)
    const compressed = `${pending}${LOG_COMPRESSING_SUFFIX}`
    try {
      for (const oldest of this.generation(this.backups)) rmSync(oldest, { force: true })
      for (let index = this.backups - 1; index >= 1; index--) {
        const current = this.generation(index)
        const next = this.generation(index + 1)
        for (let variant = 0; variant < current.length; variant++) {
          if (existsSync(current[variant])) renameSync(current[variant], next[variant])
        }
      }
      await pipeline(createReadStream(pending), createGzip(), createWriteStream(compressed))
      renameSync(compressed, target)
      rmSync(pending, { force: true })
    } catch {
      // A full disk is the realistic failure. Keeping the generation uncompressed
      // costs nothing — it is already renamed aside — and keeps the count bounded.
      try {
        rmSync(target, { force: true })
        rmSync(compressed, { force: true })
        renameSync(pending, fallback)
      } catch {
        /* best-effort */
      }
    }
  }
}

function formatTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  )
}

// A captured child-process stream is not line-aligned: one chunk may hold a partial
// line or several whole lines. To stamp every line exactly once we buffer across
// chunks and emit on newline boundaries; `flush` releases the trailing partial line
// when the stream ends.
export class LineTimestamper {
  private buffer = ''

  constructor(
    private readonly emit: (line: string) => void,
    private readonly now: () => Date = () => new Date()
  ) {}

  push(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.emit(this.stamp(line))
      newline = this.buffer.indexOf('\n')
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return
    const line = this.buffer
    this.buffer = ''
    this.emit(this.stamp(line))
  }

  private stamp(line: string): string {
    const timestamp = formatTimestamp(this.now())
    return line.length > 0 ? `${timestamp} ${line}\n` : `${timestamp}\n`
  }
}
