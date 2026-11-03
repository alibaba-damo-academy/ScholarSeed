import type { LiteratureSearchPaper } from '../../contracts/literature'
import { importBibliography } from './api.ts'
import { searchPapersBibtex } from './result.ts'
import { paperJoinKey, type JoinDestination } from './hierarchy.ts'

const pending = new Set<string>()
/** The only admission path for search rows, batch actions and conversation hit cards.
 * Existing bibliography API saves the entire batch and its destination atomically.
 * Local file/Zotero/BibTeX dialogs remain untouched.
 */
export async function pushLibItem(
  papers: LiteratureSearchPaper[],
  destination: JoinDestination,
  contextProjectId?: string,
  admit: typeof importBibliography = importBibliography
): Promise<string[]> {
  if (!papers.length) return []
  const projectId = contextProjectId || destination.projectId
  if (contextProjectId && destination.projectId !== contextProjectId)
    throw new Error('join_destination_scope_mismatch')
  const keys = papers.map((paper) => paperJoinKey(paper, contextProjectId))
  if (keys.some((key) => pending.has(key))) throw new Error('join_in_progress')
  keys.forEach((key) => pending.add(key))
  try {
    const file = new File([searchPapersBibtex(papers)], 'ai-search-results.bib', {
      type: 'application/x-bibtex',
    })
    const result = await admit([file], { projectId, collectionId: destination.collectionId })
    if (result.items.length !== papers.length) throw new Error('join_incomplete')
    return result.items.map((item) => item.id)
  } finally {
    keys.forEach((key) => pending.delete(key))
  }
}
