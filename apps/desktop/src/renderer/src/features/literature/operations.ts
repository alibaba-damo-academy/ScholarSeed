import { CARD_OPERATIONS, type LiteratureCardPorts } from './ports.ts'

const INVALID_REQUEST = 'plugin_card_request_invalid'
const PARAMETERS: Record<string, readonly string[]> = {
  [CARD_OPERATIONS.openSource]: ['refId'],
  [CARD_OPERATIONS.addReference]: ['refId', 'collectionId'],
  [CARD_OPERATIONS.collections]: ['projectId'],
  [CARD_OPERATIONS.createCollection]: ['name', 'parentId'],
  [CARD_OPERATIONS.openResults]: [],
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
