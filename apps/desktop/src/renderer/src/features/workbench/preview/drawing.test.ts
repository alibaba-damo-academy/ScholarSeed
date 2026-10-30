import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DOMParser } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { drawingBounds, drawingLineHeight, parseDrawings } from './drawing.ts'
import { readWorkbookStyles } from './styles.ts'

Object.assign(globalThis, { DOMParser })

const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOCUMENT_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const MAIN = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const context = {
  theme: ['#FFFFFF', '#000000', '#EEEEEE', '#222222', '#4472C4'],
  indexed: [],
  defaultFont: {},
  fonts: { major: 'Arial', minor: 'Arial' },
}

function fixture(spacing = '', editAs = ''): Uint8Array {
  const marker =
    '<xdr:from><xdr:col>1</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>'
  const baseShape =
    '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="7" name="Linked shape"><a:hlinkClick r:id="jump"/></xdr:cNvPr></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="roundRect"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="40000"/><a:lumOff val="60000"/></a:schemeClr></a:solidFill></xdr:spPr><xdr:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="1200" b="1"/><a:t>Go to</a:t></a:r><a:r><a:t> sheet</a:t></a:r></a:p></xdr:txBody></xdr:sp>'
  const shape = baseShape.replace('<a:pPr algn="ctr"/>', `<a:pPr algn="ctr">${spacing}</a:pPr>`)
  const entries = {
    '_rels/.rels': `<Relationships xmlns="${RELS}"><Relationship Id="book" Type="${DOCUMENT_RELS}/officeDocument" Target="custom/book.xml"/></Relationships>`,
    'custom/book.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${DOCUMENT_RELS}"><sheets><sheet name="Main" r:id="sheet"/></sheets></workbook>`,
    'custom/_rels/book.xml.rels': `<Relationships xmlns="${RELS}"><Relationship Id="sheet" Type="${DOCUMENT_RELS}/worksheet" Target="sheets/source.xml"/></Relationships>`,
    'custom/sheets/source.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${DOCUMENT_RELS}"><drawing r:id="drawing"/></worksheet>`,
    'custom/sheets/_rels/source.xml.rels': `<Relationships xmlns="${RELS}"><Relationship Id="drawing" Type="${DOCUMENT_RELS}/drawing" Target="../drawings/diagram.xml"/></Relationships>`,
    'custom/drawings/diagram.xml': `<xdr:wsDr xmlns:xdr="${DRAWING}" xmlns:a="${MAIN}" xmlns:r="${DOCUMENT_RELS}"><xdr:oneCellAnchor>${marker}<xdr:ext cx="952500" cy="190500"/>${shape}</xdr:oneCellAnchor><xdr:twoCellAnchor>${marker}<xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${shape.replace('id="7"', 'id="8"')}</xdr:twoCellAnchor><xdr:absoluteAnchor><xdr:pos x="95250" y="190500"/><xdr:ext cx="952500" cy="476250"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="9" name="Picture"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="photo"/></xdr:blipFill></xdr:pic></xdr:absoluteAnchor></xdr:wsDr>`,
    'custom/drawings/_rels/diagram.xml.rels': `<Relationships xmlns="${RELS}"><Relationship Id="jump" Type="${DOCUMENT_RELS}/hyperlink" Target="#'Other sheet'!$B$2"/><Relationship Id="photo" Type="${DOCUMENT_RELS}/image" Target="../media/photo.png"/></Relationships>`,
    'custom/media/photo.png': 'image-bytes',
  }
  entries['custom/drawings/diagram.xml'] = entries['custom/drawings/diagram.xml'].replace('<xdr:twoCellAnchor>', `<xdr:twoCellAnchor${editAs ? ` editAs="${editAs}"` : ''}>`)
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([path, content]) => [path, strToU8(content)]))
  )
}

