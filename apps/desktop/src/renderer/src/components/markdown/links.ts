export function relativeSessionFilePath(href: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    return null
  }
  if (
    !decoded ||
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    decoded.includes(':') ||
    /[\u0000-\u001f\u007f]/u.test(decoded)
  ) {
    return null
  }
  const segments = decoded.split('/')
  if (segments.some((segment) => !segment || segment === '..')) return null
  const relative = segments.filter((segment) => segment !== '.').join('/')
  return relative || null
}

export function absoluteSessionFilePath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root}${root.endsWith('/') || root.endsWith('\\') ? '' : separator}${relative.replace(/\//gu, separator)}`
}
export function messageLinks(text: string): { value: string; url?: string }[] {
  const fragments: { value: string; url?: string }[] = []
  let end = 0
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'，。！？；、（）【】“”‘’]+/giu)) {
    let candidate = match[0].replace(/[.,;:!?]+$/, '')
    for (const [opening, closing] of [
      ['(', ')'],
      ['[', ']'],
      ['{', '}'],
    ]) {
      while (
        candidate.endsWith(closing) &&
        candidate.split(closing).length > candidate.split(opening).length
      )
        candidate = candidate.slice(0, -1)
    }
    try {
      const url = new URL(candidate)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    } catch {
      continue
    }
    fragments.push({ value: text.slice(end, match.index) }, { value: candidate, url: candidate })
    end = match.index + candidate.length
  }
  fragments.push({ value: text.slice(end) })
  return fragments
}
