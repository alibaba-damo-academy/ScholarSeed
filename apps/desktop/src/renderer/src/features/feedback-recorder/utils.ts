import {
  FEEDBACK_CAPTURE_ERROR,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_SCREENSHOT_MIME_TYPE,
  type FeedbackScreenshotResult,
} from '../../../../feedback.ts'

export const RECORDER_BODY_MAX_BYTES = 200

const encoder = new TextEncoder()
const FILE_URL_BASE = 'http://localhost'
const IDENTITY_CONTENT_ENCODING = 'identity'
const CREDENTIAL_REDACTION = '[已隐藏凭据]'
const CREDENTIAL_FIELDS = new Set([
  'password',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'authorization',
  'clientsecret',
  'secret',
  'token',
])

export function isCredentialName(name: string): boolean {
  return CREDENTIAL_FIELDS.has(name.replace(/[-_\s]/g, '').toLowerCase())
}

export function redactUrl(value: string): string {
  try {
    const absolute = URL.canParse(value)
    const parsed = new URL(value, FILE_URL_BASE)
    let redacted = false
    if (parsed.username || parsed.password) {
      parsed.username = ''
      parsed.password = ''
      redacted = true
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (!isCredentialName(key)) continue
      parsed.searchParams.set(key, CREDENTIAL_REDACTION)
      redacted = true
    }
    const fragment = new URLSearchParams(parsed.hash.slice(1))
    let fragmentRedacted = false
    for (const key of Array.from(fragment.keys())) {
      if (!isCredentialName(key)) continue
      fragment.set(key, CREDENTIAL_REDACTION)
      fragmentRedacted = true
    }
    if (fragmentRedacted) {
      parsed.hash = fragment.toString()
      redacted = true
    }
    if (!redacted) return value
    return absolute ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return value
  }
}

export function summarizeBodyText(value: string): string {
  let redacted = false
  try {
    const parsed: unknown = JSON.parse(value, (key, entry: unknown) => {
      if (!isCredentialName(key)) return entry
      redacted = true
      return CREDENTIAL_REDACTION
    })
    return summarizeText(redacted ? JSON.stringify(parsed) : value)
  } catch {
    const fields = new URLSearchParams(value)
    for (const key of Array.from(fields.keys())) {
      if (!isCredentialName(key)) continue
      fields.set(key, CREDENTIAL_REDACTION)
      redacted = true
    }
    return summarizeText(redacted ? fields.toString() : value)
  }
}
function truncationNotice(omittedBytes: number): string {
  return `…[已截断，省略 ${omittedBytes} 字节]`
}
export const RECORDER_BODY_SUMMARY_MAX_BYTES =
  RECORDER_BODY_MAX_BYTES + encoder.encode(truncationNotice(Number.MAX_SAFE_INTEGER)).byteLength
const FILE_MEDIA_TYPES = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
])
const FILE_MEDIA_PREFIXES = ['image/', 'audio/', 'video/', 'application/vnd.openxmlformats-']

export function screenshotLayerPlacement(
  viewport: { width: number; height: number },
  image: { width: number; height: number },
  bounds: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round((bounds.x * image.width) / viewport.width),
    y: Math.round((bounds.y * image.height) / viewport.height),
    width: Math.round((bounds.width * image.width) / viewport.width),
    height: Math.round((bounds.height * image.height) / viewport.height),
  }
}

function screenshotBlob(bytes: Uint8Array): Blob {
  return new Blob([Uint8Array.from(bytes).buffer], { type: FEEDBACK_SCREENSHOT_MIME_TYPE })
}

export async function compositeFeedbackScreenshot(
  result: Extract<FeedbackScreenshotResult, { ok: true }>
): Promise<Blob> {
  const source = screenshotBlob(result.bytes)
  if (!result.layers?.length) return source
  const viewport = result.viewport
  if (!viewport || viewport.width <= 0 || viewport.height <= 0)
    throw new Error(FEEDBACK_CAPTURE_ERROR.failed)
  const base = await createImageBitmap(source)
  const canvas = document.createElement('canvas')
  canvas.width = base.width
  canvas.height = base.height
  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error(FEEDBACK_CAPTURE_ERROR.failed)
    context.drawImage(base, 0, 0)
    for (const layer of result.layers) {
      const image = await createImageBitmap(screenshotBlob(layer.bytes))
      try {
        const bounds = screenshotLayerPlacement(viewport, base, layer.bounds)
        context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height)
      } finally {
        image.close()
      }
    }
  } finally {
    base.close()
  }
  const composed = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(FEEDBACK_CAPTURE_ERROR.failed))),
      FEEDBACK_SCREENSHOT_MIME_TYPE
    )
  })
  if (composed.size > FEEDBACK_SCREENSHOT_MAX_BYTES)
    throw new Error(FEEDBACK_CAPTURE_ERROR.tooLarge)
  return composed
}

function decodedFilename(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export function responseFileMetadata(
  headers: Headers,
  url: string,
  knownSize?: number
): string | undefined {
  const disposition = headers.get('content-disposition') || ''
  const mediaType = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (
    !disposition &&
    !FILE_MEDIA_TYPES.has(mediaType) &&
    !FILE_MEDIA_PREFIXES.some((prefix) => mediaType.startsWith(prefix))
  )
    return undefined
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i)
  const ordinary = disposition.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i)
  let filename = encoded ? decodedFilename(encoded[1].trim()) : undefined
  filename ||= ordinary?.[1] || ordinary?.[2]?.trim()
  if (!filename && url) {
    try {
      filename = decodedFilename(new URL(url, FILE_URL_BASE).pathname.split('/').pop() || '')
    } catch {
      filename = undefined
    }
  }
  const declaredSize = headers.get('content-length')
  const encoding = (headers.get('content-encoding') || IDENTITY_CONTENT_ENCODING)
    .trim()
    .toLowerCase()
  const size =
    knownSize ??
    (encoding === IDENTITY_CONTENT_ENCODING && declaredSize && /^\d+$/.test(declaredSize)
      ? Number(declaredSize)
      : undefined)
  return fileMetadata(filename, size !== undefined && Number.isSafeInteger(size) ? size : undefined)
}

export function summarizeBody(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (value instanceof File) return fileMetadata(value.name, value.size)
  if (value instanceof Blob) return fileMetadata(undefined, value.size)
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return fileMetadata(undefined, value.byteLength)
  }
  if (value instanceof FormData) {
    return JSON.stringify(
      Array.from(value.entries(), ([name, entry]) => [
        summarizeText(name),
        entry instanceof File
          ? fileMetadata(entry.name, entry.size)
          : isCredentialName(name)
            ? CREDENTIAL_REDACTION
            : summarizeBodyText(entry),
      ])
    )
  }
  return summarizeBodyText(String(value))
}

export function fileMetadata(name: string | undefined, size: number | undefined): string {
  return `[File ${name ? summarizeText(name) : 'unknown'} ${size === undefined ? 'unknown' : size} bytes]`
}

export function summarizeText(value: string, budget = RECORDER_BODY_MAX_BYTES): string {
  const totalBytes = encoder.encode(value).byteLength
  if (totalBytes <= budget) return value
  let prefix = ''
  let retainedBytes = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (retainedBytes + characterBytes > budget) break
    prefix += character
    retainedBytes += characterBytes
  }
  return `${prefix}${truncationNotice(totalBytes - retainedBytes)}`
}
