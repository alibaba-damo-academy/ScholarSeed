import assert from 'node:assert/strict'
import test from 'node:test'

import { externalWebUrl } from './external.ts'

test('external web URLs allow only HTTP and HTTPS destinations', () => {
  assert.equal(externalWebUrl('https://example.test/path'), 'https://example.test/path')
  assert.equal(externalWebUrl('http://example.test/path'), 'http://example.test/path')
  assert.equal(externalWebUrl('file:///tmp/private'), null)
  assert.equal(externalWebUrl('javascript:alert(1)'), null)
  assert.equal(externalWebUrl('not a URL'), null)
  assert.equal(externalWebUrl(undefined), null)
})
