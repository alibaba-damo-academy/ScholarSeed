import type { NoteSource, NoteProvenance } from '../../contracts/literature'
export type { NoteSource } from '../../contracts/literature'
import type { Nodes } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export const NOTE_SOURCE_PREFIX = '#scholarseed-note-sources-'
export const NOTE_PARAGRAPH_PREFIX = '#scholarseed-note-paragraph-'
const NOTE_UNREFERENCED_PREFIX = '#scholarseed-note-unreferenced-'
export const NOTE_SOURCE_VERSION = 1
export const NOTE_SOURCE_LIMIT = 100
export const NOTE_SOURCE_VISIBLE = 3
const TEXT_LIMIT = 16384
const IDENTIFIER_LIMIT = 256
const NAME_LIMIT = 512
const LINK_LIMIT = 4 * 1024 * 1024
const BIBLIOGRAPHIC_LINE = /^[^\n·]+\s*·\s*[^\n·]+\s*·\s*\d{4}[a-z]?$/
const parser = unified().use(remarkParse)

function bibliographicParagraph(text: string): boolean {
  const plain = (node: Nodes): string => {
    if (node.type === 'break') return '\n'
    if ('children' in node) return node.children.map(plain).join('')
    return node.type === 'text' || node.type === 'inlineCode' ? node.value : ''
  }
  const lines = plain(parser.parse(text)).trim().split(/\r?\n/)
  return lines.length === 2 && Boolean(lines[0].trim()) && BIBLIOGRAPHIC_LINE.test(lines[1].trim())
}

