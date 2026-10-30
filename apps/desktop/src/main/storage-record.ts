/** Desktop data-location pointer codec, shared by startup and private inspection. */
export const STORAGE_CONFIG_SCHEMA_VERSION = 1
export const STORAGE_CONFIG_MAX_BYTES = 64 * 1024

export interface DataHomePointer {
  schemaVersion: number
  dataHome: string
}

export function isValidAbsoluteRoot(value: string, platform: NodeJS.Platform): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (value.includes('\0')) return false
  if (platform === 'win32') {
    return (
      /^[A-Za-z]:[\\/]/.test(value) ||
      /^\\\\(?![?.](?:\\|$))[^\\/?*:|"<>]+\\[^\\/?*:|"<>]+(?:\\|$)/.test(value)
    )
  }
  return value.startsWith('/')
}

export function decodeStoragePointer(
  bytes: Uint8Array | null,
  platform: NodeJS.Platform
): DataHomePointer | null {
  if (bytes === null) return null
  if (bytes.length > STORAGE_CONFIG_MAX_BYTES) throw new Error('Storage pointer exceeds size limit')
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  ) as Partial<DataHomePointer> | null
  if (
    !value ||
    value.schemaVersion !== STORAGE_CONFIG_SCHEMA_VERSION ||
    typeof value.dataHome !== 'string' ||
    !isValidAbsoluteRoot(value.dataHome, platform)
  )
    throw new Error('Storage pointer has an unsupported schema or invalid data home')
  return Object.freeze({ schemaVersion: STORAGE_CONFIG_SCHEMA_VERSION, dataHome: value.dataHome })
}
