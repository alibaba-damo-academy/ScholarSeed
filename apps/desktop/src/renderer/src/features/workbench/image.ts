const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
}
const IMAGE_MEDIA_PREFIX = 'image/'
const PREVIEW_MEDIA_TYPES = new Set(Object.values(IMAGE_MEDIA_TYPES))

export function supportsImagePreview(path: string, mediaType = ''): boolean {
  return PREVIEW_MEDIA_TYPES.has(imageMediaType(path, mediaType))
}

/** Remote document transports may expose binary content as octet-stream. */
export function imageMediaType(path: string, mediaType: string): string {
  if (mediaType.startsWith(IMAGE_MEDIA_PREFIX)) return mediaType
  const extension = path.split('.').pop()?.toLowerCase() || ''
  return IMAGE_MEDIA_TYPES[extension] || mediaType
}
