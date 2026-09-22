import sampleUrl from './assets/sample.pdf?url'
import { registerBuiltinDocument, type BuiltinDocumentSource } from '../workbench/builtin'

export const SAMPLE_SOURCE: BuiltinDocumentSource = {
  kind: 'builtin', id: 'onboarding-v1', path: 'onboarding-sample.pdf', mediaType: 'application/pdf', renderKind: 'pdf'
}
// Local packaged bytes only. Opening a sample never calls a literature import API.
registerBuiltinDocument(SAMPLE_SOURCE.id, async source => {
  const response = await fetch(sampleUrl)
  if (!response.ok) throw new Error('onboarding_sample_unavailable')
  return {
    documentId: `builtin:${source.id}`, source, viewer: 'pdf',
    processor: null,
    capabilities: { can_preview: true, can_edit: false, can_select: true, can_annotate: false, can_save: false, can_version: false, can_diff: false, pending: [] },
    revision: source.id, mediaType: 'application/pdf', contentKind: 'binary',
    bytes: new Uint8Array(await response.arrayBuffer()), versioning: null
  }
})
