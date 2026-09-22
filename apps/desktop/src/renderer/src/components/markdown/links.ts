export function relativeSessionFilePath(href: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    return null
  }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || decoded.includes(':') || /[\u0000-\u001f\u007f]/u.test(decoded)) {
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
