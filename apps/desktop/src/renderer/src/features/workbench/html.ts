export const HTML_PREVIEW_MAX_BYTES = 5 * 1024 * 1024
const HTML_MEDIA_TYPES = new Set(['text/html', 'application/xhtml+xml'])

export function isHtmlDocument(session: { mediaType: string }): boolean {
  return HTML_MEDIA_TYPES.has(session.mediaType.split(';', 1)[0].trim().toLowerCase())
}
