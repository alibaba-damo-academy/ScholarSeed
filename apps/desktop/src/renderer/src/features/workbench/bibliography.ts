import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { CitationBibliography } from '../../contracts/citations'

const BIBLIOGRAPHY_VERSION = 1
const BIBLIOGRAPHY_FIELD_LIMIT = 20000
const BIBLIOGRAPHY_ATTRIBUTE_LIMIT = 200000
const BIBLIOGRAPHY_FIELDS = ['title', 'authors', 'year', 'publication', 'url', 'doi'] as const
const BIBLIOGRAPHY_ANCHOR =
  /^<a\s+(?:id|name)\s*=\s*(["'])([^\s"'<>`=&\p{Cc}]+)\1\s+data-scholarseed-reference\s*=\s*(["'])([^"']*)\3\s*>\s*<\/a\s*>\s*$/iu
const PLAIN_ANCHOR = /^<a\s+(?:id|name)\s*=\s*(["'])([^\s"'<>`=&\p{Cc}]+)\1\s*>\s*<\/a\s*>\s*$/iu
const REFERENCE_HEADING = /^(?:参考文献|references|bibliography)$/iu
const NUMERIC_REFERENCE = /^\[(\d+)\](?:\s|$)/u
const DOI_IDENTIFIER = /^10\.\d{4,9}\/\S+$/u
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

interface BibliographyNode {
  type: string
  value?: string
  depth?: number
  children?: BibliographyNode[]
}

export interface BibliographyPreview {
  metadata: CitationBibliography | null
  reference: string
}

export function parseBibliography(value: unknown): CitationBibliography | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== BIBLIOGRAPHY_VERSION) return null
  if (
    BIBLIOGRAPHY_FIELDS.some(
      (field) =>
        typeof record[field] !== 'string' || record[field].length > BIBLIOGRAPHY_FIELD_LIMIT
    )
  )
    return null
  return {
    version: BIBLIOGRAPHY_VERSION,
    title: record.title as string,
    authors: record.authors as string,
    year: record.year as string,
    publication: record.publication as string,
    url: record.url as string,
    doi: record.doi as string,
  }
}

export function bibliographyAnchor(
  value: string
): { id: string; metadata: CitationBibliography | null } | null {
  if (value.length > BIBLIOGRAPHY_ATTRIBUTE_LIMIT) return null
  const match = BIBLIOGRAPHY_ANCHOR.exec(value)
  if (!match) return null
  let metadata: CitationBibliography | null = null
  try {
    metadata = parseBibliography(JSON.parse(decodeURIComponent(match[4])))
  } catch {
    metadata = null
  }
  return { id: match[2], metadata }
}

function visibleText(node: BibliographyNode): string {
  if (node.type === 'html') return ''
  return node.value ?? node.children?.map(visibleText).join('') ?? ''
}

export function bibliographyPreview(source: string, href: string): BibliographyPreview | null {
  if (!href.startsWith('#ref-')) return null
  let fragment: string
  try {
    fragment = decodeURIComponent(href.slice(1))
  } catch {
    return null
  }
  const tree = unified().use(remarkParse).parse(source) as BibliographyNode
  const blocks = tree.children ?? []
  let referenceDepth = 0
  const matches: BibliographyPreview[] = []
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (REFERENCE_HEADING.test(visibleText(block).trim())) referenceDepth = block.depth ?? 0
      else if ((block.depth ?? 0) <= referenceDepth) referenceDepth = 0
    }
    if (block.type !== 'paragraph' && block.type !== 'html') continue
    const children = block.type === 'html' ? [block] : (block.children ?? [])
    for (const [index, child] of children.entries()) {
      if (child.type !== 'html') continue
      const following = children[index + 1]
      const value =
        (child.value ?? '') +
        (following?.type === 'html' && following.value === '</a>' ? following.value : '')
      const explicit = bibliographyAnchor(value)
      const plain = PLAIN_ANCHOR.exec(value)
      if ((explicit?.id ?? plain?.[2]) === fragment)
        matches.push({ metadata: explicit?.metadata ?? null, reference: '' })
    }
    const reference = visibleText(block).trim()
    const matched = matches.at(-1)
    if (matched && reference) return { metadata: matched.metadata, reference }
    if (referenceDepth && `ref-${NUMERIC_REFERENCE.exec(reference)?.[1]}` === fragment)
      return { metadata: null, reference }
  }
  return matches.at(-1) ?? null
}

export function bibliographyUrl(metadata: CitationBibliography): string {
  const candidate =
    metadata.url.trim() ||
    (DOI_IDENTIFIER.test(metadata.doi.trim()) ? `https://doi.org/${metadata.doi.trim()}` : '')
  try {
    const url = new URL(candidate)
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}
