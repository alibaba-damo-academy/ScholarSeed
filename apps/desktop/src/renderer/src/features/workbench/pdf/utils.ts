import type { TextContent } from 'pdfjs-dist/types/src/display/api'

export function pdfPlainText(content: Pick<TextContent, 'items'>): string {
  return content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
    .join('')
}

type IntersectionSample = Pick<IntersectionObserverEntry, 'time' | 'isIntersecting'>

export function latestIntersection(
  entries: readonly IntersectionSample[]
): IntersectionSample | undefined {
  return entries.reduce<IntersectionSample | undefined>(
    (latest, entry) => (!latest || entry.time >= latest.time ? entry : latest),
    undefined
  )
}
