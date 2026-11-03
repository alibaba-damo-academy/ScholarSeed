import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { mediaPreview } from './media.ts'
import { loadWorkbook, workbookPreview } from './spreadsheet.ts'
import { OOXML_NS, relationshipOwner, resolvePart } from './xml.ts'

// Node contract tests use a real XML implementation; Desktop uses the native DOM.
Object.assign(globalThis, { DOMParser, XMLSerializer })

function archive(entries: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(entries).map(([path, xml]) => [path, strToU8(xml)]))
  )
}

async function prefixedWorkbook(prefix: string): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('命名空间')
  sheet.getCell('A1').value = '原始文本 <x:node> & 内容'
  sheet.getCell('A1').font = { bold: true, color: { argb: 'FF123456' } }
  sheet.getCell('B1').value = 42
  sheet.getCell('B1').numFmt = '0.00'
  sheet.getCell('C1').value = { formula: 'B1*2', result: 84 }
  sheet.getCell('A2').value = { text: '链接', hyperlink: 'https://example.com/' }
  sheet.mergeCells('A3:C3')
  sheet.getCell('A3').value = '合并单元格'
  book.addWorksheet('第二张表').getCell('A1').value = '保留工作表'
  const entries = unzipSync(new Uint8Array(await book.xlsx.writeBuffer()))
  for (const [path, bytes] of Object.entries(entries)) {
    const xml = strFromU8(bytes)
    if (!path.endsWith('.xml') || !xml.includes(`xmlns="${OOXML_NS.spreadsheet}"`)) continue
    entries[path] = strToU8(
      xml
        .replace(/<(\/?)([A-Za-z][\w.-]*)(?=[\s/>])/g, `<$1${prefix}:$2`)
        .replace(`xmlns="${OOXML_NS.spreadsheet}"`, `xmlns:${prefix}="${OOXML_NS.spreadsheet}"`)
    )
  }
  return zipSync(entries)
}

for (const prefix of ['x', 'sheetml']) {
  test(`XLSX preview reads ${prefix}-prefixed workbook, shared strings, styles and worksheets`, async () => {
    const source = await prefixedWorkbook(prefix)
    const before = Uint8Array.from(source)
    const book = await loadWorkbook(source)
    assert.deepEqual(
      book.worksheets.map((sheet) => sheet.name),
      ['命名空间', '第二张表']
    )
    const sheet = book.worksheets[0]
    assert.equal(sheet.getCell('A1').value, '原始文本 <x:node> & 内容')
    assert.equal(sheet.getCell('A1').font.bold, true)
    assert.equal(sheet.getCell('A1').font.color?.argb, 'FF123456')
    assert.equal(sheet.getCell('B1').value, 42)
    assert.equal(sheet.getCell('B1').numFmt, '0.00')
    assert.deepEqual(sheet.getCell('C1').value, { formula: 'B1*2', result: 84 })
    assert.deepEqual(sheet.getCell('A2').value, { text: '链接', hyperlink: 'https://example.com/' })
    assert.equal(sheet.getCell('C3').master.address, 'A3')
    assert.equal(book.worksheets[1].getCell('A1').value, '保留工作表')
    assert.deepEqual(source, before)
    assert.deepEqual(
      unzipSync(workbookPreview(source))['xl/_rels/workbook.xml.rels'],
      unzipSync(source)['xl/_rels/workbook.xml.rels']
    )
  })
}

