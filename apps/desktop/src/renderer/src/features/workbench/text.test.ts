import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeTextForSave, textForMonaco } from './text.ts'

const UTF8 = new TextEncoder()
const UTF8_BOM = [0xef, 0xbb, 0xbf]

test('Monaco receives an explicit LF projection instead of normalizing source text implicitly', () => {
  assert.equal(textForMonaco('first\r\nsecond\rthird\nfourth'), 'first\nsecond\nthird\nfourth')
})

test('save encoding restores original CRLF, CR, LF and UTF-8 BOM conventions', () => {
  assert.equal(
    new TextDecoder().decode(encodeTextForSave('first\nsecond\n', UTF8.encode('old\r\ntext\r\n'))),
    'first\r\nsecond\r\n'
  )
  assert.equal(
    new TextDecoder().decode(encodeTextForSave('first\nsecond\n', UTF8.encode('old\rtext\r'))),
    'first\rsecond\r'
  )
  assert.equal(
    new TextDecoder().decode(encodeTextForSave('first\nsecond\n', UTF8.encode('old\ntext\n'))),
    'first\nsecond\n'
  )
  const bomSource = new Uint8Array([...UTF8_BOM, ...UTF8.encode('old\r\ntext\r\n')])
  assert.deepEqual(Array.from(encodeTextForSave('new\ntext\n', bomSource).slice(0, 3)), UTF8_BOM)
})
