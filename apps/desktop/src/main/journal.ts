// Small JSON records are replaced atomically; partial JSON is never published.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export interface QualifiedRecordConsumer {
  consume(path: string, expected: Buffer, device: string, inode: string): void
}

const RECORD_WRITE_OPERATION = {
  mkdir: 'mkdir',
  openTemporary: 'open-temporary',
  writeTemporary: 'write-temporary',
  syncTemporary: 'sync-temporary',
  closeTemporary: 'close-temporary',
  rename: 'rename',
  openDirectory: 'open-directory',
  syncDirectory: 'sync-directory',
  cleanupClose: 'cleanup-close',
  cleanupRemove: 'cleanup-remove',
  complete: 'complete',
} as const

export interface RecordWriteEvent {
  operation: (typeof RECORD_WRITE_OPERATION)[keyof typeof RECORD_WRITE_OPERATION]
  result: 'failed' | 'completed'
  elapsedMs: number
  published: boolean
  error?: unknown
}

export type RecordWriteObserver = (event: RecordWriteEvent) => void

/** Read one stable regular-file record without an unbounded allocation. */
export function readRecord(path: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid record limit')
  const descriptor = openSync(path, 'r')
  try {
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.size > maxBytes) throw new Error('Invalid or oversized record')
    const bytes = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(descriptor)
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Record changed during read')
    return bytes.subarray(0, length)
  } finally {
    closeSync(descriptor)
  }
}

export function writeJson(path: string, value: unknown, observe?: RecordWriteObserver): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('A JSON record must have a serializable value')
  writeRecord(path, `${serialized}\n`, observe)
}

/** Publish exact saved bytes with the same durability and temporary-file ownership. */
export function writeRecord(
  path: string,
  bytes: string | Uint8Array,
  observe?: RecordWriteObserver
): void {
  const started = observe ? performance.now() : 0
  let published = false
  const report = (
    operation: RecordWriteEvent['operation'],
    result: RecordWriteEvent['result'],
    error?: unknown
  ): void => {
    if (!observe) return
    try {
      observe({ operation, result, elapsedMs: performance.now() - started, published, error })
    } catch {
      return
    }
  }
  const run = <Value>(operation: RecordWriteEvent['operation'], action: () => Value): Value => {
    if (!observe) return action()
    try {
      return action()
    } catch (error) {
      report(operation, 'failed', error)
      throw error
    }
  }
  const directory = dirname(path)
  run(RECORD_WRITE_OPERATION.mkdir, () => mkdirSync(directory, { recursive: true }))
  const temporary = `${path}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  let created = false
  try {
    descriptor = run(RECORD_WRITE_OPERATION.openTemporary, () => openSync(temporary, 'wx', 0o600))
    created = true
    const file = descriptor
    run(RECORD_WRITE_OPERATION.writeTemporary, () => writeFileSync(file, bytes))
    run(RECORD_WRITE_OPERATION.syncTemporary, () => fsyncSync(file))
    descriptor = undefined
    run(RECORD_WRITE_OPERATION.closeTemporary, () => closeSync(file))
    run(RECORD_WRITE_OPERATION.rename, () => renameSync(temporary, path))
    published = true
    created = false
    // Windows cannot open a directory through this API. The file is flushed on
    // both platforms; macOS also flushes the rename's directory entry.
    if (process.platform !== 'win32') {
      descriptor = run(RECORD_WRITE_OPERATION.openDirectory, () => openSync(directory, 'r'))
      const directoryDescriptor = descriptor
      run(RECORD_WRITE_OPERATION.syncDirectory, () => fsyncSync(directoryDescriptor))
    }
  } finally {
    if (descriptor !== undefined) {
      const remainingDescriptor = descriptor
      run(RECORD_WRITE_OPERATION.cleanupClose, () => closeSync(remainingDescriptor))
    }
    if (created) run(RECORD_WRITE_OPERATION.cleanupRemove, () => rmSync(temporary, { force: true }))
  }
  report(RECORD_WRITE_OPERATION.complete, 'completed')
}
