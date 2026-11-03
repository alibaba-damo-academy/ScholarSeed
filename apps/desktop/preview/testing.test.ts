import assert from 'node:assert/strict'
import test from 'node:test'
import { previewRequestInstance } from './testing.ts'
import { PREVIEW_ORIGIN } from './constants.ts'

test('test lifetime observes only explicit valid same-origin instances, never the default or a foreign preview', () => {
  assert.equal(previewRequestInstance(`${PREVIEW_ORIGIN}/?previewInstance=owned-tab&scene=page-home`), 'owned-tab')
  assert.equal(previewRequestInstance(`${PREVIEW_ORIGIN}/api/serve/sessions`), null)
  assert.equal(previewRequestInstance('https://foreign.invalid/?previewInstance=user-tab'), null)
  assert.equal(previewRequestInstance(`${PREVIEW_ORIGIN}/?previewInstance=../default`), null)
  assert.equal(previewRequestInstance('not a URL'), null)
})
