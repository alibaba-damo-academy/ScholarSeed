import type { DocumentLoadResult, LoadedDocument } from './api'

/** Explicitly registered packaged documents; never a path into a user's library. */
export interface BuiltinDocumentSource {
  kind: 'builtin'
  id: string
  path: string
  mediaType?: string
  renderKind?: string
  revision?: string
}
type BuiltinLoader = (source: BuiltinDocumentSource) => Promise<LoadedDocument>
const documents = new Map<string, BuiltinLoader>()
export function registerBuiltinDocument(id: string, loader: BuiltinLoader): void { documents.set(id, loader) }
export async function loadBuiltinDocument(source: BuiltinDocumentSource): Promise<DocumentLoadResult> {
  const loader = documents.get(source.id)
  if (!loader) throw new Error('builtin_document_unregistered')
  return loader(source)
}
