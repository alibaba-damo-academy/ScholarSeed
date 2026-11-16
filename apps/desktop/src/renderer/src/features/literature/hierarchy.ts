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

export function joinCollectionOptions(
  globalCollections: CardCollection[],
  projectCollections: CardCollection[],
  projectId: string | undefined,
  labels: { global: string; project: string }
): Array<JoinDestination & { key: string; label: string }> {
  return [
    ...flattenDestinations(collectionNodes(globalCollections, undefined, [labels.global])),
    ...flattenDestinations(collectionNodes(projectCollections, projectId, [labels.project])),
  ].map(({ node }) => ({
    key: JSON.stringify([node.projectId, node.collectionId]),
    label: node.path.join(' / '),
    path: node.path.slice(1),
    collectionId: node.collectionId,
    projectId: node.projectId,
  }))
}

export function paperJoinKey(paper: LiteratureSearchPaper, projectId?: string): string {
  return JSON.stringify([
    projectId || '',
    paper.doi?.toLowerCase() ||
      paper.arxiv_id ||
      `${paper.title.trim().toLowerCase()}:${paper.year ?? ''}`,
  ])
}
