import {
  decodePDFRawStream,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFHexString,
  PDFRawStream,
  PDFString,
  PDFDocument as PDFLibDocument,
  PDFName,
  rgb,
  type PDFPage
} from 'pdf-lib'

import { normalizeQuads } from './geometry.ts'
import { EncryptedPdfError } from './loading.ts'
import type { PdfMark, PdfRecords, PdfRecordSnapshot } from '../api.ts'
import {
  PDF_HIGHLIGHT_OPACITY,
  PDF_MARK_RGB,
  PDF_RECORD_SCHEMA_VERSION,
  PDF_STRIKETHROUGH_THICKNESS,
  PDF_UNDERLINE_OPACITY,
  PDF_UNDERLINE_THICKNESS
} from './records.ts'
const ANNOTATIONS_ATTACHMENT_NAME = 'scholarseed-annotations.json'
const CONTENTS_KEY = PDFName.of('Contents')
const PDF_KEYS = {
  names: PDFName.of('Names'),
  embedded: PDFName.of('EmbeddedFiles'),
  kids: PDFName.of('Kids'),
  files: PDFName.of('EF'),
  stream: PDFName.of('F'),
  associated: PDFName.of('AF'),
  states: PDFName.of('ExtGState')
} as const
const PDF_PAINT_STATE_PATTERN = /\/([^\s]+) gs/g

export const PDF_EXPORT_ERROR_CODE = 'exportFailed'
export type PdfExportStage = 'load' | 'normalize' | 'draw' | 'attach' | 'save' | 'dialog'
export interface PdfExportResult { ok: boolean; canceled?: boolean; path?: string; error?: string }

export class PdfExportError extends Error {
  readonly stage: PdfExportStage
  readonly original: unknown

  constructor(stage: PdfExportStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'PdfExportError'
    this.stage = stage
    this.original = cause
  }
}

function exportFailure(stage: PdfExportStage, error: unknown): PdfExportError {
  return error instanceof PdfExportError ? error : new PdfExportError(stage, error)
}

/**
 * Normalize a page before pdf-lib appends a new content stream.
 *
 * pdf-lib normalizes a single stream to an array, but leaves an indirect entry
 * unchanged when its target cannot be represented as PDFStream. Wrapping that
 * original entry in a fresh, known PDFArray preserves it while giving
 * addContentStream the container it requires. The unknown object itself is
 * never mutated.
 */
export function normalizePageContents(page: PDFPage): void {
  const original = page.node.get(CONTENTS_KEY)
  if (!original) return

  page.node.normalize()
  const normalized = page.node.get(CONTENTS_KEY)
  if (!normalized) return
  if (page.doc.context.lookup(normalized) instanceof PDFArray) return

  const rebuilt = page.doc.context.obj([])
  rebuilt.push(normalized)
  page.node.set(CONTENTS_KEY, rebuilt)
}

function drawMarks(page: PDFPage, marks: readonly PdfMark[], normalize = true): void {
  for (const mark of marks) {
    const { width, height } = page.getSize()
    const [red, green, blue] = PDF_MARK_RGB[mark.color]
    const color = rgb(red, green, blue)
    for (const [left, top, right, bottom] of (normalize ? normalizeQuads(mark.quads) : mark.quads)) {
      if (mark.style === 'underline' || mark.style === 'strikethrough') {
        const lineY = mark.style === 'underline' ? bottom : (top + bottom) / 2
        page.drawLine({
          start: { x: left * width, y: (1 - lineY) * height },
          end: { x: right * width, y: (1 - lineY) * height },
          thickness: mark.style === 'underline' ? PDF_UNDERLINE_THICKNESS : PDF_STRIKETHROUGH_THICKNESS,
          color,
          opacity: PDF_UNDERLINE_OPACITY
        })
      } else {
        page.drawRectangle({
          x: left * width,
          y: (1 - bottom) * height,
          width: (right - left) * width,
          height: (bottom - top) * height,
          color,
          opacity: PDF_HIGHLIGHT_OPACITY
        })
      }
    }
  }
}

