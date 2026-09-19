// logfile.ts — size-capped append log with gzipped numbered backups.
//
// The backend log is written for the whole lifetime of a desktop launch and, in a
// packaged app, carries the backend's debug-level console output. Plain append mode
// therefore grows without bound. Rotation follows the same scheme as the Python
// side's system log (damoagent/core/host/obs/log.py): cap the live file, keep a few
// gzipped generations, drop the oldest. Every filesystem failure is swallowed —
// diagnostics must never break a launch.

import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, WriteStream } from 'fs'
import { dirname } from 'path'
import { pipeline } from 'stream/promises'
import { createGzip } from 'zlib'

export const LOG_MAX_BYTES = 50 * 1024 * 1024
export const LOG_BACKUPS = 3
export const LOG_BACKUP_SUFFIX = '.gz'
const LOG_COMPRESSING_SUFFIX = '.compressing'

export interface RotatingLogOptions {
  maxBytes?: number
  backups?: number
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
  private stream: WriteStream | null = null
  private size = 0
  // Archiving is serialized: a generation shift must not race the compression of
  // the generation before it, or two rotations would collapse into one file.
  private archiving: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly options: RotatingLogOptions = {}
  ) {
    this.size = fileSize(path)
    this.open()
  }

  get maxBytes(): number {
    return this.options.maxBytes ?? LOG_MAX_BYTES
  }

  get backups(): number {
    return this.options.backups ?? LOG_BACKUPS
  }

  write(chunk: string): void {
    const bytes = Buffer.byteLength(chunk)
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate()
    try {
      this.stream?.write(chunk)
      this.size += bytes
    } catch {
      /* best-effort */
    }
  }

  end(): void {
    try {
      this.stream?.end()
    } catch {
      /* best-effort */
    }
    this.stream = null
  }

  private open(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // The descriptor is opened synchronously so the file exists before a later
      // rotation renames it, and so already-buffered bytes follow the inode this
      // stream owns rather than landing in a freshly recreated live file.
      const fd = openSync(this.path, 'a')
      this.stream = createWriteStream(this.path, { fd, autoClose: true })
    } catch {
      this.stream = null
    }
  }

  // A generation is normally `<log>.<n>.gz`; the uncompressed `<log>.<n>` exists only
  // when its compression failed. Both are shifted so the count stays bounded.
  private generation(index: number): [string, string] {
    return [`${this.path}.${index}${LOG_BACKUP_SUFFIX}`, `${this.path}.${index}`]
  }

  private rotate(): void {
    this.end()
    // Renaming the live file aside is synchronous so writes resume immediately;
    // compressing 50MB inline would freeze the Electron main process — and the whole
    // UI with it — for about a second.
    let pending = ''
    try {
      pending = `${this.path}.rotating-${++pendingSequence}`
      renameSync(this.path, pending)
    } catch {
      pending = ''
    }
    this.size = fileSize(this.path)
    this.open()
    if (pending) this.archiving = this.archiving.then(() => this.archive(pending))
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
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}`
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
