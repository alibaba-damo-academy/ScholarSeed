import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { strToU8, zipSync } from 'fflate'

import { compileConditionalFormats, conditionalDecoration, conditionalNumber, percentile, readConditionalFormats, type ConditionalCell, type ConditionalRule } from './conditional.ts'
import { CONDITIONAL_ICONS } from './icons.ts'
import { readWorkbookStyles } from './styles.ts'
import { loadWorkbook } from './spreadsheet.ts'
import { OOXML_NS } from './xml.ts'

Object.assign(globalThis, { DOMParser, XMLSerializer })
const DOCUMENT_RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
function fixture(body: string): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries({
    '_rels/.rels': `<Relationships xmlns="${OOXML_NS.relationships}"><Relationship Id="root" Type="${DOCUMENT_RELATIONSHIPS}/officeDocument" Target="books/custom.xml"/></Relationships>`,
    'books/custom.xml': `<workbook xmlns="${OOXML_NS.spreadsheet}" xmlns:r="${DOCUMENT_RELATIONSHIPS}"><sheets><sheet name="Evidence" sheetId="1" r:id="sheet"/></sheets></workbook>`,
    'books/_rels/custom.xml.rels': `<Relationships xmlns="${OOXML_NS.relationships}"><Relationship Id="sheet" Type="${DOCUMENT_RELATIONSHIPS}/worksheet" Target="../worksheets/custom%20sheet.xml"/></Relationships>`,
    'worksheets/custom sheet.xml': `<worksheet xmlns="${OOXML_NS.spreadsheet}">${body}</worksheet>`,
  }).map(([path, value]) => [path, strToU8(value)])))
}
function rules(body: string): readonly ConditionalRule[] {
  const source = fixture(body)
  return readConditionalFormats(source, readWorkbookStyles(source)).get('Evidence')!
}
function cells(values: unknown[], column = 1): ConditionalCell[] {
  return values.map((value, index) => ({ row: index + 1, column, value }))
}
const scale = '<colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FF000000"/><color rgb="FFFFFFFF"/></colorScale>'
const arrows = '<iconSet iconSet="3Arrows"><cfvo type="percent" val="0"/><cfvo type="num" val="0"/><cfvo type="num" val="5"/></iconSet>'

test('source relationships, absolute A1, multi sqref and unsupported rules remain explicit', () => {
  const selected = rules(`<conditionalFormatting sqref="$A$1:$A$3 C1:C3"><cfRule type="colorScale" priority="3">${scale}</cfRule><cfRule type="expression" priority="1" stopIfTrue="1"><formula>ROW()=1</formula></cfRule></conditionalFormatting>`)
  assert.equal(selected.length, 2)
  assert.deepEqual(selected[0].ranges, [{ top: 1, left: 1, bottom: 3, right: 1 }, { top: 1, left: 3, bottom: 3, right: 3 }])
  assert.equal(selected[1].type, 'unsupported')
  assert.equal(selected[1].stopIfTrue, true)
})

test('empty, error, text and nonfinite values are excluded; cached numeric formulas are retained', () => {
  for (const value of [null, undefined, '', '5', false, new Date(), NaN, Infinity, { error: '#VALUE!' }, { formula: 'A1' }]) assert.equal(conditionalNumber(value), undefined)
  assert.equal(conditionalNumber({ formula: 'SUM(A1:A3)', result: 5 }), 5)
  const sourceValue = { formula: 'A1', result: 10 }
  const compiled = compileConditionalFormats(rules(`<conditionalFormatting sqref="A1:A6"><cfRule type="colorScale" priority="1">${scale}</cfRule></conditionalFormatting>`), cells([0, sourceValue, null, '100', { error: '#N/A' }, Infinity]))
  assert.deepEqual(compiled[0].thresholds, [0, 10])
  assert.equal(conditionalDecoration(compiled, 2, 1, sourceValue).background, '#FFFFFF')
  assert.deepEqual(sourceValue, { formula: 'A1', result: 10 })
  assert.deepEqual(conditionalDecoration(compiled, 3, 1, null), { showValue: true })
})

test('statistics span every referenced region, independent of viewport and unrelated numeric cells', () => {
  const selected = rules(`<conditionalFormatting sqref="A1:A3 C1:C3"><cfRule type="colorScale" priority="1">${scale}</cfRule></conditionalFormatting>`)
  const compiled = compileConditionalFormats(selected, [...cells([0, 10, 20]), ...cells([80, 90, 100], 3), ...cells([999], 2)])
  assert.deepEqual(compiled[0].thresholds, [0, 100])
  assert.equal(conditionalDecoration(compiled, 2, 1, 10).background, '#1A1A1A')
  assert.equal(conditionalDecoration(compiled, 2, 3, 90).background, '#E6E6E6')
  assert.equal(conditionalDecoration(compiled, 1, 2, 999).background, undefined)
})

