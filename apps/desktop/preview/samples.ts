import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { CsvModel } from '../src/renderer/src/features/workbench/csv/model.ts'
import type { ContentKind } from '../src/renderer/src/contracts/workbench.ts'
import { PREVIEW_DOCUMENTS } from './documents.ts'
import type { PreviewDocumentFormat, ReviewedPreviewDocument } from './documents.ts'

const MINIMAL_ROOT = new URL('../e2e/fixtures/data/minimal-project/', import.meta.url)
const MINIMAL_SOURCE = '../e2e/fixtures/data/minimal-project/'
const CORPUS_ROOT = new URL('../e2e/fixtures/office-corpus/', import.meta.url)
const CORPUS_SOURCE = '../e2e/fixtures/office-corpus/'
const BINARY_UNSUPPORTED = 'binary_preview_unsupported'
const CSV_UNSAFE = 'spreadsheet_unsafe_roundtrip'
const DECODER = new TextDecoder('utf-8', { fatal: true })

export function verifyReviewedSample(document: ReviewedPreviewDocument, bytes: Uint8Array): void {
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== document.sha256) throw new Error(`Preview sample hash mismatch: ${document.path}`)
}

export function loadReviewedSamples(): readonly { document: ReviewedPreviewDocument; bytes: Uint8Array }[] {
  const descriptor = JSON.parse(readFileSync(new URL('scenario.json', MINIMAL_ROOT), 'utf8')) as { project: { files: { path: string; contentFrom: string }[] } }
  const minimal = PREVIEW_DOCUMENTS.filter(document => document.source.startsWith(MINIMAL_SOURCE) && document.source.endsWith(document.path))
  if (descriptor.project.files.length !== minimal.length || minimal.some(document => !descriptor.project.files.some(entry => entry.path === document.path && entry.contentFrom === `minimal-project/${document.path}`))) throw new Error('Preview minimal-project descriptor does not match the reviewed inventory')
  const corpus = JSON.parse(readFileSync(new URL('manifest.json', CORPUS_ROOT), 'utf8')) as { files: Record<string, string> }
  return PREVIEW_DOCUMENTS.map(document => {
    if (document.source.startsWith(CORPUS_SOURCE) && corpus.files[document.source.slice(CORPUS_SOURCE.length)] !== document.sha256) throw new Error(`Preview Office corpus manifest mismatch: ${document.path}`)
    const bytes = new Uint8Array(readFileSync(new URL(document.source, import.meta.url)))
    verifyReviewedSample(document, bytes)
    return { document, bytes }
  })
}

export function loadReviewedRevisions(): readonly { path: string; bytes: Uint8Array }[] {
  return PREVIEW_DOCUMENTS.flatMap(document => (document.revisions ?? []).map(revision => {
    const bytes = new Uint8Array(readFileSync(new URL(revision.source, import.meta.url)))
    verifyReviewedSample({ ...document, ...revision }, bytes)
    return { path: document.path, bytes }
  }))
}

export function previewDocumentFormat(path: string, bytes: Uint8Array): PreviewDocumentFormat & { contentKind: ContentKind; pending: string[] } {
  let contentKind: ContentKind = 'text'
  if (bytes.includes(0)) contentKind = 'binary'
  else {
    try { DECODER.decode(bytes) }
    catch { contentKind = 'binary' }
  }
  const suffix = path.toLowerCase().split('.').at(-1)
  const registered = PREVIEW_DOCUMENTS.find(document => document.path.split('.').at(-1) === suffix && document.viewer !== 'unsupported')
  const unsupported: PreviewDocumentFormat = { viewer: 'unsupported', processor: null, mediaType: 'application/octet-stream', editable: false, selectable: false }
  if (!registered) return contentKind === 'text'
    ? { viewer: 'code', processor: null, mediaType: 'text/plain', editable: true, selectable: true, contentKind, pending: [] }
    : { ...unsupported, contentKind, pending: [BINARY_UNSUPPORTED] }
  if ((registered.viewer === 'markdown' || registered.viewer === 'code') && contentKind === 'binary') return { ...unsupported, contentKind, pending: [BINARY_UNSUPPORTED] }
  if (registered.processor === 'csv') {
    try { new CsvModel(bytes, 'preview-inspection') }
    catch { return { ...registered, editable: false, contentKind, pending: [CSV_UNSAFE] } }
  }
  return { ...registered, contentKind, pending: [] }
}
