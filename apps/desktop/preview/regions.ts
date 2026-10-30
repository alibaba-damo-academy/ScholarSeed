import { PDFDocument } from 'pdf-lib'
import type { PreviewFileContent } from './files.ts'
import type { PdfVisualRegionManifest } from '../src/renderer/src/features/workbench/pdf/analysis.ts'

const REGION = { schemaVersion: 1, detectorVersion: 'preview-unavailable', coordinateSpace: 'pdfjs_normalized' } as const

export class PreviewRegionError extends Error {
  readonly status: number

  constructor(code: string, status: number) {
    super(code)
    this.status = status
  }
}

export async function previewPdfRegions(file: PreviewFileContent, mediaType: string, revision: string | null, start: string | null, end: string | null): Promise<PdfVisualRegionManifest> {
  if (revision !== file.revision) throw new PreviewRegionError('source_revision_conflict', 409)
  if (mediaType !== 'application/pdf') throw new PreviewRegionError('pdf_source_invalid', 415)
  const startPage = start !== null && /^\d+$/.test(start) ? Number(start) : NaN
  const endPage = end !== null && /^\d+$/.test(end) ? Number(end) : NaN
  if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage) || startPage < 1 || endPage < startPage) throw new PreviewRegionError('literature_page_range_invalid', 422)
  let document: PDFDocument
  try { document = await PDFDocument.load(file.bytes) }
  catch { throw new PreviewRegionError('pdf_parse_failed', 422) }
  const pageCount = document.getPageCount()
  if (pageCount < 1) throw new PreviewRegionError('pdf_no_pages', 422)
  if (endPage > pageCount) throw new PreviewRegionError('literature_page_range_invalid', 422)
  const pages = Array.from({ length: endPage - startPage + 1 }, (_, index) => ({ page: startPage + index, unavailable: true, regions: [] }))
  return { schema_version: REGION.schemaVersion, detector_version: REGION.detectorVersion, coordinate_space: REGION.coordinateSpace, source_revision: file.revision, page_count: pageCount, unavailable_pages: pages.map(page => page.page), pages }
}
