import { CARD_OPERATIONS, type LiteratureCardPorts } from './ports.ts'

const INVALID_REQUEST = 'plugin_card_request_invalid'
const CONFLICT_DECISIONS = new Set(['keep_both', 'skip'])
const PARAMETERS: Record<string, readonly string[]> = {
  [CARD_OPERATIONS.openSource]: ['refId'],
  [CARD_OPERATIONS.addReference]: ['refId', 'collectionId'],
  [CARD_OPERATIONS.collections]: ['projectId'],
  [CARD_OPERATIONS.createCollection]: ['name', 'parentId'],
  [CARD_OPERATIONS.openResults]: [],
  [CARD_OPERATIONS.openFulltext]: ['paperId'],
  [CARD_OPERATIONS.openLibrary]: ['paperId'],
  [CARD_OPERATIONS.delivery]: [],
  [CARD_OPERATIONS.folders]: ['parent', 'offset', 'projectId'],
  [CARD_OPERATIONS.pickDirectory]: [],
  [CARD_OPERATIONS.save]: ['choice'],
  [CARD_OPERATIONS.cancel]: [],
  [CARD_OPERATIONS.openDirectory]: [],
  [CARD_OPERATIONS.openArtifact]: ['artifactId'],
}

export function cardRequest(
  ports: LiteratureCardPorts
): (action: string, values: Record<string, unknown>) => Promise<unknown> {
  const text = (values: Record<string, unknown>, key: string): string => {
    if (typeof values[key] !== 'string') throw new Error(INVALID_REQUEST)
    return values[key]
  }
  const handlers: Record<string, (values: Record<string, unknown>) => Promise<unknown>> = {
    [CARD_OPERATIONS.openSource]: (values) => ports.openSource(text(values, 'refId')),
    [CARD_OPERATIONS.addReference]: (values) =>
      ports.addReference(text(values, 'refId'), text(values, 'collectionId')),
    [CARD_OPERATIONS.collections]: (values) =>
      ports.collections(values.projectId === undefined ? undefined : text(values, 'projectId')),
    [CARD_OPERATIONS.createCollection]: (values) =>
      ports.createCollection(
        text(values, 'name'),
        values.parentId === undefined ? undefined : text(values, 'parentId')
      ),
    [CARD_OPERATIONS.openResults]: () => ports.openResults(),
    [CARD_OPERATIONS.openFulltext]: (values) => ports.openFulltext(text(values, 'paperId')),
    [CARD_OPERATIONS.openLibrary]: (values) =>
      ports.openLibrary(values.paperId === undefined ? undefined : text(values, 'paperId')),
    [CARD_OPERATIONS.delivery]: () => ports.delivery(),
    [CARD_OPERATIONS.folders]: (values) => {
      if (!Number.isSafeInteger(values.offset) || (values.offset as number) < 0)
        throw new Error(INVALID_REQUEST)
      return ports.folders(
        text(values, 'parent'),
        values.offset as number,
        values.projectId === undefined ? undefined : text(values, 'projectId')
      )
    },
    [CARD_OPERATIONS.pickDirectory]: () => ports.pickDirectory(),
    [CARD_OPERATIONS.save]: (values) => {
      const choice = values.choice
      if (!choice || typeof choice !== 'object' || Array.isArray(choice))
        throw new Error(INVALID_REQUEST)
      const input = choice as Record<string, unknown>
      if (
        Object.keys(input).some(
          (key) =>
            ![
              'target',
              'project_id',
              'parent',
              'ticket',
              'add_to_library',
              'collection_id',
              'versions',
            ].includes(key)
        ) ||
        (input.project_id !== undefined && typeof input.project_id !== 'string') ||
        !['project', 'directory'].includes(String(input.target)) ||
        typeof input.add_to_library !== 'boolean' ||
        ['parent', 'ticket', 'collection_id'].some((key) => typeof input[key] !== 'string')
      )
        throw new Error(INVALID_REQUEST)
      if (
        input.versions !== undefined &&
        (!input.versions ||
          typeof input.versions !== 'object' ||
          Array.isArray(input.versions) ||
          Object.values(input.versions).some(
            (decision) => typeof decision !== 'string' || !CONFLICT_DECISIONS.has(decision)
          ))
      )
        throw new Error(INVALID_REQUEST)
      return ports.save(choice as Parameters<LiteratureCardPorts['save']>[0])
    },
    [CARD_OPERATIONS.cancel]: () => ports.cancel(),
    [CARD_OPERATIONS.openDirectory]: () => ports.openDirectory(),
    [CARD_OPERATIONS.openArtifact]: (values) => ports.openArtifact(text(values, 'artifactId')),
  }
  return async (action, values) => {
    if (
      !Object.prototype.hasOwnProperty.call(handlers, action) ||
      Object.keys(values).some((key) => !PARAMETERS[action].includes(key))
    )
      throw new Error(INVALID_REQUEST)
    return handlers[action](values)
  }
}
