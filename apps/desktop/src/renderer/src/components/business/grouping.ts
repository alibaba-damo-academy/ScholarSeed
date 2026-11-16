import type { CitationResolution } from '../../contracts/citations'
import { citationReferenceUrl } from '../../contracts/citations.ts'
import type { MarkdownCitationEntry } from '../markdown/citations'
import type { AnswerSource } from '../../model'

const CITATION_SOURCE_LABELS = {
  file: 'citations.fileSource',
  literature: 'citations.paperSource',
  resource: 'citations.resourceSource',
  attachment: 'citations.attachmentSource',
  selection: 'citations.selectionSource',
  managed_fulltext: 'citations.fileSource',
} as const

export function citationSourceType(kind: string): {
  labelKey:
    (typeof CITATION_SOURCE_LABELS)[keyof typeof CITATION_SOURCE_LABELS] | 'citations.unknownSource'
  groupKey?: string
} {
  if (!Object.hasOwn(CITATION_SOURCE_LABELS, kind)) return { labelKey: 'citations.unknownSource' }
  return {
    labelKey: CITATION_SOURCE_LABELS[kind as keyof typeof CITATION_SOURCE_LABELS],
    groupKey: kind,
  }
}

export function citationSourceGroupKeys(
  sources: readonly CitationResolution[],
  answerSources: readonly AnswerSource[] = []
): Record<string, string> {
  return Object.fromEntries([
    ...sources.flatMap((source) => {
      const { groupKey } = citationSourceType(source.source_kind)
      if (!groupKey) return []
      const declared = answerSources.find(
        (candidate) => candidate.kind === 'receipt' && candidate.handle === source.handle
      )
      return [
        ...new Set([citationReferenceUrl(source.handle), ...(declared?.citation_urls ?? [])]),
      ].map((href) => [href, groupKey])
    }),
    ...answerSources.flatMap((source) =>
      source.kind === 'searched'
        ? (source.citation_urls ?? [source.url]).map((href) => [href, source.kind])
        : []
    ),
  ])
}

export function groupWebCitationSources(
  entries: readonly MarkdownCitationEntry[],
  sources: readonly AnswerSource[] = []
): Extract<AnswerSource, { kind: 'searched' }>[] {
  const byHref = new Map<string, Extract<AnswerSource, { kind: 'searched' }>>()
  for (const source of sources) {
    if (source.kind !== 'searched') continue
    for (const href of source.citation_urls ?? [source.url]) {
      if (!byHref.has(href)) byHref.set(href, source)
    }
  }
  const pages = new Map<string, Extract<AnswerSource, { kind: 'searched' }>>()
  for (const { href } of entries) {
    const source = byHref.get(href)
    if (source && !pages.has(source.url)) pages.set(source.url, source)
  }
  return [...pages.values()]
}

export interface CitationTarget {
  source: CitationResolution
  resolve: () => Promise<CitationResolution>
}

export interface CitationReference extends CitationTarget {
  excerpts: readonly CitationTarget[]
  occurrences?: number
}

export function groupCitationReferences(
  entries: readonly MarkdownCitationEntry[],
  sources: readonly CitationResolution[],
  resolve: (
    source: CitationResolution,
    entry: MarkdownCitationEntry
  ) => Promise<CitationResolution>,
  answerSources: readonly AnswerSource[] = []
): CitationReference[] {
  const groups = new Map<string, CitationReference>()
  for (const entry of entries) {
    const declared = answerSources.find(
      (candidate) => candidate.kind === 'receipt' && candidate.citation_urls.includes(entry.href)
    )
    const source = sources.find(
      (candidate) =>
        entry.href === citationReferenceUrl(candidate.handle) ||
        (declared?.kind === 'receipt' && candidate.handle === declared.handle)
    )
    if (!source) continue
    const key = citationDocumentKey(source)
    const target = { source, resolve: () => resolve(source, entry) }
    const previous = groups.get(key)
    if (previous) {
      previous.occurrences = (previous.occurrences ?? 1) + 1
      if (!previous.excerpts.some((excerpt) => excerpt.source.handle === source.handle)) {
        previous.excerpts = [...previous.excerpts, target]
      }
    } else {
      groups.set(key, {
        ...target,
        excerpts: [target],
        occurrences: 1,
      })
    }
  }
  return [...groups.values()]
}

export function citationDocumentKey(source: CitationResolution): string {
  return JSON.stringify([
    source.project_id,
    source.source_session_id ?? '',
    source.source_kind,
    source.source_id || source.path || source.handle,
    source.revision,
  ])
}
export function groupCitationSources(
  sources: readonly AnswerSource[],
  resolutions: readonly CitationResolution[]
): { key: string; sources: AnswerSource[] }[] {
  const resolved = new Map(resolutions.map((source) => [source.handle, source]))
  const groups = new Map<string, AnswerSource[]>()
  for (const source of sources) {
    if (source.kind === 'receipt' && source.source_group_id === null) continue
    const document = source.kind === 'receipt' ? resolved.get(source.handle) : undefined
    const key =
      source.kind === 'searched'
        ? JSON.stringify(['web', source.url])
        : source.kind === 'project'
          ? JSON.stringify(['project', source.project_id, source.source_kind, source.path])
          : source.source_group_id
            ? JSON.stringify(['document', source.source_group_id])
            : document?.source_id
              ? citationDocumentKey(document)
              : JSON.stringify(['handle', source.handle])
    const entries = groups.get(key)
    if (entries) entries.push(source)
    else groups.set(key, [source])
  }
  return Array.from(groups, ([key, entries]) => ({ key, sources: entries }))
}
