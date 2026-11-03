import type { LiteratureDeliveryBatch, LiteratureDeliveryChoice } from '../../contracts/literature'
import type { DestinationNode } from '../../components/business/Destination'

export interface CardCollection {
  id: string
  name: string
  project_id?: string | null
  parent_id?: string | null
}

export interface CardDirectory {
  resourceRoot: string
  nodes: DestinationNode[]
  total: number
  offset: number
}

export interface CardNativeReply {
  ok: boolean
  canceled?: boolean
  ticket?: string
  label?: string
  value?: LiteratureDeliveryBatch
}

export const CARD_OPERATIONS = {
  openSource: 'open-source',
  addReference: 'add-reference',
  collections: 'collections',
  createCollection: 'create-collection',
  openResults: 'open-results',
  openFulltext: 'open-fulltext',
  openLibrary: 'open-library',
  delivery: 'delivery',
  folders: 'folders',
  pickDirectory: 'pick-directory',
  save: 'save',
  cancel: 'cancel',
  openDirectory: 'open-directory',
  openArtifact: 'open-artifact',
} as const

export const CARD_CAPABILITIES: Record<string, string> = {
  [CARD_OPERATIONS.openSource]: 'navigation.open',
  [CARD_OPERATIONS.openResults]: 'navigation.open',
  [CARD_OPERATIONS.openFulltext]: 'navigation.open',
  [CARD_OPERATIONS.openLibrary]: 'navigation.open',
  [CARD_OPERATIONS.openDirectory]: 'navigation.open',
  [CARD_OPERATIONS.openArtifact]: 'navigation.open',
  [CARD_OPERATIONS.addReference]: 'literature.write',
  [CARD_OPERATIONS.createCollection]: 'literature.write',
  [CARD_OPERATIONS.save]: 'literature.write',
  [CARD_OPERATIONS.cancel]: 'literature.write',
  [CARD_OPERATIONS.collections]: 'literature.read',
  [CARD_OPERATIONS.delivery]: 'literature.read',
  [CARD_OPERATIONS.folders]: 'literature.read',
  [CARD_OPERATIONS.pickDirectory]: 'literature.write',
}

export const CARD_ALLOWED_OPERATIONS: Record<string, readonly string[]> = {
  'literature-search': [CARD_OPERATIONS.openResults],
  'literature-references': [
    CARD_OPERATIONS.openSource,
    CARD_OPERATIONS.addReference,
    CARD_OPERATIONS.collections,
    CARD_OPERATIONS.createCollection,
  ],
  'literature-downloads': [CARD_OPERATIONS.openFulltext, CARD_OPERATIONS.openLibrary],
  'literature-delivery': [
    CARD_OPERATIONS.delivery,
    CARD_OPERATIONS.folders,
    CARD_OPERATIONS.collections,
    CARD_OPERATIONS.pickDirectory,
    CARD_OPERATIONS.save,
    CARD_OPERATIONS.cancel,
    CARD_OPERATIONS.openDirectory,
    CARD_OPERATIONS.openLibrary,
  ],
  'literature-review': [CARD_OPERATIONS.openArtifact],
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
  openFulltext: (paperId: string) => Promise<boolean>
  openLibrary: (paperId?: string) => Promise<void>
  delivery: () => Promise<LiteratureDeliveryBatch>
  folders: (parent?: string, offset?: number, projectId?: string) => Promise<CardDirectory | null>
  pickDirectory: () => Promise<CardNativeReply>
  save: (choice: LiteratureDeliveryChoice) => Promise<CardNativeReply>
  cancel: () => Promise<LiteratureDeliveryBatch>
  openDirectory: () => Promise<CardNativeReply>
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
    openFulltext: (paperId) => request(CARD_OPERATIONS.openFulltext, { paperId }),
    openLibrary: (paperId) => request(CARD_OPERATIONS.openLibrary, paperId ? { paperId } : {}),
    delivery: () => request(CARD_OPERATIONS.delivery),
    folders: (parent = '', offset = 0, projectId) =>
      request(CARD_OPERATIONS.folders, {
        parent,
        offset,
        ...(projectId === undefined ? {} : { projectId }),
      }),
    pickDirectory: () => request(CARD_OPERATIONS.pickDirectory),
    save: (choice) => request(CARD_OPERATIONS.save, { choice }),
    cancel: () => request(CARD_OPERATIONS.cancel),
    openDirectory: () => request(CARD_OPERATIONS.openDirectory),
    openArtifact: (artifactId) => request(CARD_OPERATIONS.openArtifact, { artifactId }),
  }
}
