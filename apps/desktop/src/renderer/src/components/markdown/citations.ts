import type { Element, RootContent } from 'hast'

import { isCitationUrl } from '../../contracts/citations'

export const CITATION_MARKER = 'dataCitationMarker'
export const CITATION_PENDING = 'dataCitationPending'
export const CITATION_LABEL = /^(?:[0-9]+|\[[0-9]+\])$/
export const REFERENCE_LABEL = /\[([0-9]+)\](?!\(|\[(?![0-9]+\]))/g
const DESTINATION_BOUNDARY = /\s/
const STREAMING_REFERENCE = /\[(?:\[[0-9]+\]?\]?|[0-9]+\]?)/g
const MARKDOWN_ESCAPE = '\\'
const WEB_SCHEME = /^https?:\/\//
const TRAILING_SLASH = /\/$/

export function streamingReferenceEnd(source: string, start: number): number {
  const boundary = source.slice(start).search(DESTINATION_BOUNDARY)
  return boundary < 0 ? source.length : start + boundary
}

export function streamingReferenceStart(source: string): number | undefined {
  const lineStart = source.lastIndexOf('\n') + 1
  const matches = [...source.slice(lineStart).matchAll(STREAMING_REFERENCE)]
  for (const match of matches.reverse()) {
    const start = lineStart + match.index
    const tail = source.slice(start + match[0].length)
    if (!tail) return start
    if (!match[0].endsWith(']') || !tail.startsWith('(')) continue
    let depth = 0
    for (let index = 0; index < tail.length; index += 1) {
      if (tail[index] === MARKDOWN_ESCAPE) {
        index += 1
        continue
      }
      if (tail[index] === '(') depth += 1
      if (tail[index] === ')') depth -= 1
      if (!depth) break
    }
    if (depth > 0) return start
  }
  return undefined
}

export interface MarkdownCitationReference {
  label: string
  href: string
}

export function citationText(node: RootContent): string {
  if (node.type === 'text') return node.value
  return node.type === 'element' ? node.children.map(citationText).join('') : ''
}

export function isCitationLink(
  node: Element,
  urls: ReadonlySet<string>,
  pending: boolean
): boolean {
  const href = String(node.properties.href ?? '')
  const label = citationText(node)
  const urlLabel =
    label === href ||
    (WEB_SCHEME.test(href) &&
      href.replace(WEB_SCHEME, '').replace(TRAILING_SLASH, '') ===
        label.replace(WEB_SCHEME, '').replace(TRAILING_SLASH, ''))
  return (
    node.tagName === 'a' &&
    Boolean(href) &&
    (isCitationUrl(href) ||
      (CITATION_LABEL.test(label) && (pending || urls.has(href))) ||
      ((pending || urls.has(href)) && urlLabel))
  )
}

export function citationReferences(
  references: readonly MarkdownCitationReference[]
): Map<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const { label, href } of references) {
    const targets = candidates.get(label) ?? new Set<string>()
    targets.add(href)
    candidates.set(label, targets)
  }
  return new Map(
    [...candidates].flatMap(([label, targets]) =>
      targets.size === 1 ? [[label, [...targets][0]]] : []
    )
  )
}
