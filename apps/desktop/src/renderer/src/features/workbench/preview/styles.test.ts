import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { DOMParser } from '@xmldom/xmldom'
import { strToU8, unzipSync, zipSync } from 'fflate'

import {
  cellStyle,
  cellTextStyle,
  mergeCellBorders,
  readWorkbookStyles,
  resolveWorkbookColor,
  themeSchemeColor,
  tintColor,
  wrappedCellHeight,
} from './styles.ts'

Object.assign(globalThis, { DOMParser })

function fixture(): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries({
        'xl/_rels/workbook.xml.rels':
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/custom.xml"/><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'xl/theme/custom.xml':
          '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Evidence"><a:dk1><a:sysClr val="windowText" lastClr="102030"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="112233"/></a:dk2><a:lt2><a:srgbClr val="DDDDDD"/></a:lt2><a:accent1><a:srgbClr val="008000"/></a:accent1></a:clrScheme><a:fontScheme name="Evidence"><a:majorFont><a:latin typeface="Cambria"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>',
        'xl/styles.xml':
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><scheme val="minor"/></font></fonts><colors><indexedColors><rgbColor rgb="FF010203"/><rgbColor rgb="FFAABBCC"/></indexedColors></colors></styleSheet>',
      }).map(([name, text]) => [name, strToU8(text)])
    )
  )
}

test('theme uses Excel theme index order, system lastClr and the workbook indexed palette', () => {
  const context = readWorkbookStyles(fixture())
  assert.equal(resolveWorkbookColor({ theme: 0 }, context), '#FFFFFF')
  assert.equal(resolveWorkbookColor({ theme: 1 }, context), '#102030')
  assert.equal(themeSchemeColor('accent1', context), '#008000')
  assert.equal(themeSchemeColor('bg2', context), '#DDDDDD')
  assert.equal(resolveWorkbookColor({ indexed: 1 } as Partial<ExcelJS.Color>, context), '#AABBCC')
  assert.equal(resolveWorkbookColor({ argb: 'FFABCDEF' }, context), '#ABCDEF')
  assert.equal(context.defaultFont.name, 'Calibri')
  assert.equal(context.defaultFont.size, 11)
  assert.deepEqual(context.defaultFont.color, { theme: 1 })
  assert.equal(tintColor('#000000', 0.5), '#808080')
  assert.equal(tintColor('#FFFFFF', -0.5), '#808080')
  assert.equal(tintColor('#336699', 0.5), '#8CB3D9')
  assert.equal(resolveWorkbookColor({ indexed: 64 }, context), '#000000')
  assert.equal(resolveWorkbookColor({ indexed: 65 }, context), '#FFFFFF')
})

test('package root identifies a nonstandard workbook and its relative style and theme parts', () => {
  const entries = unzipSync(fixture())
  const root =
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="custom/book.xml"/></Relationships>'
  const context = readWorkbookStyles(
    zipSync({
      '_rels/.rels': strToU8(root),
      'custom/_rels/book.xml.rels': entries['xl/_rels/workbook.xml.rels'],
      'custom/theme/custom.xml': entries['xl/theme/custom.xml'],
      'custom/styles.xml': entries['xl/styles.xml'],
    })
  )
  assert.equal(context.theme[1], '#102030')
  assert.equal(context.indexed[1], '#AABBCC')
})

test('fonts and alignment honor workbook data, and text rotation does not rotate cell geometry', () => {
  const context = readWorkbookStyles(fixture())
  const cell = new ExcelJS.Workbook().addWorksheet('Evidence').getCell('A1')
  cell.value = 12
  cell.font = {
    name: 'Noto Serif SC',
    size: 15,
    bold: true,
    italic: true,
    underline: 'double',
    strike: true,
    color: { theme: 4, tint: 0.5 } as Partial<ExcelJS.Color>,
  }
  cell.alignment = {
    horizontal: 'right',
    vertical: 'middle',
    wrapText: true,
    indent: 2,
    textRotation: 45,
  }
  const style = cellStyle(cell, context, 2, false)
  assert.equal(style.fontFamily, '"Noto Serif SC"')
  assert.equal(style.fontSize, '40px')
  assert.equal(style.lineHeight, 'normal')
  assert.equal(style.fontWeight, 'bold')
  assert.equal(style.fontStyle, 'italic')
  assert.equal(style.textDecorationLine, 'underline line-through')
  assert.equal(style.textDecorationStyle, 'double')
  assert.equal(style.textAlign, 'right')
  assert.equal(style.justifyContent, 'center')
  assert.equal(style.whiteSpace, 'pre-wrap')
  assert.equal(style.paddingInlineStart, '6em')
  assert.equal(style.transform, undefined)
  assert.equal(cellTextStyle(cell).transform, 'rotate(-45deg)')
  cell.alignment = { textRotation: 'vertical' }
  assert.equal(cellTextStyle(cell).writingMode, 'vertical-rl')
})

