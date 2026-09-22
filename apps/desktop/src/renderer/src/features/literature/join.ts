import type { LiteratureSearchPaper } from '../../contracts/literature'
import { importBibliography, type LibraryCollection } from './api.ts'
import { searchPapersBibtex } from './result.ts'

export interface JoinDestination {
  projectId?: string
  collectionId?: string
  /** Display path is captured from the selected node, never inferred from a later view. */
  path: string[]
}
export interface JoinNode extends JoinDestination { key: string; name: string; children: JoinNode[] }
export function collectionNodes(collections: LibraryCollection[], projectId?: string, prefix: string[] = [], parentId?: string, ancestors = new Set<string>()): JoinNode[] {
  return collections.filter(item => (item.parent_id || undefined) === parentId && !ancestors.has(item.id)).map(item => {
    const path = [...prefix, item.name]
    return { key: `collection:${item.id}`, name: item.name, collectionId: item.id, projectId, path,
      children: collectionNodes(collections, projectId, path, item.id, new Set([...ancestors, item.id])) }
  })
}
export function flattenDestinations(nodes: JoinNode[], depth = 0): Array<{ node: JoinNode; depth: number }> {
  return nodes.flatMap(node => [{ node, depth }, ...flattenDestinations(node.children, depth + 1)])
}
export function paperJoinKey(paper: LiteratureSearchPaper, projectId?: string): string {
  return JSON.stringify([projectId || '', paper.doi?.toLowerCase() || paper.arxiv_id || `${paper.title.trim().toLowerCase()}:${paper.year ?? ''}`])
}
const pending = new Set<string>()
/** The only admission path for search rows, batch actions and conversation hit cards.
 * Existing bibliography API saves the entire batch and its destination atomically.
 * Local file/Zotero/BibTeX dialogs remain untouched.
 */
export async function pushLibItem(papers: LiteratureSearchPaper[], destination: JoinDestination, contextProjectId?: string,
  admit: typeof importBibliography = importBibliography): Promise<string[]> {
  if (!papers.length) return []
  const projectId = contextProjectId || destination.projectId
  if (contextProjectId && destination.projectId !== contextProjectId) throw new Error('join_destination_scope_mismatch')
  const keys = papers.map(paper => paperJoinKey(paper, contextProjectId))
  if (keys.some(key => pending.has(key))) throw new Error('join_in_progress')
  keys.forEach(key => pending.add(key))
  try {
    const file = new File([searchPapersBibtex(papers)], 'ai-search-results.bib', { type: 'application/x-bibtex' })
    const result = await admit([file], { projectId, collectionId: destination.collectionId })
    if (result.items.length !== papers.length) throw new Error('join_incomplete')
    return result.items.map(item => item.id)
  } finally { keys.forEach(key => pending.delete(key)) }
}
