import type { CardCollection } from './ports'
import type { LiteratureSearchPaper } from '../../contracts/literature'

export interface JoinDestination {
  projectId?: string
  collectionId?: string
  path: string[]
}

export interface JoinNode extends JoinDestination {
  key: string
  name: string
  children: JoinNode[]
}

export function collectionNodes(
  collections: CardCollection[],
  projectId?: string,
  prefix: string[] = [],
  parentId?: string,
  ancestors = new Set<string>()
): JoinNode[] {
  return collections
    .filter((item) => (item.parent_id || undefined) === parentId && !ancestors.has(item.id))
    .map((item) => {
      const path = [...prefix, item.name]
      return {
        key: `collection:${item.id}`,
        name: item.name,
        collectionId: item.id,
        projectId,
        path,
        children: collectionNodes(
          collections,
          projectId,
          path,
          item.id,
          new Set([...ancestors, item.id])
        ),
      }
    })
}

export function flattenDestinations(
  nodes: JoinNode[],
  depth = 0
): Array<{ node: JoinNode; depth: number }> {
  return nodes.flatMap((node) => [
    { node, depth },
    ...flattenDestinations(node.children, depth + 1),
  ])
}

export function paperJoinKey(paper: LiteratureSearchPaper, projectId?: string): string {
  return JSON.stringify([
    projectId || '',
    paper.doi?.toLowerCase() ||
      paper.arxiv_id ||
      `${paper.title.trim().toLowerCase()}:${paper.year ?? ''}`,
  ])
}