test('missing fill stays white, gridlines are independent from explicit borders', () => {
  const context = readWorkbookStyles(fixture())
  const cell = new ExcelJS.Workbook().addWorksheet('Evidence').getCell('A1')
  cell.border = {
    left: { style: 'double', color: { argb: 'FF123456' } },
    bottom: { style: 'mediumDashed', color: { theme: 4 } },
  }
  const hidden = cellStyle(cell, context, 1, false)
  assert.equal(hidden.backgroundColor, '#FFFFFF')
  assert.equal(hidden.color, '#102030')
  assert.equal(hidden.borderTop, 'none')
  assert.equal(hidden.borderLeft, '3px double #123456')
  assert.equal(hidden.borderBottom, '2px dashed #008000')
  assert.match(String(cellStyle(cell, context, 1, true).borderTop), /solid/)
})

test('solid, hatch, angular and path fills preserve palette and stop colors', () => {
  const context = readWorkbookStyles(fixture())
  const cell = new ExcelJS.Workbook().addWorksheet('Evidence').getCell('A1')
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: 4 } }
  assert.equal(cellStyle(cell, context, 1, false).backgroundColor, '#008000')
  cell.fill = {
    type: 'pattern',
    pattern: 'darkTrellis',
    fgColor: { argb: 'FF123456' },
    bgColor: { argb: 'FFF0F0F0' },
  }
  assert.match(
    String(cellStyle(cell, context, 1, false).backgroundImage),
    /repeating-linear-gradient/
  )
  assert.match(String(cellStyle(cell, context, 1, false).backgroundImage), /#123456/)
  cell.fill = {
    type: 'gradient',
    gradient: 'angle',
    degree: 0,
    stops: [
      { position: 0, color: { theme: 4 } },
      { position: 1, color: { argb: 'FF0000FF' } },
    ],
  }
  assert.equal(
    cellStyle(cell, context, 1, false).backgroundImage,
    'linear-gradient(90deg, #008000 0%, #0000FF 100%)'
  )
  cell.fill = {
    type: 'gradient',
    gradient: 'path',
    center: { left: 0.25, top: 0.5 },
    stops: [
      { position: 0, color: { argb: 'FFFFFFFF' } },
      { position: 1, color: { argb: 'FF000000' } },
    ],
  }
  assert.equal(
    cellStyle(cell, context, 1, false).backgroundImage,
    'radial-gradient(ellipse at 25% 50%, #FFFFFF 0%, #000000 100%)'
  )
})

test('merged borders take each outside edge from public cell styles', () => {
  const sheet = new ExcelJS.Workbook().addWorksheet('Evidence')
  sheet.getCell('B2').border = { top: { style: 'thin' } }
  sheet.getCell('C2').border = { right: { style: 'thick', color: { argb: 'FF112233' } } }
  sheet.getCell('B3').border = { left: { style: 'double' }, bottom: { style: 'medium' } }
  const border = mergeCellBorders(sheet, 2, 2, 3, 3)
  assert.equal(border.top?.style, 'thin')
  assert.equal(border.right?.style, 'thick')
  assert.equal(border.left?.style, 'double')
  assert.equal(border.bottom?.style, 'medium')
})

test('wrapped height uses measured width, explicit newlines, font and outside borders', () => {
  const context = readWorkbookStyles(fixture())
  const cell = new ExcelJS.Workbook().addWorksheet('Wrap').getCell('A1')
  const canvas = { font: '', measureText: (text: string) => ({ width: Array.from(text).length * 5, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 3 }) } as unknown as CanvasRenderingContext2D
  cell.font = { name: 'Noto Serif', size: 10, bold: true, italic: true }
  cell.alignment = { wrapText: true }
  cell.value = 'one two'
  assert.equal(wrappedCellHeight(cell, context, 37, canvas), 18)
  assert.equal(wrappedCellHeight(cell, context, 22, canvas), 34)
  assert.equal(canvas.font, 'italic bold 13.333333333333332px "Noto Serif"')
  cell.value = 'abcd'
  assert.equal(wrappedCellHeight(cell, context, 22, canvas), 18)
  assert.equal(wrappedCellHeight(cell, context, 21, canvas), 34)
  cell.value = 'a\nb\n'
  assert.equal(wrappedCellHeight(cell, context, 100, canvas), 50)
  cell.border = { top: { style: 'thick' }, bottom: { style: 'double' } }
  assert.equal(wrappedCellHeight(cell, context, 100, canvas), 54)
  cell.alignment = { wrapText: false }
  assert.equal(wrappedCellHeight(cell, context, 1, canvas), 0)
  cell.alignment = { wrapText: true }
  cell.value = ''
  assert.equal(wrappedCellHeight(cell, context, 1, canvas), 0)
})

test('wrapped height applies scaled font, indent and fallback normal line metrics', () => {
  const context = readWorkbookStyles(fixture())
  const cell = new ExcelJS.Workbook().addWorksheet('Wrap').getCell('A1')
  const canvas = { font: '', measureText: (text: string) => ({ width: Array.from(text).length * 5 }) } as unknown as CanvasRenderingContext2D
  cell.font = { size: 10 }
  cell.alignment = { wrapText: true, indent: 1 }
  cell.value = 'abcd'
  assert.equal(wrappedCellHeight(cell, context, 62, canvas), 18)
  assert.equal(wrappedCellHeight(cell, context, 61, canvas), 34)
  cell.alignment = { wrapText: true }
  assert.equal(wrappedCellHeight(cell, context, 24, canvas, 2), 36)
})
