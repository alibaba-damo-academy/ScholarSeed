const DEFAULT_COPY_NAME = 'artifact-copy'
const MAX_COPY_NAME_LENGTH = 180

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
    bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
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
