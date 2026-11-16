import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  rgb,
  StandardFonts,
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

import type { PdfMark, PdfRecordSnapshot } from '../api.ts'
import type { PdfTextMarkStyle } from '../../../contracts/workbench.ts'
import {
  buildAnnotatedPdf as buildAnnotatedPdfSource,
  restoreAnnotatedPdf,
  exportAnnotatedPdf,
  PdfExportError,
} from './export.ts'
import { PDF_HIGHLIGHT_OPACITY, PDF_MARK_PALETTE, PDF_RECORD_SCHEMA_VERSION } from './records.ts'

const REAL_BROKEN_PDF = new URL(
  '../../../../../../e2e/fixtures/preview_pdf_1MB.pdf',
  import.meta.url
)
const PAGE_SIZE: [number, number] = [612, 792]
const CONTENTS_KEY = PDFName.of('Contents')
const ANNOTATIONS_NAME = 'scholarseed-annotations.json'
const ATTACHMENT_DESCRIPTION = 'ScholarSeed PDF annotations'
const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

function buildAnnotatedPdf(bytes: Uint8Array, records: PdfRecordSnapshot): Promise<Uint8Array> {
  return buildAnnotatedPdfSource(bytes, records, ATTACHMENT_DESCRIPTION)
}

function snapshot(marks: PdfMark[] = []): PdfRecordSnapshot {
  return {
    record_target: { owner: 'project_asset', scope_id: 'fixture', subject_id: 'fixture-asset' },
    record_revision: 'fixture-record',
    source_revision: 'fixture-source',
    source_state: 'available',
    source_path: 'fixture.pdf',
    records: { schema_version: PDF_RECORD_SCHEMA_VERSION, marks, comments: [], notes: [] },
  }
}

function mark(
  id: string,
  color: PdfMark['color'],
  style: PdfTextMarkStyle = 'highlight',
  quads: number[][] = [[0.1, 0.1, 0.3, 0.15]]
): PdfMark {
  return {
    id,
    color,
    style,
    page: 1,
    quads,
    text: id,
    anchor_state: 'anchored',
    created_at: 1,
    updated_at: 1,
  }
}

async function sourcePdf(contents: 'array' | 'stream' | 'missing' = 'array'): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const image = await pdf.embedPng(PNG_PIXEL)
  const page = pdf.addPage(PAGE_SIZE)
  if (contents !== 'missing') {
    page.drawText('Searchable source text', { x: 72, y: 700, size: 18, font })
    page.drawImage(image, { x: 72, y: 620, width: 24, height: 24 })
    if (contents === 'stream') {
      const streams = page.node.lookup(CONTENTS_KEY, PDFArray)
      page.node.set(CONTENTS_KEY, streams.get(0))
    }
  }
  return pdf.save()
}

function pageContent(pdf: PDFDocument): string {
  const contents = pdf.getPage(0).node.normalizedEntries().Contents
  if (!contents) return ''
  const chunks: Uint8Array[] = []
  for (let index = 0; index < contents.size(); index += 1) {
    const stream = pdf.context.lookup(contents.get(index))
    if (stream instanceof PDFRawStream) chunks.push(decodePDFRawStream(stream).decode())
    else if (stream instanceof PDFContentStream) chunks.push(stream.getUnencodedContents())
  }
  return chunks.map((chunk) => Buffer.from(chunk).toString('latin1')).join('\n')
}

function annotationPayload(pdf: PDFDocument): unknown {
  const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict)
  const embedded = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict)
  const entries = embedded.lookup(PDFName.of('Names'), PDFArray)
  for (let index = 0; index < entries.size(); index += 2) {
    const rawName = entries.get(index)
    const name =
      rawName instanceof PDFString || rawName instanceof PDFHexString
        ? rawName.decodeText()
        : rawName.toString()
    if (name === ANNOTATIONS_NAME) {
      const file = entries.lookup(index + 1, PDFDict)
      const files = file.lookup(PDFName.of('EF'), PDFDict)
      const stream = pdf.context.lookup(files.get(PDFName.of('F')))
      if (!(stream instanceof PDFRawStream))
        throw new Error('annotation attachment stream is missing')
      return JSON.parse(Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8'))
    }
  }
  return null
}

