import type { CitationResolution } from '../../contracts/citations'

const CITATION_PREFIX = 'scholarseed-cite:'
const FRAGMENT_PREFIX = '#'
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])
const EXACT_CITATION_STATE = 'exact'
const TARGET_UNAVAILABLE = 'document_link_target_unavailable'
const CITATION_FAILURE_MESSAGES = {
  citation_evidence_unavailable: 'markdown.citationRecordMissing',
  citation_source_unavailable: 'markdown.citationSourceUnavailable',
  source_revision_changed: 'markdown.citationSourceChanged',
} as const
const CITATION_STATE_FAILURES = {
  unavailable: 'citation_source_unavailable',
  changed: 'source_revision_changed',
} as const

export class DocumentCitationError extends Error {
  readonly reason: keyof typeof CITATION_FAILURE_MESSAGES

  constructor(reason: keyof typeof CITATION_FAILURE_MESSAGES) {
    super(reason)
    this.reason = reason
  }
}

export function savedCitationError(detail: unknown): Error {
  if (
    typeof detail === 'string' &&
    Object.prototype.hasOwnProperty.call(CITATION_FAILURE_MESSAGES, detail)
  ) {
    return new DocumentCitationError(detail as keyof typeof CITATION_FAILURE_MESSAGES)
  }
  return new Error(TARGET_UNAVAILABLE)
}

export function citationFailureMessage(error: unknown) {
  return error instanceof DocumentCitationError
    ? CITATION_FAILURE_MESSAGES[error.reason]
    : undefined
}

export const DOCUMENT_LINK_ATTRIBUTE = 'data-document-link'
export const DOCUMENT_LINK_SELECTOR = `a[${DOCUMENT_LINK_ATTRIBUTE}]`

export type DocumentLinkTarget =
  | { kind: 'external'; href: string }
  | { kind: 'citation'; href: string; handle: string }
  | { kind: 'fragment'; href: string }
  | { kind: 'unavailable'; href: string }

export function documentLinkTarget(href: string): DocumentLinkTarget {
  if (href.startsWith(CITATION_PREFIX) && href.length > CITATION_PREFIX.length) {
    return { kind: 'citation', href, handle: href.slice(CITATION_PREFIX.length) }
  }
  if (href.startsWith(FRAGMENT_PREFIX) && href.length > FRAGMENT_PREFIX.length) {
    return { kind: 'fragment', href }
  }
  try {
    if (EXTERNAL_PROTOCOLS.has(new URL(href).protocol)) return { kind: 'external', href }
  } catch {
    return { kind: 'unavailable', href }
  }
  return { kind: 'unavailable', href }
}

export interface DocumentLinkActions {
  openExternal: (href: string) => Promise<void>
  navigateFragment: (href: string) => boolean
  resolveCitation: (handle: string) => Promise<CitationResolution>
  revealCitation: (citation: CitationResolution) => Promise<void>
  previewCitation: (citation: CitationResolution) => void
}

export async function navigateDocumentLink(
  target: DocumentLinkTarget,
  actions: DocumentLinkActions
): Promise<void> {
  switch (target.kind) {
    case 'external':
      await actions.openExternal(target.href)
      return
    case 'fragment':
      if (!actions.navigateFragment(target.href)) throw new Error(TARGET_UNAVAILABLE)
      return
    case 'citation': {
      const citation = await actions.resolveCitation(target.handle)
      if (
        citation.state === EXACT_CITATION_STATE &&
        citation.can_open_pdf &&
        citation.matches.length
      ) {
        await actions.revealCitation(citation)
      } else {
        if (Object.prototype.hasOwnProperty.call(CITATION_STATE_FAILURES, citation.state)) {
          throw new DocumentCitationError(
            CITATION_STATE_FAILURES[citation.state as keyof typeof CITATION_STATE_FAILURES]
          )
        }
        actions.previewCitation(citation)
      }
      return
    }
    case 'unavailable':
      throw new Error(TARGET_UNAVAILABLE)
  }
}