export interface NoteSourceGroup {
  version: typeof NOTE_SOURCE_VERSION
  sources: NoteSource[]
}
export interface ResolvedNoteSource {
  source: NoteSource
  state: 'available' | 'unavailable' | 'changed'
  current: NoteSource | null
}
export interface NoteSourceCandidates {
  items: NoteSource[]
  unavailable_attachment_ids: string[]
  omitted_count: number
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function fields(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value)
}
function bounded(value: unknown, limit = IDENTIFIER_LIMIT, empty = false): value is string {
  return (
    typeof value === 'string' &&
    Array.from(value).length <= limit &&
    (empty || Boolean(value.trim()))
  )
}
export function validNoteSource(value: unknown): value is NoteSource {
  if (
    !object(value) ||
    !fields(value, [
      'record_target',
      'source_revision',
      'mark_id',
      'comment_id',
      'kind',
      'page',
      'text',
      'attachment_name',
    ])
  )
    return false
  const target = value.record_target
  return (
    object(target) &&
    fields(target, ['owner', 'scope_id', 'subject_id']) &&
    target.owner === 'literature_attachment' &&
    bounded(target.scope_id) &&
    bounded(target.subject_id) &&
    bounded(value.source_revision) &&
    bounded(value.mark_id) &&
    bounded(value.text, TEXT_LIMIT, value.kind === 'location') &&
    bounded(value.attachment_name, NAME_LIMIT, true) &&
    Number.isSafeInteger(value.page) &&
    Number(value.page) > 0 &&
    ((value.kind === 'text' && value.comment_id === null) ||
      (value.kind === 'location' && value.comment_id === null && value.text === '') ||
      (value.kind === 'user_comment' && bounded(value.comment_id)))
  )
}
export function parseNoteSourceLink(href: string): NoteSourceGroup | null {
  if (!href.startsWith(NOTE_SOURCE_PREFIX) || href.length > LINK_LIMIT) return null
  try {
    const value: unknown = JSON.parse(decodeURIComponent(href.slice(NOTE_SOURCE_PREFIX.length)))
    return object(value) &&
      fields(value, ['version', 'sources']) &&
      value.version === NOTE_SOURCE_VERSION &&
      Array.isArray(value.sources) &&
      value.sources.length > 0 &&
      value.sources.length <= NOTE_SOURCE_LIMIT &&
      value.sources.every(validNoteSource)
      ? (value as unknown as NoteSourceGroup)
      : null
  } catch {
    return null
  }
}
export function noteSourceLink(sources: NoteSource[]): string {
  const href =
    NOTE_SOURCE_PREFIX +
    encodeURIComponent(JSON.stringify({ version: NOTE_SOURCE_VERSION, sources })).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    )
  if (!parseNoteSourceLink(href)) throw new Error('literature_note_sources_invalid')
  return href
}
export function notePreviewSourceGroup(
  href: string,
  groups: Record<string, NoteSourceGroup>
): NoteSourceGroup | null {
  return Object.hasOwn(groups, href) ? groups[href] : parseNoteSourceLink(href)
}
export function noteSourceKey(source: NoteSource): string {
  return JSON.stringify([
    source.record_target.scope_id,
    source.record_target.subject_id,
    source.source_revision,
    source.mark_id,
    source.comment_id,
  ])
}
export function noteSourceLinks(text: string): string[] {
  const links = new Set<string>()
  const walk = (node: Nodes): void => {
    if (node.type === 'link' && node.url.startsWith(NOTE_SOURCE_PREFIX)) links.add(node.url)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(parser.parse(text))
  return [...links]
}

/** Render-only links: persisted/exported Markdown never receives these payloads. */
export function noteUnreferencedGroups(
  provenance?: NoteProvenance | null
): Record<string, NoteSourceGroup> {
  const groups: Record<string, NoteSourceGroup> = {}
  const sources = provenance?.unreferenced_sources
  if (
    provenance?.version !== NOTE_SOURCE_VERSION ||
    !Array.isArray(sources) ||
    !sources.every(validNoteSource)
  )
    return groups
  for (let start = 0; start < sources.length; start += NOTE_SOURCE_LIMIT)
    groups[`${NOTE_UNREFERENCED_PREFIX}${start}`] = {
      version: NOTE_SOURCE_VERSION,
      sources: sources.slice(start, start + NOTE_SOURCE_LIMIT),
    }
  return groups
}

/** Render-only links: persisted/exported Markdown never receives these payloads. */
export function noteProvenancePreview(
  text: string,
  provenance?: NoteProvenance | null
): {
  text: string
  stale: boolean
  groups: Record<string, NoteSourceGroup>
} {
  const groups: Record<string, NoteSourceGroup> = {}
  if (!provenance) return { text, stale: false, groups }
  if (provenance.version !== NOTE_SOURCE_VERSION || !Array.isArray(provenance.paragraphs))
    return { text, stale: true, groups }
  const paragraphs = parser.parse(text).children.filter((node) => node.type === 'paragraph')
  const additions: { start: number; offset: number; replacement: string }[] = []
  let stale = false
  const claimed = new Set<number>()
  for (const binding of provenance.paragraphs) {
    if (!binding || typeof binding.text !== 'string' || !Array.isArray(binding.sources)) {
      stale = true
      continue
    }
    const matches = paragraphs.filter(
      (node) => text.slice(node.position?.start.offset, node.position?.end.offset) === binding.text
    )
    const offset = matches.length === 1 ? matches[0].position?.end.offset : undefined
    const paragraphStart = matches.length === 1 ? matches[0].position?.start.offset : undefined
    if (offset === undefined || paragraphStart === undefined || claimed.has(offset)) {
      stale = true
      continue
    }
    if (
      (!binding.sources.length && provenance.status !== 'indexed') ||
      !binding.sources.every(validNoteSource)
    ) {
      stale = true
      continue
    }
    claimed.add(offset)
    const displayText =
      provenance.status === 'indexed' && typeof binding.display_text === 'string'
        ? binding.display_text
        : binding.text
    // Keep bibliographic provenance in the index without offering misleading page navigation.
    if (matches[0] === paragraphs[0] && bibliographicParagraph(displayText)) {
      additions.push({ start: paragraphStart, offset, replacement: displayText })
      continue
    }
    const links: string[] = []
    for (let start = 0; start < binding.sources.length; start += NOTE_SOURCE_LIMIT) {
      const link = `${NOTE_PARAGRAPH_PREFIX}${Object.keys(groups).length}`
      groups[link] = {
        version: NOTE_SOURCE_VERSION,
        sources: binding.sources.slice(start, start + NOTE_SOURCE_LIMIT),
      }
      links.push(`[](${link})`)
    }
    additions.push({
      start: paragraphStart,
      offset,
      replacement: displayText + (links.length ? `\n\n${links.join('\n\n')}` : ''),
    })
  }
  for (const { start, offset, replacement } of additions.sort((a, b) => b.offset - a.offset))
    text = `${text.slice(0, start)}${replacement}${text.slice(offset)}`
  return { text, stale, groups }
}
