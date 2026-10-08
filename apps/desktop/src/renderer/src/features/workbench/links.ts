import type { CitationResolution } from '../../contracts/citations'

const CITATION_PREFIX = 'scholarseed-cite:'
const FRAGMENT_PREFIX = '#'
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])
const EXACT_CITATION_STATE = 'exact'
const TARGET_UNAVAILABLE = 'document_link_target_unavailable'

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
        actions.previewCitation(citation)
      }
      return
    }
    case 'unavailable':
      throw new Error(TARGET_UNAVAILABLE)
  }
}
