const EXTERNAL_WEB_PROTOCOLS = new Set(['http:', 'https:'])

export function externalWebUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return EXTERNAL_WEB_PROTOCOLS.has(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}
