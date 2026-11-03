import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readRecord, writeJson } from './journal.ts'

export const DEVICE_FILENAME = 'device.json'
export const DEVICE_MAX_BYTES = 64 * 1024

export interface DeviceIdentity {
  device_id: string
  device_label: string
}

/** The real persisted record reader, shared with storage inspection. */
export function decodeDeviceIdentity(bytes: Uint8Array): string | null {
  if (bytes.byteLength > DEVICE_MAX_BYTES) throw new Error('Device record exceeds size limit')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = (value as { device_id?: unknown }).device_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function readDeviceIdentity(path: string): string | null {
  return decodeDeviceIdentity(readRecord(path, DEVICE_MAX_BYTES))
}

export function resolveDeviceIdentity(
  home: string,
  label: string,
  options: {
    beforeCreate(): void
    acquireWriter(): { close(): void }
    log(line: string): void
  }
): DeviceIdentity {
  const path = join(home, DEVICE_FILENAME)
  try {
    const existing = readDeviceIdentity(path)
    if (existing) return { device_id: existing, device_label: label }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      options.log('[shell] device record unreadable; regenerating identity\n')
  }
  options.beforeCreate()
  // Ownership failures must propagate rather than becoming an unprotected
  // write or a successful-looking fallback. Only ordinary file IO may fall back.
  const id = randomUUID()
  const writer = options.acquireWriter()
  try {
    writeJson(path, { device_id: id })
  } catch (error) {
    options.log(`[shell] WARN cannot persist device id: ${String(error)}\n`)
  } finally {
    writer.close()
  }
  return { device_id: id, device_label: label }
}