test('percent is a numeric span, percentile is inclusive interpolation of sorted values', () => {
  const selected = rules('<conditionalFormatting sqref="A1:A4"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="percent" val="50"/><cfvo type="percentile" val="50"/><color rgb="FF008000"/></dataBar></cfRule></conditionalFormatting>')
  assert.deepEqual(compileConditionalFormats(selected, cells([0, 1, 2, 100]))[0].thresholds, [50, 1.5])
  assert.equal(percentile([0, 1, 2, 100], 20), .6)
  assert.equal(percentile([], 50), undefined)
  assert.equal(percentile([7], 50), 7)
})

test('two/three-color gradients clamp extremes and interpolate each segment', () => {
  const selected = rules('<conditionalFormatting sqref="A1:A3"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/><color rgb="FF0000FF"/></colorScale></cfRule></conditionalFormatting>')
  const compiled = compileConditionalFormats(selected, cells([0, 50, 100]))
  assert.equal(conditionalDecoration(compiled, 1, 1, -5).background, '#FF0000')
  assert.equal(conditionalDecoration(compiled, 1, 1, 25).background, '#808000')
  assert.equal(conditionalDecoration(compiled, 2, 1, 50).background, '#00FF00')
  assert.equal(conditionalDecoration(compiled, 2, 1, 75).background, '#008080')
  assert.equal(conditionalDecoration(compiled, 3, 1, 120).background, '#0000FF')
})

test('data bars preserve defaults, authored lengths, showValue and theme tint', () => {
  const selected = rules('<conditionalFormatting sqref="A1:A3"><cfRule type="dataBar" priority="2"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF008000"/></dataBar></cfRule></conditionalFormatting><conditionalFormatting sqref="B1:B3"><cfRule type="dataBar" priority="1"><dataBar minLength="0" maxLength="100" showValue="0"><cfvo type="num" val="0"/><cfvo type="num" val="100"/><color theme="1" tint="0.5"/></dataBar></cfRule></conditionalFormatting>')
  const compiled = compileConditionalFormats(selected, [...cells([0, 50, 100]), ...cells([0, 50, 100], 2)])
  assert.equal(conditionalDecoration(compiled, 1, 1, 0).bar?.fraction, .1)
  assert.equal(conditionalDecoration(compiled, 3, 1, 100).bar?.fraction, .9)
  assert.equal(conditionalDecoration(compiled, 2, 2, 50).bar?.fraction, .5)
  assert.equal(conditionalDecoration(compiled, 2, 2, 50).bar?.color, '#808080')
  assert.equal(conditionalDecoration(compiled, 2, 2, 50).showValue, false)
})

test('icon set default, gte boundary, duplicate thresholds, reverse and showValue are source-owned', () => {
  const selected = rules('<conditionalFormatting sqref="A1:A3"><cfRule type="iconSet" priority="1"><iconSet reverse="1" showValue="0"><cfvo type="percent" val="0"/><cfvo type="num" val="0" gte="0"/><cfvo type="num" val="5" gte="0"/></iconSet></cfRule></conditionalFormatting>')
  const compiled = compileConditionalFormats(selected, cells([0, 5, 6]))
  assert.equal(conditionalDecoration(compiled, 1, 1, 0).icon?.set, '3TrafficLights1')
  assert.equal(conditionalDecoration(compiled, 1, 1, 0).icon?.index, 2)
  assert.equal(conditionalDecoration(compiled, 2, 1, 5).icon?.index, 1)
  assert.equal(conditionalDecoration(compiled, 3, 1, 6).icon?.index, 0)
  assert.equal(conditionalDecoration(compiled, 2, 1, 5).showValue, false)
  const repeated = rules('<conditionalFormatting sqref="A1:A3"><cfRule type="iconSet" priority="1"><iconSet iconSet="3Arrows"><cfvo type="percent" val="0"/><cfvo type="num" val="0"/><cfvo type="num" val="0"/></iconSet></cfRule></conditionalFormatting>')
  const zero = compileConditionalFormats(repeated, cells([-1, 0, 1]))
  assert.equal(conditionalDecoration(zero, 1, 1, -1).icon?.index, 0)
  assert.equal(conditionalDecoration(zero, 2, 1, 0).icon?.index, 2)
  assert.equal(conditionalDecoration(zero, 3, 1, 1).showValue, true)
})

