import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const DEFAULT_COPY_NAME = 'artifact-copy'
const MAX_COPY_NAME_LENGTH = 180
const COPY_BUFFER_BYTES = 1024 * 1024
const INVALID_SOURCE = 'save_copy_source_unavailable'
const ORIGINAL_TARGET = 'save_copy_target_is_original'
export const SAVE_COPY_SENDER_ERROR = 'save_copy_sender_invalid'

export interface SaveCopyRequest {
  suggestedName: string
  bytes: Uint8Array
}

export interface PreparedSaveCopy {
  suggestedName: string
  bytes: Uint8Array
}

export interface SaveCopyResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

export type SaveCopyPicker = (suggestedName: string) => Promise<string | null>
export type SaveCopyWriter = (path: string, bytes: Uint8Array) => Promise<void>

function safeName(value: unknown): string {
  const raw = typeof value === 'string' ? value.replaceAll('\0', '').trim() : ''
  const leaf = raw.split(/[\\/]/).filter(Boolean).pop() || DEFAULT_COPY_NAME
  if (leaf === '.' || leaf === '..') return DEFAULT_COPY_NAME
  return leaf.slice(0, MAX_COPY_NAME_LENGTH) || DEFAULT_COPY_NAME
}

/** Validate the renderer IPC payload before opening a native save dialog. */
export function prepareSaveCopy(value: unknown): PreparedSaveCopy | null {
  if (!value || typeof value !== 'object') return null
  const request = value as { suggestedName?: unknown; bytes?: unknown }
  if (!ArrayBuffer.isView(request.bytes)) return null
  const view = request.bytes as ArrayBufferView
  return {
    suggestedName: safeName(request.suggestedName),
    bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
  }
}

/** Execute the save transaction; only a path explicitly returned by the native picker is written. */
export async function saveFileCopy(
  value: unknown,
  pick: SaveCopyPicker,
  write: SaveCopyWriter
): Promise<SaveCopyResult> {
  const request = prepareSaveCopy(value)
  if (!request) return { ok: false, error: 'invalid save-copy payload' }
  try {
    const path = await pick(request.suggestedName)
    if (!path) return { ok: false, canceled: true }
    await write(path, request.bytes)
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function savePathCopy(
  value: unknown,
  pick: SaveCopyPicker,
  authorize: (path: string) => string | null
): Promise<SaveCopyResult> {
  if (!value || typeof value !== 'object') return { ok: false, error: INVALID_SOURCE }
  const request = value as { sourcePath?: unknown; suggestedName?: unknown }
  if (typeof request.sourcePath !== 'string') return { ok: false, error: INVALID_SOURCE }
  let staging: string | undefined
  try {
    const source = authorize(request.sourcePath)
    if (!source) throw new Error(INVALID_SOURCE)
    const selected = await pick(safeName(request.suggestedName))
    if (!selected) return { ok: false, canceled: true }
    if (authorize(request.sourcePath) !== source) throw new Error(INVALID_SOURCE)
    const destination = join(await realpath(dirname(selected)), basename(selected))
    const before = await lstat(source)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(INVALID_SOURCE)
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (destination === source || (existing?.dev === before.dev && existing?.ino === before.ino))
      throw new Error(ORIGINAL_TARGET)
    const input = await open(source, 'r')
    try {
      const opened = await input.stat()
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        (await realpath(source)) !== source
      )
        throw new Error(INVALID_SOURCE)
      const temporary = join(dirname(destination), `.save-${randomUUID()}`)
      const output = await open(temporary, 'wx')
      staging = temporary
      try {
        const buffer = new Uint8Array(COPY_BUFFER_BYTES)
        let read: number
        while ((read = (await input.read(buffer)).bytesRead) > 0) {
          let written = 0
          while (written < read)
            written += (await output.write(buffer, written, read - written)).bytesWritten
        }
        await output.sync()
        const after = await input.stat()
        if (
          opened.size !== after.size ||
          opened.mtimeMs !== after.mtimeMs ||
          opened.ctimeMs !== after.ctimeMs
        )
          throw new Error(INVALID_SOURCE)
      } finally {
        await output.close()
      }
      await rename(temporary, destination)
      staging = undefined
      return { ok: true, path: destination }
    } finally {
      await input.close()
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (staging) await unlink(staging)
  }
}