test('namespace projection preserves foreign nodes, attributes, text and prefix rebinding', () => {
  const xml = `<x:worksheet xmlns:x="${OOXML_NS.spreadsheet}" xmlns="urn:foreign-default" xmlns:r="urn:relationships"><x:sheetData><x:row r="1"><x:c r="A1" r:token="x:marker"><x:v>42</x:v></x:c></x:row></x:sheetData><x:extLst><x:ext uri="test"><x:payload xmlns:x="urn:foreign" token="x:marker">x:literal<child/></x:payload></x:ext></x:extLst></x:worksheet>`
  const source = archive({
    'xl/worksheets/sheet1.xml': xml,
    'xl/media/source.xml': '<x:payload xmlns:x="urn:foreign"/>',
  })
  const projected = unzipSync(workbookPreview(source))
  const document = new DOMParser().parseFromString(
    strFromU8(projected['xl/worksheets/sheet1.xml']),
    'application/xml'
  )
  const cells = document.getElementsByTagNameNS(OOXML_NS.spreadsheet, 'c')
  assert.equal(cells.length, 1)
  assert.equal(cells[0].prefix, null)
  assert.equal(cells[0].getAttributeNS('urn:relationships', 'token'), 'x:marker')
  const payload = document.getElementsByTagNameNS('urn:foreign', 'payload')[0]
  assert.equal(payload.textContent, 'x:literal')
  assert.equal(payload.getAttribute('token'), 'x:marker')
  assert.equal(document.getElementsByTagNameNS('urn:foreign-default', 'child').length, 1)
  assert.deepEqual(projected['xl/media/source.xml'], unzipSync(source)['xl/media/source.xml'])
})

test('default spreadsheet namespace remains byte-identical and invalid archives still fail', () => {
  const source = archive({
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${OOXML_NS.spreadsheet}"><sheetData/></worksheet>`,
  })
  assert.equal(workbookPreview(source), source)
  assert.throws(() => workbookPreview(new Uint8Array([0, 1, 2])))
})

test('OPC relationship owners resolve relative, absolute and escaped part names', () => {
  assert.equal(relationshipOwner('word/_rels/document.xml.rels'), 'word/document.xml')
  assert.equal(relationshipOwner('ppt/slides/_rels/slide1.xml.rels'), 'ppt/slides/slide1.xml')
  assert.equal(relationshipOwner('_rels/.rels'), '')
  assert.equal(
    resolvePart('ppt/slides/slide1.xml', '../media/photo%20one.tiff'),
    'ppt/media/photo one.tiff'
  )
  assert.equal(resolvePart('word/document.xml', '/word/media/image.emf'), 'word/media/image.emf')
  assert.throws(() => resolvePart('word/document.xml', '../../outside.emf'), /escapes package/)
})

const TABLE_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table'
const SHEET_RELATIONSHIPS_PART = 'xl/worksheets/_rels/sheet1.xml.rels'

async function tableWorkbook(target: string): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('测试用例')
  sheet.addTable({
    name: 'Cases',
    ref: 'A1',
    headerRow: true,
    columns: [{ name: '编号' }, { name: '用例名称' }],
    rows: [
      ['S01', '拆分右侧'],
      ['S02', '拆分下方'],
    ],
  })
  const entries = unzipSync(new Uint8Array(await book.xlsx.writeBuffer()))
  const document = new DOMParser().parseFromString(strFromU8(entries[SHEET_RELATIONSHIPS_PART]))
  document
    .getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')[0]
    .setAttribute('Target', target)
  entries[SHEET_RELATIONSHIPS_PART] = strToU8(new XMLSerializer().serializeToString(document))
  return zipSync(entries)
}

for (const target of [
  '/xl/tables/table1.xml',
  '../tables/./table1.xml',
  '../tables/table%31.xml',
  '../tables/table1.xml',
]) {
  test(`XLSX table relationships resolve ${target} without changing the source`, async () => {
    const source = await tableWorkbook(target)
    const before = Uint8Array.from(source)
    const book = await loadWorkbook(source)
    const sheet = book.worksheets[0]
    assert.equal(sheet.name, '测试用例')
    assert.equal(sheet.getCell('B2').value, '拆分右侧')
    assert.equal(sheet.getCell('B3').value, '拆分下方')
    assert.equal(sheet.getTable('Cases').name, 'Cases')
    assert.deepEqual(source, before)
    const original = unzipSync(source)
    const projected = unzipSync(workbookPreview(source))
    for (const part of Object.keys(original)) {
      if (part !== SHEET_RELATIONSHIPS_PART) assert.deepEqual(projected[part], original[part])
    }
    if (target === '../tables/table1.xml') assert.equal(workbookPreview(source), source)
  })
}

