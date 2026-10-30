export interface WindowCloseState {
  askOnClose: boolean
}
export const TRAY_STATE_FILENAME = 'window-close-state.json'
export const TRAY_STATE_MAX_BYTES = 64 * 1024

export function defaultWindowCloseState(): WindowCloseState {
  return { askOnClose: true }
}

export function sanitizeWindowCloseState(value: unknown): WindowCloseState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultWindowCloseState()
  return { askOnClose: (value as Partial<WindowCloseState>).askOnClose !== false }
}

export function decodeWindowCloseState(bytes: Uint8Array | null): WindowCloseState {
  if (bytes === null) return defaultWindowCloseState()
  if (bytes.byteLength > TRAY_STATE_MAX_BYTES) throw new Error('Window state exceeds size limit')
  return sanitizeWindowCloseState(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  )
}
