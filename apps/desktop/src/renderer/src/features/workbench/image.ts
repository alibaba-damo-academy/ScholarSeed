const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}
const IMAGE_MEDIA_PREFIX = 'image/'

/** Remote document transports may expose binary content as octet-stream. */
export function imageMediaType(path: string, mediaType: string): string {
  if (mediaType.startsWith(IMAGE_MEDIA_PREFIX)) return mediaType
  const extension = path.split('.').pop()?.toLowerCase() || ''
  return IMAGE_MEDIA_TYPES[extension] || mediaType
}