test('global priority and numeric cellIs stopIfTrue suppress later icons at exact threshold', () => {
  const selected = rules(`<conditionalFormatting sqref="A1:A3"><cfRule type="iconSet" priority="9">${arrows}</cfRule></conditionalFormatting><conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" operator="greaterThanOrEqual" priority="1" stopIfTrue="true"><formula>900000</formula></cfRule></conditionalFormatting>`)
  const compiled = compileConditionalFormats(selected, cells([899999, 900000, 1000000]))
  assert.equal(compiled[0].rule.type, 'cellIs')
  assert.ok(conditionalDecoration(compiled, 1, 1, 899999).icon)
  assert.equal(conditionalDecoration(compiled, 2, 1, 900000).icon, undefined)
  assert.equal(conditionalDecoration(compiled, 3, 1, 1000000).icon, undefined)
})

test('higher-priority visual property wins while distinct decorations can coexist', () => {
  const selected = rules(`<conditionalFormatting sqref="A1:A3"><cfRule type="colorScale" priority="9">${scale}</cfRule><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FF008000"/><color rgb="FF008000"/></colorScale></cfRule><cfRule type="iconSet" priority="2">${arrows}</cfRule></conditionalFormatting>`)
  const result = conditionalDecoration(compileConditionalFormats(selected, cells([0, 5, 10])), 2, 1, 5)
  assert.equal(result.background, '#008000')
  assert.equal(result.icon?.index, 2)
})

test('malformed/unsupported thresholds and unknown icon families never receive a fake substitute', () => {
  const selected = rules('<conditionalFormatting sqref="A1:A3"><cfRule type="iconSet" priority="1"><iconSet iconSet="5Boxes"><cfvo type="percent" val="0"/></iconSet></cfRule><cfRule type="dataBar" priority="2"><dataBar><cfvo type="formula" val="$A$1"/><cfvo type="max"/><color rgb="FF008000"/></dataBar></cfRule></conditionalFormatting>')
  assert.equal(selected.every((rule) => rule.type === 'unsupported'), true)
  assert.deepEqual(conditionalDecoration(compileConditionalFormats(selected, cells([1, 2, 3])), 1, 1, 1), { background: undefined, bar: undefined, icon: undefined, showValue: true })
  assert.deepEqual(Object.fromEntries(Object.entries(CONDITIONAL_ICONS).map(([name, assets]) => [name, assets.length])), { '3Symbols2': 3, '3Arrows': 3, '3TrafficLights1': 3, '5Quarters': 5 })
  for (const assets of Object.values(CONDITIONAL_ICONS)) for (const selected of assets) {
    const url = new URL(selected.dataUrl)
    const document = new DOMParser().parseFromString(readFileSync(url, 'utf8'), 'image/svg+xml')
    assert.equal(document.documentElement.localName, 'svg')
    assert.equal(document.getElementsByTagName('script').length, 0)
    const view = Array.from(document.getElementsByTagName('view')).find((item) => item.getAttribute('id') === url.hash.slice(1))
    assert.ok(view, `${selected.id} must identify an existing sprite view`)
    assert.match(view.getAttribute('viewBox')!, /^\d+ 0 16 16$/)
  }
})

const corpus = process.env.SCHOLARSEED_OFFICE_CORPUS
test('original sample keeps all 42 rules with 21 target visuals and correct Regional sales stop/gte', { skip: !corpus }, async () => {
  const bytes = new Uint8Array(readFileSync(join(corpus!, 'xlsx', 'poi-ConditionalFormattingSamples.xlsx')))
  const before = Uint8Array.from(bytes)
  const styles = readWorkbookStyles(bytes)
  const formats = readConditionalFormats(bytes, styles)
  const all = Array.from(formats.values()).flat()
  assert.equal(all.length, 42)
  assert.equal(all.filter((rule) => ['colorScale', 'dataBar', 'iconSet'].includes(rule.type)).length, 21)
  assert.equal(all.filter((rule) => rule.type === 'colorScale').length, 2)
  assert.equal(all.filter((rule) => rule.type === 'dataBar').length, 5)
  assert.equal(all.filter((rule) => rule.type === 'iconSet').length, 14)
  const book = await loadWorkbook(bytes)
  for (const name of ['Regional sales', 'Regional sales2', 'Regional sales3']) {
    const sheet = book.getWorksheet(name)!
    const entries: ConditionalCell[] = []
    sheet.eachRow((row, rowNumber) => row.eachCell((cell, column) => entries.push({ row: rowNumber, column, value: cell.value })))
    const compiled = compileConditionalFormats(formats.get(name)!, entries)
    assert.equal(conditionalDecoration(compiled, 7, 2, sheet.getCell('B7').value).icon?.index, 1)
    assert.equal(conditionalDecoration(compiled, 9, 2, sheet.getCell('B9').value).icon, undefined)
    assert.equal(conditionalDecoration(compiled, 4, 2, sheet.getCell('B4').value).icon, undefined)
  }
  const mountains = formats.get('Mountains')!
  assert.equal(mountains.filter((rule) => rule.type === 'dataBar' && !rule.showValue).length, 2)
  assert.deepEqual(bytes, before)
})
