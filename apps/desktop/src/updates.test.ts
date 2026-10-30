import assert from 'node:assert/strict'
import test from 'node:test'

import { isPreviewUpdateChannel, PREVIEW_UPDATE_CHANNEL, UPDATE_CHANNELS } from './updates.ts'

test('update channels are exactly preview and release', () => {
  assert.deepEqual([...UPDATE_CHANNELS], ['preview', 'release'])
  assert.equal(PREVIEW_UPDATE_CHANNEL, 'preview')
})

test('only the preview channel labels itself in the about page', () => {
  assert.equal(isPreviewUpdateChannel('preview'), true)
  assert.equal(isPreviewUpdateChannel('release'), false)
  assert.equal(isPreviewUpdateChannel('web'), false)
  assert.equal(isPreviewUpdateChannel(''), false)
})