test('table relationship projection preserves external, foreign and unrelated relationships', () => {
  for (const xml of [
    `<Relationships xmlns="${OOXML_NS.relationships}"><Relationship Type="${TABLE_RELATIONSHIP}" Target="/xl/tables/table1.xml" TargetMode="External" Id="external"/></Relationships>`,
    `<Relationships xmlns="urn:foreign"><Relationship Type="${TABLE_RELATIONSHIP}" Target="/xl/tables/table1.xml" Id="foreign"/></Relationships>`,
    `<Relationships xmlns="${OOXML_NS.relationships}"><Relationship Type="urn:other" Target="/xl/tables/table1.xml" Id="other"/></Relationships>`,
  ]) {
    const source = archive({ [SHEET_RELATIONSHIPS_PART]: xml })
    assert.equal(workbookPreview(source), source)
  }
})

test('prefixed table relationships are resolved without modifying unrelated attributes', () => {
  const source = archive({
    [SHEET_RELATIONSHIPS_PART]: `<p:Relationships xmlns:p="${OOXML_NS.relationships}"><p:Relationship Type="${TABLE_RELATIONSHIP}" Target="/xl/tables/table1.xml" Id="table" custom="keep"/></p:Relationships>`,
  })
  const document = new DOMParser().parseFromString(
    strFromU8(unzipSync(workbookPreview(source))[SHEET_RELATIONSHIPS_PART])
  )
  const relation = document.getElementsByTagNameNS(OOXML_NS.relationships, 'Relationship')[0]
  assert.equal(relation.getAttribute('Target'), '../tables/table1.xml')
  assert.equal(relation.getAttribute('custom'), 'keep')
  assert.equal(relation.getAttribute('Id'), 'table')
})

test('missing table parts and package traversal remain explicit failures', async () => {
  await assert.rejects(loadWorkbook(await tableWorkbook('/xl/tables/table2.xml')))
  assert.throws(
    () =>
      workbookPreview(
        archive({
          [SHEET_RELATIONSHIPS_PART]: `<Relationships xmlns="${OOXML_NS.relationships}"><Relationship Type="${TABLE_RELATIONSHIP}" Target="../../../outside.xml" Id="table"/></Relationships>`,
        })
      ),
    /escapes package/
  )
})

test('native raster packages retain their exact source bytes', async () => {
  const source = zipSync({
    'word/media/image.jpeg': new Uint8Array([0xff, 0xd8, 0xff]),
    'word/document.xml': strToU8('<document/>'),
  })
  assert.equal(await mediaPreview(source), source)
})

test('malformed metafiles fail explicitly instead of producing an empty preview', async () => {
  const source = zipSync({ 'word/media/image.emf': new Uint8Array([0, 1, 2]) })
  await assert.rejects(mediaPreview(source))
})

for (const prefix of ['', 's:']) {
  test(`table icon filters project only the known metadata (${prefix || 'default namespace'})`, () => {
    const declaration = prefix
      ? `xmlns:s="${OOXML_NS.spreadsheet}"`
      : `xmlns="${OOXML_NS.spreadsheet}"`
    const table = `<${prefix}table ${declaration}><${prefix}autoFilter><${prefix}filterColumn colId="1"><${prefix}iconFilter iconSet="3TrafficLights1" iconId="1"/></${prefix}filterColumn></${prefix}autoFilter></${prefix}table>`
    const sheet = `<worksheet xmlns="${OOXML_NS.spreadsheet}"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData><conditionalFormatting sqref="A1"><cfRule type="cellIs" priority="1"/></conditionalFormatting></worksheet>`
    const source = archive({ 'xl/tables/table1.xml': table, 'xl/worksheets/sheet1.xml': sheet })
    const before = Uint8Array.from(source)
    const projected = unzipSync(workbookPreview(source))
    assert.equal(strFromU8(projected['xl/worksheets/sheet1.xml']), sheet)
    assert.equal(strFromU8(projected['xl/tables/table1.xml']).includes('iconFilter'), false)
    assert.deepEqual(source, before)
    assert.equal(strFromU8(unzipSync(source)['xl/tables/table1.xml']), table)
  })
}

