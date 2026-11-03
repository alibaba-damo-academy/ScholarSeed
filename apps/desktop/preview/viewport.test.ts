import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_VIEWPORT, previewViewportUrl, readPreviewViewportMessage } from './viewport.ts'

test('a renderer viewport preserves scene and instance identity without changing the parent URL', () => {
  const parent = new URL('http://127.0.0.1:5175/?previewInstance=one&page=settings-archives&scene=settings-archives-states&dev=components')
  const frame = previewViewportUrl(parent)
  assert.equal(frame.searchParams.get(PREVIEW_VIEWPORT.parameter), PREVIEW_VIEWPORT.value)
  assert.equal(parent.searchParams.has(PREVIEW_VIEWPORT.parameter), false)
  for (const key of ['previewInstance', 'page', 'scene', 'dev']) assert.equal(frame.searchParams.get(key), parent.searchParams.get(key))
})

test('viewport messages bind the instance and expose only explicit UI actions and safe diagnostic fields', () => {
  const command = { type: PREVIEW_VIEWPORT.messageType, instance: 'one', action: 'open-controls' }
  assert.deepEqual(readPreviewViewportMessage(command, 'one'), command)
  for (const value of [null, {}, { ...command, instance: 'other' }, { ...command, type: 'other' }, { ...command, action: 'write' }, { ...command, action: 'diagnostic' }, { ...command, action: 'diagnostic', detail: { kind: null } }]) assert.equal(readPreviewViewportMessage(value, 'one'), null)
  const diagnostic = { ...command, action: 'diagnostic', detail: { kind: 'navigation-blocked', protocol: 'https:', origin: 'https://example.test', secret: 'not-forwarded' } }
  assert.deepEqual(readPreviewViewportMessage(diagnostic, 'one'), { ...command, action: 'diagnostic', detail: { kind: 'navigation-blocked', protocol: 'https:', origin: 'https://example.test' } })
})