test('export normalizes missing, single-stream, array and the real invalid Contents entry', async () => {
  for (const contents of ['missing', 'stream', 'array'] as const) {
    const output = await buildAnnotatedPdf(
      await sourcePdf(contents),
      snapshot([mark(contents, 'yellow')])
    )
    assert.equal((await PDFDocument.load(output)).getPageCount(), 1)
  }

  const input = readFileSync(REAL_BROKEN_PDF)
  const before = createHash('sha256').update(input).digest('hex')
  const output = await buildAnnotatedPdf(input, snapshot([mark('real', 'yellow')]))
  assert.equal((await PDFDocument.load(output)).getPageCount(), 1)
  const task = getDocument({ data: Uint8Array.from(output) })
  const document = await task.promise
  const text = await (await document.getPage(1)).getTextContent()
  assert.match(
    text.items.map((item) => ('str' in item ? item.str : '')).join(' '),
    /PDF Preview Test/
  )
  await task.destroy()
  assert.equal(createHash('sha256').update(readFileSync(REAL_BROKEN_PDF)).digest('hex'), before)
})

test('point comments paint a visible pin and roundtrip without inventing source text or accumulating paint', async () => {
  const original = await sourcePdf()
  const point: PdfMark = {
    id: 'page-comment',
    style: 'comment',
    color: 'green',
    page: 1,
    point: [0.25, 0.5],
    quads: [],
    text: '',
    anchor_state: 'anchored',
    created_at: 1,
    updated_at: 1,
  }
  const records = snapshot([point])
  records.records.comments.push({
    id: 'comment-body',
    mark_id: point.id,
    body: 'Local page comment',
    created_at: 1,
  })
  const first = await buildAnnotatedPdf(original, records)
  const firstDocument = await PDFDocument.load(first)
  assert.match(pageContent(firstDocument), / c\n/)
  assert.deepEqual(annotationPayload(firstDocument), records.records)
  const secondDocument = await PDFDocument.load(await buildAnnotatedPdf(first, records))
  assert.equal(Array.from(pageContent(secondDocument).matchAll(/ c\n/g)).length, 4)
  assert.equal(Array.from(pageContent(secondDocument).matchAll(/0.35 0.78 0.47 rg/g)).length, 1)
  assert.deepEqual(annotationPayload(secondDocument), records.records)
  const restored = await PDFDocument.load(await restoreAnnotatedPdf(first))
  assert.ok(pageContent(restored).includes(pageContent(await PDFDocument.load(original))))
  assert.doesNotMatch(pageContent(restored), / c\n/)
})

test('export preserves pages, dimensions, searchable text and images without rasterizing pages', async () => {
  const output = await buildAnnotatedPdf(await sourcePdf(), snapshot())
  const reopened = await PDFDocument.load(output)
  assert.equal(reopened.getPageCount(), 1)
  assert.deepEqual(reopened.getPage(0).getSize(), { width: PAGE_SIZE[0], height: PAGE_SIZE[1] })

  const task = getDocument({ data: Uint8Array.from(output) })
  const document = await task.promise
  const page = await document.getPage(1)
  const text = await page.getTextContent()
  const operators = await page.getOperatorList()
  assert.match(
    text.items.map((item) => ('str' in item ? item.str : '')).join(' '),
    /Searchable source text/
  )
  assert.ok(
    operators.fnArray.some((operator) => operator === 85 || operator === 86),
    'embedded image operator must remain'
  )
  await task.destroy()
})

test('export writes all eight highlight colors, underline and strikethrough geometry, and matching opacity', async () => {
  const highlights = PDF_MARK_PALETTE.map((entry, index) =>
    mark(`highlight-${entry.name}`, entry.name, 'highlight', [
      [0.05 + index * 0.1, 0.1, 0.1 + index * 0.1, 0.13],
    ])
  )
  const underline = mark('underline', 'blue', 'underline', [[0.2, 0.3, 0.6, 0.32]])
  const strikethrough = mark('strikethrough', 'red', 'strikethrough', [[0.2, 0.4, 0.6, 0.44]])
  const output = await buildAnnotatedPdf(
    await sourcePdf(),
    snapshot([...highlights, underline, strikethrough])
  )
  const reopened = await PDFDocument.load(output)
  const content = pageContent(reopened)
  const fillColors = Array.from(content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g), (match) =>
    match.slice(1).map(Number)
  )
  for (const entry of PDF_MARK_PALETTE) {
    assert.ok(
      fillColors.some((color) =>
        color.every((value, index) => Math.abs(value - (entry.rgb[index] ?? Number.NaN)) < 0.001)
      ),
      `${entry.name} fill is missing`
    )
  }
  assert.match(content, /122\.4 538\.56 m\s+367\.2 538\.56 l\s+S/)
  assert.match(content, /122\.4 459\.3\d* m\s+367\.2 459\.3\d* l\s+S/)

  const resources = reopened.getPage(0).node.normalizedEntries().Resources
  const states = resources.lookup(PDFName.of('ExtGState'), PDFDict)
  const serializedStates = states
    .entries()
    .map(([, value]) => reopened.context.lookup(value)?.toString() ?? '')
    .join('\n')
  assert.match(serializedStates, /\/ca 0\.32/)
  assert.match(serializedStates, /\/CA 0\.9/)
})

