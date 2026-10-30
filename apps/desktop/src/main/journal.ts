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

export function writeJson(path: string, value: unknown): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('A JSON record must have a serializable value')
  writeRecord(path, `${serialized}\n`)
}

/** Publish exact saved bytes with the same durability and temporary-file ownership. */
export function writeRecord(path: string, bytes: string | Uint8Array): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  let created = false
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    created = true
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    const file = descriptor
    descriptor = undefined
    closeSync(file)
    renameSync(temporary, path)
    created = false
    // Windows cannot open a directory through this API. The file is flushed on
    // both platforms; macOS also flushes the rename's directory entry.
    if (process.platform !== 'win32') {
      descriptor = openSync(directory, 'r')
      fsyncSync(descriptor)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (created) rmSync(temporary, { force: true })
  }
}