interface AnnotationAttachment {
  entries: PDFArray
  index: number
  file: PDFDict
}

function annotationAttachment(pdf: PDFLibDocument): AnnotationAttachment | null {
  const names = pdf.catalog.lookupMaybe(PDF_KEYS.names, PDFDict)
  const embedded = names?.lookupMaybe(PDF_KEYS.embedded, PDFDict)
  const visited = new Set<PDFDict>()
  function find(node: PDFDict | undefined): AnnotationAttachment | null {
    if (!node || visited.has(node)) return null
    visited.add(node)
    const entries = node.lookupMaybe(PDF_KEYS.names, PDFArray)
    if (entries) {
      for (let index = 0; index < entries.size(); index += 2) {
        const name = pdf.context.lookup(entries.get(index))
        if ((name instanceof PDFString || name instanceof PDFHexString)
          && name.decodeText() === ANNOTATIONS_ATTACHMENT_NAME) {
          return { entries, index, file: entries.lookup(index + 1, PDFDict) }
        }
      }
    }
    const kids = node.lookupMaybe(PDF_KEYS.kids, PDFArray)
    if (kids) {
      for (let index = 0; index < kids.size(); index += 1) {
        const result = find(kids.lookup(index, PDFDict))
        if (result) return result
      }
    }
    return null
  }
  return find(embedded)
}

function attachedRecords(pdf: PDFLibDocument): PdfRecords | null {
  try {
    const attachment = annotationAttachment(pdf)
    if (!attachment) return null
    const files = attachment.file.lookup(PDF_KEYS.files, PDFDict)
    const stream = pdf.context.lookup(files.get(PDF_KEYS.stream))
    if (!(stream instanceof PDFRawStream)) throw new Error('invalid embedded PDF attachment')
    const records: PdfRecords = JSON.parse(new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    if (records.schema_version !== PDF_RECORD_SCHEMA_VERSION || !Array.isArray(records.marks)) {
      throw new Error('invalid embedded PDF records')
    }
    return records
  } catch (error) {
    console.warn('[pdf-records] ignoring invalid embedded annotations', error)
    return null
  }
}

function removeAnnotationAttachment(pdf: PDFLibDocument): void {
  const attachment = annotationAttachment(pdf)
  if (!attachment) return
  const reference = attachment.entries.get(attachment.index + 1).toString()
  attachment.entries.remove(attachment.index + 1)
  attachment.entries.remove(attachment.index)
  const associated = pdf.catalog.lookupMaybe(PDF_KEYS.associated, PDFArray)
  if (associated) {
    for (let index = associated.size() - 1; index >= 0; index -= 1) {
      if (associated.get(index).toString() === reference) associated.remove(index)
    }
  }
}

function comparablePaint(page: PDFPage, content: string): string {
  const states = page.node.Resources()?.lookupMaybe(PDF_KEYS.states, PDFDict)
  // Resource names vary with the source PDF. Compare their full graphics-state
  // values (including opacity), rather than accepting a geometry-only match.
  return content.replace(PDF_PAINT_STATE_PATTERN, (operator, name: string) => {
    const state = states?.lookupMaybe(PDFName.of(name), PDFDict)
    if (!state) return operator
    return state.entries().map(([key, value]) =>
      `${key.toString()}=${page.doc.context.lookup(value)?.toString()}`
    ).sort().join(';') + ' gs'
  })
}

/** Remove only the final, exactly matching ScholarSeed paint stream in memory.
 * Existing exports have no marker: match the complete regenerated instructions
 * and graphics states against their canonical embedded records. Original PDF
 * content and the on-disk file are never rewritten by the viewer.
 */
export async function restoreAnnotatedPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFLibDocument.load(bytes, { ignoreEncryption: true })
  if (pdf.isEncrypted) throw new EncryptedPdfError()
  const records = attachedRecords(pdf)
  if (!records?.marks.length) return bytes
  const template = await PDFLibDocument.create()
  let changed = false
  for (const [index, page] of pdf.getPages().entries()) {
    const marks = records.marks.filter(mark => mark.anchor_state === 'anchored' && mark.page === index + 1)
    if (!marks.length) continue
    const contents = pdf.context.lookup(page.node.get(CONTENTS_KEY))
    if (!(contents instanceof PDFArray) || !contents.size()) continue
    const last = pdf.context.lookup(contents.get(contents.size() - 1))
    if (!(last instanceof PDFRawStream)) continue
    const actualContent = new TextDecoder().decode(decodePDFRawStream(last).decode())
    let matches = false
    // Both historical raw quads and current normalized quads are supported.
    for (const normalize of [true, false]) {
      const expected = template.addPage([page.getWidth(), page.getHeight()])
      drawMarks(expected, marks, normalize)
      const expectedStreams = expected.node.lookup(CONTENTS_KEY, PDFArray)
      const expectedStream = template.context.lookup(expectedStreams.get(expectedStreams.size() - 1))
      if (!(expectedStream instanceof PDFContentStream)) throw new Error('missing PDF paint stream')
      const expectedContent = new TextDecoder().decode(expectedStream.getUnencodedContents())
      if (comparablePaint(page, actualContent) === comparablePaint(expected, expectedContent)) {
        matches = true
        break
      }
    }
    if (!matches) continue
    contents.remove(contents.size() - 1)
    changed = true
  }
  return changed ? pdf.save() : bytes
}

