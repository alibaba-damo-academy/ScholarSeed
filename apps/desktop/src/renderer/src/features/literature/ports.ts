export interface CardCollection {
  id: string
  name: string
  project_id?: string | null
  parent_id?: string | null
}

export const CARD_OPERATIONS = {
  openSource: 'open-source',
  addReference: 'add-reference',
  collections: 'collections',
  createCollection: 'create-collection',
  openResults: 'open-results',
  openArtifact: 'open-artifact',
} as const

export const CARD_CAPABILITIES: Record<string, string> = {
  [CARD_OPERATIONS.openSource]: 'navigation.open',
  [CARD_OPERATIONS.openResults]: 'navigation.open',
  [CARD_OPERATIONS.openArtifact]: 'navigation.open',
  [CARD_OPERATIONS.addReference]: 'literature.write',
  [CARD_OPERATIONS.createCollection]: 'literature.write',
  [CARD_OPERATIONS.collections]: 'literature.read',
}

export const CARD_ALLOWED_OPERATIONS: Record<string, readonly string[]> = {
  'literature-search': [CARD_OPERATIONS.openResults, CARD_OPERATIONS.openSource],
  'literature-review': [
    CARD_OPERATIONS.openArtifact,
    CARD_OPERATIONS.openResults,
    CARD_OPERATIONS.openSource,
  ],
}

export interface LiteratureCardPorts {
  projectId?: string
  projectName?: string
  projects?: readonly { id: string; name: string }[]
  openSource: (refId: string) => Promise<void>
  addReference: (refId: string, collectionId: string) => Promise<{ id: string }>
  collections: (projectId?: string) => Promise<CardCollection[]>
  createCollection: (name: string, parentId?: string) => Promise<CardCollection>
  openResults: () => Promise<void>
  openArtifact: (artifactId: string) => Promise<void>
}

export type CardRequest = <Result>(
  action: string,
  values?: Record<string, unknown>
) => Promise<Result>

export function cardPorts(
  request: CardRequest,
  scope: Pick<LiteratureCardPorts, 'projectId' | 'projectName' | 'projects'>
): LiteratureCardPorts {
  return {
    ...scope,
    openSource: (refId) => request(CARD_OPERATIONS.openSource, { refId }),
    addReference: (refId, collectionId) =>
      request(CARD_OPERATIONS.addReference, { refId, collectionId }),
    collections: (projectId) =>
      request(CARD_OPERATIONS.collections, projectId === undefined ? {} : { projectId }),
    createCollection: (name, parentId) =>
      request(CARD_OPERATIONS.createCollection, { name, ...(parentId ? { parentId } : {}) }),
    openResults: () => request(CARD_OPERATIONS.openResults),
    openArtifact: (artifactId) => request(CARD_OPERATIONS.openArtifact, { artifactId }),
  }
}