test('export retains marks, comments and notes in the JSON attachment', async () => {
  const records = snapshot([mark('anchor', 'purple')])
  records.records.comments.push({
    id: 'comment',
    mark_id: 'anchor',
    body: 'Margin comment',
    created_at: 1,
  })
  records.records.notes.push({
    id: 'note',
    title: 'Research note',
    body: 'Note body',
    excerpts: [{ id: 'excerpt', mark_id: 'anchor', text: 'anchor', page: 1 }],
  })
  const output = await buildAnnotatedPdf(await sourcePdf(), records)
  const reopened = await PDFDocument.load(output)
  assert.deepEqual(annotationPayload(reopened), {
    schema_version: PDF_RECORD_SCHEMA_VERSION,
    marks: records.records.marks,
    comments: records.records.comments,
    notes: records.records.notes,
  })
})

test('PDF without record target saves original bytes without adding annotations', async () => {
  const input = await sourcePdf()
  let saved: Uint8Array | undefined
  Reflect.set(globalThis, 'window', {
    scholarseed: {
      saveFileCopy: async ({ bytes }: { bytes: Uint8Array }) => {
        saved = bytes
        return { ok: true, path: 'copy.pdf' }
      },
    },
  })
  assert.deepEqual(await exportAnnotatedPdf(input, null, 'copy.pdf', ATTACHMENT_DESCRIPTION), {
    ok: true,
    path: 'copy.pdf',
  })
  assert.deepEqual(saved, input)
})

test('save cancellation is not an error and save failures retain their stage', async () => {
  const input = await sourcePdf()
  Reflect.set(globalThis, 'window', {
    scholarseed: { saveFileCopy: async () => ({ ok: false, canceled: true }) },
  })
  assert.deepEqual(
    await exportAnnotatedPdf(input, snapshot(), 'copy.pdf', ATTACHMENT_DESCRIPTION),
    { ok: false, canceled: true }
  )

  Reflect.set(globalThis, 'window', {
    scholarseed: { saveFileCopy: async () => ({ ok: false, error: 'disk full' }) },
  })
  await assert.rejects(
    exportAnnotatedPdf(input, snapshot(), 'copy.pdf', ATTACHMENT_DESCRIPTION),
    (error: unknown) =>
      error instanceof PdfExportError && error.stage === 'dialog' && error.message === 'disk full'
  )
})

test('reimport removes only exported paint so edited or deleted annotations remain editable', async () => {
  const input = await sourcePdf()
  const records = snapshot([mark('anchor', 'yellow'), mark('line', 'blue', 'underline')])
  const exported = await buildAnnotatedPdf(input, records)
  const restored = await restoreAnnotatedPdf(exported)
  const before = pageContent(await PDFDocument.load(input))
  const clean = pageContent(await PDFDocument.load(restored))
  assert.ok(clean.includes(before), 'original text and image streams are retained')
  assert.doesNotMatch(clean, /0.96 0.76 0.18 rg/)
  const edited = snapshot([mark('anchor', 'purple')])
  const reexported = await buildAnnotatedPdf(exported, edited)
  const reopened = await PDFDocument.load(reexported)
  const content = pageContent(reopened)
  assert.doesNotMatch(content, /0.96 0.76 0.18 rg/)
  assert.equal(Array.from(content.matchAll(/0.58 0.42 0.78 rg/g)).length, 1)
  assert.deepEqual(annotationPayload(reopened), edited.records)
  const deleted = await buildAnnotatedPdf(reexported, snapshot())
  assert.doesNotMatch(pageContent(await PDFDocument.load(deleted)), /0.58 0.42 0.78 rg/)
})

test('reimport leaves unrelated source paint and PDFs without embedded records unchanged', async () => {
  const input = await sourcePdf()
  assert.deepEqual(await restoreAnnotatedPdf(input), input)
  const source = await PDFDocument.load(input)
  source
    .getPage(0)
    .drawRectangle({ x: 20, y: 20, width: 50, height: 50, color: rgb(0.96, 0.76, 0.18) })
  const painted = await source.save()
  const output = await buildAnnotatedPdf(painted, snapshot([mark('anchor', 'yellow')]))
  const clean = await restoreAnnotatedPdf(output)
  assert.equal(
    Array.from(pageContent(await PDFDocument.load(clean)).matchAll(/0.96 0.76 0.18 rg/g)).length,
    1
  )
})

