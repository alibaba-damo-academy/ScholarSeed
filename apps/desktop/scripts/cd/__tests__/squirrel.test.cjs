const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { exportsFromNm, assertAbi, validateNativeLog, buildSquirrel } = require('../squirrel.cjs')

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

const electronDist = process.env.SQUIRREL_TEST_ELECTRON
const output = process.env.SQUIRREL_TEST_OUTPUT
const sourceCache = process.env.SQUIRREL_TEST_SOURCE_CACHE
test('pinned Squirrel dylib compiles, retains exports, and exercises real RAC and ditto', {
  skip: process.platform !== 'darwin' || !electronDist || !output
    ? 'requires native macOS and explicit SQUIRREL_TEST_ELECTRON/OUTPUT' : false,
}, async () => {
  const result = await buildSquirrel({ directory: output, electronDist, sourceCache, arch: process.arch })
  assert.equal(result.arch, process.arch)
  assert.ok(result.abi.originalExports.length > 0)
  assertAbi(result.abi.originalExports, result.abi.replacementExports)
  assert.equal(fs.statSync(result.executable).isFile(), true)
  validateNativeLog(fs.readFileSync(path.join(path.dirname(result.executable), 'handoff-test.log'), 'utf8'))
})
