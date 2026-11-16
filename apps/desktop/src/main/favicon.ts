import { browserResourceAllowed } from './navigation.ts'

export const FAVICON_MAX_BYTES = 64 * 1024
export const FAVICON_WORLD = 1005
const FAVICON_TIMEOUT_MS = 5000
const FAVICON_MIME = '^image/(?:png|x-icon|vnd\\.microsoft\\.icon|jpeg|gif|webp)$'

export interface FaviconData {
  bytes: Uint8Array
  mediaType: string
}

function allowedFavicon(source: string, page: string): boolean {
  let url: URL
  let pageUrl: URL
  try {
    url = new URL(source)
    pageUrl = new URL(page)
  } catch {
    return false
  }
  if (
    !browserResourceAllowed({
      url: pageUrl,
      topOrigin: pageUrl.origin,
      approvedLocalOrigin: null,
      apiOrigin: null,
    }) ||
    !browserResourceAllowed({
      url,
      topOrigin: pageUrl.origin,
      approvedLocalOrigin: null,
      apiOrigin: null,
    })
  )
    return false
  return true
}

async function readFavicon(
  source: string,
  maximumBytes: number,
  timeoutMs: number,
  mimePattern: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<FaviconData | null> {
  const response = await fetcher(source, {
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
  if (!response.ok || !new RegExp(mimePattern, 'i').test(mediaType)) {
    await response.body?.cancel()
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, mediaType }
}

export function faviconScript(source: string, page: string): string | null {
  if (!allowedFavicon(source, page)) return null
  return `(${readFavicon.toString()})(${JSON.stringify(source)}, ${FAVICON_MAX_BYTES}, ${FAVICON_TIMEOUT_MS}, ${JSON.stringify(FAVICON_MIME)})`
}

export async function loadFavicon(
  source: string,
  page: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>
): Promise<FaviconData | null> {
  if (!allowedFavicon(source, page)) return null
  return readFavicon(source, FAVICON_MAX_BYTES, FAVICON_TIMEOUT_MS, FAVICON_MIME, fetcher)
}
