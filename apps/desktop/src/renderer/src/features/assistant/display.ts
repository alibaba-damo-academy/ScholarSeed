const URL_CONTROL_CHARACTERS = /\p{Cc}/u
const WEB_PROTOCOLS = new Set(['https:', 'http:'])
const WEB_HOST_PREFIX = /^www\./i

export function citationOrigin(url: string): { domain: string; label: string } | undefined {
  try {
    const parsed = new URL(url)
    if (!WEB_PROTOCOLS.has(parsed.protocol)) return undefined
    const domain = parsed.hostname.replace(WEB_HOST_PREFIX, '')
    return { domain, label: domain.split('.')[0] || domain }
  } catch {
    return undefined
  }
}

export function citationDisplay(source: { title: string; url: string }): {
  title: string
  url: string
} {
  let url = source.url
  try {
    const decoded = decodeURI(url)
    if (!URL_CONTROL_CHARACTERS.test(decoded)) url = decoded
  } catch {
    url = source.url
  }
  return {
    title: source.title.trim() === source.url.trim() ? url : source.title,
    url,
  }
}
