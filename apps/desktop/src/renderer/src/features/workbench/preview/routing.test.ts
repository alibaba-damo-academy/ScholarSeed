import assert from 'node:assert/strict'
import test from 'node:test'

import { previewFormat, usesOfficePreview } from './routing.ts'

test('OOXML preview routing is explicit and never takes over editing or legacy formats', () => {
  for (const format of ['docx', 'pptx', 'xlsx']) {
    assert.equal(previewFormat(`資料.${format.toUpperCase()}`), format)
    assert.equal(usesOfficePreview(`資料.${format}`, 'preview'), true)
    assert.equal(usesOfficePreview(`資料.${format}`, 'edit'), false)
  }
  for (const path of ['a.doc', 'a.ppt', 'a.xls', 'a.csv', 'a.xlsx.zip', 'a.pdf']) {
    assert.equal(previewFormat(path), null)
    assert.equal(usesOfficePreview(path, 'preview'), false)
  }
})