test('invalid embedded annotations do not block PDF preview', async () => {
  for (const invalid of [
    new TextEncoder().encode('not json'),
    new TextEncoder().encode(
      JSON.stringify({ schema_version: PDF_RECORD_SCHEMA_VERSION + 1, marks: [] })
    ),
  ]) {
    const pdf = await PDFDocument.load(await sourcePdf())
    await pdf.attach(invalid, ANNOTATIONS_NAME)
    const input = await pdf.save()

    const restored = await restoreAnnotatedPdf(input)
    assert.deepEqual(restored, input)

    const task = getDocument({ data: Uint8Array.from(restored) })
    const document = await task.promise
    assert.equal(document.numPages, 1)
    await task.destroy()
  }
})

test('native imports remove only matching appearances and their popups, including after deletion', async () => {
  const pdf = await PDFDocument.load(await sourcePdf())
  const annotation = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    NM: PDFString.of('native'),
    Rect: [10, 20, 40, 50],
    Contents: PDFString.of('Reader comment'),
  })
  const ref = pdf.context.register(annotation)
  const popup = pdf.context.register(
    pdf.context.obj({ Type: 'Annot', Subtype: 'Popup', Parent: ref, Rect: [50, 20, 80, 50] })
  )
  const link = pdf.context.register(
    pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] })
  )
  pdf.getPage(0).node.set(PDFName.of('Annots'), pdf.context.obj([ref, popup, link]))
  const bytes = await pdf.save()
  const records = snapshot()
  records.records.native_annotations = [
    {
      id: 'native-id',
      page: 1,
      subtype: '/Highlight',
      name: 'native',
      rect: [10, 20, 40, 50],
      contents: 'Reader comment',
      author: '',
      created: '',
      modified: '',
    },
  ]
  const restored = await PDFDocument.load(
    await restoreAnnotatedPdf(bytes, records.records.native_annotations)
  )
  const remaining = restored.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray)
  assert.equal(remaining.size(), 1)
  assert.equal(remaining.lookup(0, PDFDict).get(PDFName.of('Subtype'))?.toString(), '/Link')
  const exported = await PDFDocument.load(await buildAnnotatedPdf(bytes, records))
  assert.equal(exported.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).size(), 1)
  assert.deepEqual(annotationPayload(exported), records.records)
  assert.equal(
    (await PDFDocument.load(bytes)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).size(),
    3
  )
})

test('export maps display coordinates back through crop and rotation and restores cleanly', async () => {
  const pdf = await PDFDocument.load(await sourcePdf())
  const page = pdf.getPage(0)
  page.setCropBox(20, 30, 560, 740)
  page.setRotation(degrees(90))
  const bytes = await pdf.save()
  const records = snapshot([
    mark('rotated', 'yellow', 'highlight', [[666 / 740, 38 / 560, 682 / 740, 125 / 560]]),
  ])
  const exported = await buildAnnotatedPdf(bytes, records)
  const reopened = await PDFDocument.load(exported)
  const content = pageContent(reopened)
  assert.match(content, /1 0 0 1 58 696 cm/)
  assert.match(content, /0 16 l\s+87 16 l\s+87 0 l/)
  assert.doesNotMatch(
    pageContent(await PDFDocument.load(await restoreAnnotatedPdf(exported))),
    /0.96 0.76 0.18 rg/
  )
})

test('normalized exports and historical overlapping-quad exports both restore cleanly', async () => {
  const input = await sourcePdf()
  const quads = [
    [0.1, 0.1, 0.3, 0.15],
    [0.1, 0.1, 0.3, 0.15],
  ]
  const records = snapshot([mark('legacy', 'yellow', 'highlight', quads)])
  const normalized = await buildAnnotatedPdf(input, records)
  assert.equal(
    Array.from(pageContent(await PDFDocument.load(normalized)).matchAll(/0.96 0.76 0.18 rg/g))
      .length,
    1
  )
  const legacy = await PDFDocument.load(input)
  const page = legacy.getPage(0)
  for (const [left, top, right, bottom] of quads) {
    page.drawRectangle({
      x: left * page.getWidth(),
      y: (1 - bottom) * page.getHeight(),
      width: (right - left) * page.getWidth(),
      height: (bottom - top) * page.getHeight(),
      color: rgb(0.96, 0.76, 0.18),
      opacity: PDF_HIGHLIGHT_OPACITY,
    })
  }
  await legacy.attach(new TextEncoder().encode(JSON.stringify(records.records)), ANNOTATIONS_NAME)
  const restored = await restoreAnnotatedPdf(await legacy.save())
  assert.doesNotMatch(pageContent(await PDFDocument.load(restored)), /0.96 0.76 0.18 rg/)
})