test('DrawingML resolves owning part relationships, source text, themes, images and internal links', () => {
  const drawings = parseDrawings(fixture(), 'Main', context)
  assert.equal(drawings.length, 3)
  assert.equal(drawings[0].geometry, 'roundRect')
  assert.equal(drawings[0].paragraphs[0].runs.map((run) => run.text).join(''), 'Go to sheet')
  assert.equal(drawings[0].paragraphs[0].runs[0].sizePt, 12)
  assert.equal(drawings[0].paragraphs[0].runs[0].bold, true)
  assert.deepEqual(drawings[0].hyperlink, { sheet: 'Other sheet', range: '$B$2' })
  assert.match(drawings[0].fill ?? '', /^#[0-9a-f]{6}$/i)
  assert.match(drawings[2].imageDataUrl ?? '', /^data:image\/png;base64,/)
  assert.deepEqual(parseDrawings(fixture(), 'Missing', context), [])
})

test('all anchor modes share grid offsets; only EMU geometry is scaled again', () => {
  const drawings = parseDrawings(fixture(), 'Main', context)
  const geometry = {
    columnOffsets: [0, 100, 200, 300, 400],
    rowOffsets: [0, 20, 40, 60, 80],
    zoom: 200,
    origin: { x: 48, y: 28 },
  }
  assert.deepEqual(drawingBounds(drawings[0], geometry), { x: 150, y: 72, width: 200, height: 40 })
  assert.deepEqual(drawingBounds(drawings[1], geometry), { x: 150, y: 72, width: 198, height: 36 })
  assert.deepEqual(drawingBounds(drawings[2], geometry), { x: 68, y: 68, width: 200, height: 100 })
})

test('DrawingML line spacing preserves source percent/point units and Office defaults', () => {
  const defaultParagraph = parseDrawings(fixture(), 'Main', context)[0].paragraphs[0]
  assert.deepEqual(defaultParagraph.lineSpacing, { unit: 'percent', value: 100 })
  assert.equal(drawingLineHeight(defaultParagraph, 200), '100%')
  const percentParagraph = parseDrawings(
    fixture('<a:lnSpc><a:spcPct val="125000"/></a:lnSpc>'),
    'Main',
    context
  )[0].paragraphs[0]
  assert.deepEqual(percentParagraph.lineSpacing, { unit: 'percent', value: 125 })
  assert.equal(drawingLineHeight(percentParagraph, 200), '125%')
  const pointParagraph = parseDrawings(
    fixture('<a:lnSpc><a:spcPts val="1200"/></a:lnSpc>'),
    'Main',
    context
  )[0].paragraphs[0]
  assert.deepEqual(pointParagraph.lineSpacing, { unit: 'points', value: 12 })
  assert.equal(drawingLineHeight(pointParagraph, 200), '32px')
  assert.equal(defaultParagraph.runs[0].color, context.theme[1])
})

test('two-cell anchors preserve their authored resize policy', () => {
  for (const mode of ['twoCell', 'oneCell', 'absolute'] as const) {
    assert.equal(parseDrawings(fixture('', mode), 'Main', context)[1].anchor.editAs, mode)
  }
  assert.equal(parseDrawings(fixture(), 'Main', context)[1].anchor.editAs, undefined)
})

test('resized grid moves and sizes drawings according to editAs without scaling grid pixels twice', () => {
  const grid = {
    baseColumnOffsets: [0, 100, 200, 300, 400],
    baseRowOffsets: [0, 20, 40, 60, 80],
    columnOffsets: [0, 120, 240, 360, 480],
    rowOffsets: [0, 30, 60, 90, 120],
    zoom: 200,
    origin: { x: 48, y: 28 },
  }
  const ordinary = parseDrawings(fixture(), 'Main', context)
  assert.deepEqual(drawingBounds(ordinary[0], grid), { x: 170, y: 92, width: 200, height: 40 })
  assert.deepEqual(drawingBounds(ordinary[1], grid), { x: 170, y: 92, width: 238, height: 56 })
  assert.deepEqual(drawingBounds(ordinary[2], grid), { x: 68, y: 68, width: 200, height: 100 })
  const moveOnly = parseDrawings(fixture('', 'oneCell'), 'Main', context)[1]
  assert.deepEqual(drawingBounds(moveOnly, grid), { x: 170, y: 92, width: 198, height: 36 })
  const absolute = parseDrawings(fixture('', 'absolute'), 'Main', context)[1]
  assert.deepEqual(drawingBounds(absolute, grid), { x: 150, y: 72, width: 198, height: 36 })
  // Callers that do not provide original geometry keep their initial rendering.
  const withoutBase = { ...grid, baseColumnOffsets: undefined, baseRowOffsets: undefined }
  assert.deepEqual(drawingBounds(moveOnly, withoutBase), { x: 170, y: 92, width: 238, height: 56 })
  assert.deepEqual(drawingBounds(absolute, withoutBase), { x: 170, y: 92, width: 238, height: 56 })
})

test('original ConditionalFormattingSamples keeps all move-only drawing policies', { skip: !process.env.SCHOLARSEED_OFFICE_CORPUS }, () => {
  const source = readFileSync(join(process.env.SCHOLARSEED_OFFICE_CORPUS!, 'xlsx', 'poi-ConditionalFormattingSamples.xlsx'))
  const document = new DOMParser().parseFromString(strFromU8(unzipSync(source)['xl/workbook.xml']), 'application/xml')
  const styles = readWorkbookStyles(source)
  const inventory = new Map<string, number>()
  for (const sheet of Array.from(document.getElementsByTagName('sheet'))) {
    const drawings = parseDrawings(source, sheet.getAttribute('name')!, styles)
    if (sheet.getAttribute('name') === 'Home') assert.equal(drawings.length, 17)
    for (const item of drawings) {
      const key = `${item.anchor.kind}:${item.anchor.editAs ?? 'default'}`
      inventory.set(key, (inventory.get(key) ?? 0) + 1)
    }
  }
  assert.deepEqual(Object.fromEntries(inventory), { 'twoCell:default': 33, 'oneCell:default': 18, 'twoCell:oneCell': 20 })
})
