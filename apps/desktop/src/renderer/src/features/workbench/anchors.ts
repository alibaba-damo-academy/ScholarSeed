const ANCHOR_ATTRIBUTE = '(?:id|name)'

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function normalizeMarkdownTargetText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]+>/gu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\\([\\`*{}[\]()#+.!_>-])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function markdownFragmentTarget(
  source: string,
  href: string
): { fragment: string; text: string } | null {
  if (!href.startsWith('#') || href.length === 1) return null
  let fragment: string
  try {
    fragment = decodeURIComponent(href.slice(1))
  } catch {
    return null
  }
  const quoted = `(["'])${escapePattern(fragment)}\\1`
  const anchor = new RegExp(`<a\\s+[^>]*${ANCHOR_ATTRIBUTE}\\s*=\\s*${quoted}[^>]*>\\s*</a>`, 'iu')
  const match = anchor.exec(source)
  if (!match) return null
  const lines = source.slice(match.index + match[0].length).split(/\r?\n/u)
  const target = lines.map(line => normalizeMarkdownTargetText(line)).find(Boolean)
  return target ? { fragment, text: target } : null
}