export async function buildAnnotatedPdf(
  bytes: Uint8Array,
  records: PdfRecordSnapshot,
  attachmentDescription: string
): Promise<Uint8Array> {
  let pdf: PDFLibDocument
  try {
    pdf = await PDFLibDocument.load(await restoreAnnotatedPdf(bytes))
  } catch (error) {
    throw exportFailure('load', error)
  }
  const pages = pdf.getPages()
  const anchored = records.records.marks.filter((mark) => mark.anchor_state === 'anchored')

  try {
    const markedPages = new Set(anchored.map((mark) => mark.page - 1))
    for (const pageIndex of markedPages) {
      const page = pages[pageIndex]
      if (page) normalizePageContents(page)
    }
  } catch (error) {
    throw exportFailure('normalize', error)
  }

  try {
    for (const [index, page] of pages.entries()) {
      drawMarks(page, anchored.filter(mark => mark.page === index + 1))
    }
  } catch (error) {
    throw exportFailure('draw', error)
  }

  try {
    removeAnnotationAttachment(pdf)
    const attachment = new TextEncoder().encode(JSON.stringify({
        schema_version: PDF_RECORD_SCHEMA_VERSION,
        marks: anchored,
        comments: records.records.comments.filter((comment) =>
          anchored.some((mark) => mark.id === comment.mark_id)
        ),
        notes: records.records.notes.map((note) => ({
          ...note,
          excerpts: note.excerpts.filter((excerpt) =>
            anchored.some((mark) => mark.id === excerpt.mark_id)
          )
        }))
      }, null, 2))
    await pdf.attach(
      attachment,
      ANNOTATIONS_ATTACHMENT_NAME,
      { mimeType: 'application/json', description: attachmentDescription }
    )
  } catch (error) {
    throw exportFailure('attach', error)
  }

  try {
    return await pdf.save()
  } catch (error) {
    throw exportFailure('save', error)
  }
}

export async function exportAnnotatedPdf(
  bytes: Uint8Array,
  records: PdfRecordSnapshot,
  suggestedName: string,
  attachmentDescription: string
): Promise<PdfExportResult> {
  const exported = await buildAnnotatedPdf(bytes, records, attachmentDescription)
  try {
    const bridge = window.scholarseed
    if (!bridge) throw new Error('desktop save bridge unavailable')
    const result = await bridge.saveFileCopy({ suggestedName, bytes: exported })
    if (!result.ok && !result.canceled) throw new Error(result.error || 'save copy failed')
    return result
  } catch (error) {
    throw exportFailure('dialog', error)
  }
}
