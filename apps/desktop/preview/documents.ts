import type { DocumentProcessorKind, ViewerKind } from '../src/renderer/src/contracts/workbench.ts'

export interface PreviewDocumentFormat {
  readonly viewer: ViewerKind
  readonly processor: DocumentProcessorKind | null
  readonly mediaType: string
  readonly editable: boolean
  readonly selectable: boolean
}

export interface ReviewedPreviewDocument extends PreviewDocumentFormat {
  readonly path: string
  readonly source: string
  readonly sha256: string
  readonly viewKind: 'preview' | 'source'
  readonly revisions?: readonly { readonly source: string; readonly sha256: string }[]
}

export const PREVIEW_DOCUMENTS: readonly ReviewedPreviewDocument[] = [
  { path: 'readme.md', source: '../e2e/fixtures/data/minimal-project/readme.md', sha256: '12c94652feb004036a1dc347801d28c2acaff69d91f54c71c0bb0302051024ea', viewer: 'markdown', processor: null, mediaType: 'text/markdown', editable: true, selectable: true, viewKind: 'preview', revisions: [{ source: './fixtures/readme.modified.md', sha256: '05c692d914fe571d730a168447185c9b38580e1ed1cc6f5fa0f1f652166a853d' }] },
  { path: 'hello.py', source: '../e2e/fixtures/data/minimal-project/hello.py', sha256: '92d4089d5dcacf64242b632c8fea8bac156cdb2dffa43291a7eaca46c32aef5d', viewer: 'code', processor: null, mediaType: 'text/x-python', editable: true, selectable: true, viewKind: 'source' },
  { path: 'sample.pdf', source: '../e2e/fixtures/data/minimal-project/sample.pdf', sha256: 'bd951b9a15d79e9127a62db8442bd7c097fbcfe03ec931ca2bf4e20ce959ed84', viewer: 'pdf', processor: null, mediaType: 'application/pdf', editable: false, selectable: true, viewKind: 'preview' },
  { path: 'sample.png', source: '../src/renderer/src/assets/icon-img.png', sha256: 'b4ea33b5116aed5f76a397e7c9cf1f1e1a2ddeeeb61c168c8022214e6b36dc87', viewer: 'image', processor: null, mediaType: 'image/png', editable: false, selectable: false, viewKind: 'preview' },
  { path: 'sample.docx', source: '../e2e/fixtures/office-corpus/docx/selection-large.docx', sha256: 'b810f64cbfb18bc61936d489f38d9a344eb6128ef4a10a47df73eda9c01059cf', viewer: 'office', processor: null, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', editable: false, selectable: true, viewKind: 'preview' },
  { path: 'sample.xls', source: '../e2e/fixtures/office-corpus/xls/selection-100-rows.xls', sha256: '9fa9ee7ef2d8382b566fdb05d6de479935b1a8d13bd5eec02f9b21fdda75ce5a', viewer: 'office', processor: 'xls', mediaType: 'application/vnd.ms-excel', editable: false, selectable: true, viewKind: 'preview' },
  { path: 'measurements.csv', source: './fixtures/measurements.csv', sha256: 'd9a8738f7363758f178e75b0a303a27a6c6f534bbeb38209d8051c4c3fdd923d', viewer: 'spreadsheet', processor: 'csv', mediaType: 'text/csv', editable: true, selectable: true, viewKind: 'preview' },
  { path: 'measurements.tsv', source: './fixtures/measurements.tsv', sha256: '142750dab12469105fe261dde981cfe053b359ae5c90431ba9d1a3bbcea6ddfe', viewer: 'table', processor: null, mediaType: 'text/tab-separated-values', editable: false, selectable: false, viewKind: 'preview' },
  { path: 'sample.bin', source: '../e2e/fixtures/data/minimal-project/sample.pdf', sha256: 'bd951b9a15d79e9127a62db8442bd7c097fbcfe03ec931ca2bf4e20ce959ed84', viewer: 'unsupported', processor: null, mediaType: 'application/octet-stream', editable: false, selectable: false, viewKind: 'preview' },
]
