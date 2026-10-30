import { createHash } from 'node:crypto'
import { emptyPolicy, parsePolicy } from './policy-record.ts'
import { decodeDownloadPreferences } from './downloads-record.ts'
import { decodeDeviceIdentity } from './device.ts'
import { decodeRendererPreferences } from './preferences-record.ts'
import { decodeStartupMarkerVersion, startupMarkerRecord } from './startupmarker.ts'
import { decodeWindowCloseState } from './window-record.ts'
import { decodeStoragePointer } from './storage-record.ts'

export const DESKTOP_INSPECTION_MAX_BYTES = 16 * 1024 * 1024
const readers = {
  'browser-policy': (bytes: Buffer | null) =>
    bytes === null
      ? emptyPolicy()
      : parsePolicy(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  'browser-downloads': (bytes: Buffer | null) =>
    bytes === null
      ? null
      : decodeDownloadPreferences(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  'renderer-preferences': (bytes: Buffer | null) => decodeRendererPreferences(bytes),
  'window-close-state': (bytes: Buffer | null) => decodeWindowCloseState(bytes),
  device: (bytes: Buffer | null) => (bytes === null ? null : decodeDeviceIdentity(bytes)),
  'startup-marker': (bytes: Buffer | null) =>
    bytes === null ? null : decodeStartupMarkerVersion(bytes),
  'storage-pointer': (bytes: Buffer | null) => decodeStoragePointer(bytes, process.platform),
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Real Desktop codecs on caller-supplied private bytes; no paths or file IO.
 * The native owner must qualify and collect the files. This report is reader
 * evidence only and supplies no application, directory or update permission.
 */
export function inspectDesktopRecords(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid inspection')
  const request = value as { version?: unknown; documents?: unknown; release?: unknown }
  const hasRelease = Object.hasOwn(request, 'release')
  if (
    Object.keys(request).sort().join(',') !==
      (hasRelease ? 'documents,release,version' : 'documents,version') ||
    request.version !== 1 ||
    !Array.isArray(request.documents) ||
    request.documents.length !== Object.keys(readers).length
  )
    throw new Error('Invalid inspection coverage')
  const seen = new Set<string>()
  let size = 0
  const records = request.documents.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid inspection document')
    const document = item as { owner: string; bytes: string | null }
    if (
      Object.keys(document).sort().join(',') !== 'bytes,owner' ||
      typeof document.owner !== 'string' ||
      !Object.hasOwn(readers, document.owner) ||
      seen.has(document.owner)
    )
      throw new Error('Invalid inspection owner')
    seen.add(document.owner)
    if (document.bytes !== null && typeof document.bytes !== 'string')
      throw new Error('Invalid inspection bytes')
    if (
      document.bytes !== null &&
      document.bytes.length > Math.ceil(DESKTOP_INSPECTION_MAX_BYTES / 3) * 4
    )
      throw new Error('Inspection exceeds size limit')
    const bytes = document.bytes === null ? null : Buffer.from(document.bytes, 'base64')
    if (bytes !== null && bytes.toString('base64') !== document.bytes)
      throw new Error('Noncanonical inspection bytes')
    size += bytes?.length ?? 0
    if (size > DESKTOP_INSPECTION_MAX_BYTES) throw new Error('Inspection exceeds size limit')
    const projected = readers[document.owner as keyof typeof readers](bytes)
    return {
      owner: document.owner,
      present: bytes !== null,
      sourceDigest: digest(bytes ?? 'absent'),
      projectionDigest: digest(JSON.stringify(projected)),
    }
  })
  records.sort((left, right) => left.owner.localeCompare(right.owner))
  if (!hasRelease) return { version: 1, records }
  const release = request.release as { version?: unknown; buildNumber?: unknown } | null
  if (
    !release ||
    typeof release !== 'object' ||
    Object.keys(release).sort().join(',') !== 'buildNumber,version' ||
    typeof release.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    typeof release.buildNumber !== 'string' ||
    !/^\d{12}$/.test(release.buildNumber)
  )
    throw new Error('Invalid pinned release identity')
  const marker = Buffer.from(
    `${JSON.stringify(startupMarkerRecord({ version: release.version, buildNumber: release.buildNumber }))}\n`,
    'utf8'
  )
  decodeStartupMarkerVersion(marker)
  return { version: 1, records, preparedMarker: marker.toString('base64') }
}