test('foreign namespaces, unrelated parts and unknown filter types are preserved', () => {
  for (const [path, xml] of [
    [
      'xl/tables/table1.xml',
      '<table xmlns="urn:other"><autoFilter><filterColumn><iconFilter/></filterColumn></autoFilter></table>',
    ],
    [
      'xl/tables/table1.xml',
      `<table xmlns="${OOXML_NS.spreadsheet}"><autoFilter><filterColumn><unknownFilter/></filterColumn></autoFilter></table>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="${OOXML_NS.spreadsheet}"><autoFilter><filterColumn><iconFilter/></filterColumn></autoFilter></worksheet>`,
    ],
  ]) {
    const source = archive({ [path]: xml })
    assert.equal(workbookPreview(source), source)
  }
})

test('malformed icon filter metadata is not suppressed by the preview projection', () => {
  for (const filter of [
    '<iconFilter iconSet="unknown" iconId="1"/>',
    '<iconFilter iconSet="3TrafficLights1" iconId="-1"/>',
    '<iconFilter iconSet="3TrafficLights1" iconId="3"/>',
    '<iconFilter iconSet="3TrafficLights1"/>',
    '<iconFilter iconSet="3TrafficLights1" iconId="1"><unknown/></iconFilter>',
  ]) {
    const source = archive({
      'xl/tables/table1.xml': `<table xmlns="${OOXML_NS.spreadsheet}"><autoFilter><filterColumn colId="1">${filter}</filterColumn></autoFilter></table>`,
    })
    assert.equal(workbookPreview(source), source)
  }
})

const corpus = process.env.SCHOLARSEED_OFFICE_CORPUS
test(
  'original conditional-formatting sample retains 18 worksheets and source metadata',
  { skip: !corpus },
  async () => {
    const source = new Uint8Array(
      readFileSync(join(corpus!, 'xlsx', 'poi-ConditionalFormattingSamples.xlsx'))
    )
    const original = unzipSync(source)
    const projected = unzipSync(workbookPreview(source))
    for (const path of Object.keys(original).filter(
      (path) => path.startsWith('xl/worksheets/') && path.endsWith('.xml')
    )) {
      assert.deepEqual(projected[path], original[path])
    }
    assert.match(strFromU8(original['xl/tables/table7.xml']), /iconFilter/)
    const book = await loadWorkbook(source)
    assert.equal(book.worksheets.length, 18)
    assert.equal(book.getWorksheet('Products1')!.getCell('B3').value, 'Dairy')
    assert.equal(book.getWorksheet('Products1')!.getCell('D3').value, 1148)
    // ExcelJS stores the parsed rules but omits the field from its Worksheet declaration.
    assert.ok(
      book.worksheets.some(
        (sheet) =>
          (sheet as typeof sheet & { conditionalFormattings: unknown[] }).conditionalFormattings
            .length > 0
      )
    )
  }
)

test(
  'original Word media projection preserves every text and native raster part',
  { skip: !corpus },
  async () => {
    const source = new Uint8Array(readFileSync(join(corpus!, 'docx', 'poi-VariousPictures.docx')))
    const original = unzipSync(source)
    const projected = unzipSync(await mediaPreview(source))
    assert.deepEqual(projected['word/document.xml'], original['word/document.xml'])
    assert.deepEqual(projected['word/media/image2.png'], original['word/media/image2.png'])
    assert.deepEqual(projected['word/media/image5.jpeg'], original['word/media/image5.jpeg'])
    for (const path of [
      'word/media/image1.wmf',
      'word/media/image3.emf',
      'word/media/image4.emf',
    ]) {
      const svg = strFromU8(projected[`${path}.preview.svg`])
      assert.match(svg, /<svg/)
      assert.match(svg, /<path/)
      assert.doesNotMatch(svg, /NaN|Infinity/)
      assert.deepEqual(projected[path], original[path])
    }
  }
)
