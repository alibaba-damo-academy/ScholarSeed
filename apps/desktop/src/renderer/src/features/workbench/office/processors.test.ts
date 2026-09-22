import assert from 'node:assert/strict'
import test from 'node:test'

import { officeProcessor } from './processors/registry.ts'

test('XLS and XLSX use distinct Office load processors', () => {
  const xls = officeProcessor('xls')
  const xlsx = officeProcessor('xlsx')

  assert.equal(xls.kind, 'xls')
  assert.equal(xlsx.kind, 'xlsx')
  assert.notEqual(xls, xlsx)
  assert.deepEqual(xls.bind({ filename: 'legacy.xls' }), {
    filename: 'legacy.xls',
    processor: 'xls',
    expectedDocumentKind: 'calc'
  })
  assert.deepEqual(xlsx.bind({ filename: 'modern.xlsx' }), {
    filename: 'modern.xlsx',
    processor: 'xlsx',
    expectedDocumentKind: 'calc'
  })
  assert.throws(() => xls.bind({ filename: 'modern.xlsx' }), /office_processor_path_mismatch:xls/)
  assert.throws(() => xlsx.bind({ filename: 'legacy.xls' }), /office_processor_path_mismatch:xlsx/)
})

test('unknown Office processor fails closed', () => {
  assert.throws(() => officeProcessor(null), /office_processor_missing/)
  assert.throws(() => officeProcessor('unknown' as never), /office_processor_unknown/)
})
