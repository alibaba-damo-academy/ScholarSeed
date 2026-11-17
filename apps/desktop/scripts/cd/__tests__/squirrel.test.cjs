const assert = require('node:assert/strict')
const { test } = require('node:test')
const { exportsFromNm, assertAbi, validateNativeLog } = require('../squirrel.cjs')

test('Squirrel ABI guard accepts additions but rejects removed exports across nm newline styles', () => {
  const original = exportsFromNm('000 S _value\r\n000 T _function\r\n')
  assert.deepEqual(original, ['_function', '_value'])
  assert.doesNotThrow(() => assertAbi(original, ['_value', '_new', '_function']))
  assert.throws(() => assertAbi(original, ['_value']), /removes exported ABI: _function/)
})

test('Squirrel native evidence rejects missing/overlapping timing and missing completion', () => {
  assert.throws(() => validateNativeLog(''), /downstream work/)
  const log = 'stage=contract-value event=end\nCONTRACT_DOWNSTREAM_VALUE\n' +
    'stage=contract-terminal event=end\nCONTRACT_DOWNSTREAM_TERMINAL\n'
  assert.throws(() => validateNativeLog(log), /missing contract-error/)
})
