import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClipboardItem, NativeImage, WebContents, WebFrameMain } from 'electron'

import { FEEDBACK_SCREENSHOT_MAX_BYTES } from '../feedback.ts'
import {
  captureFeedbackScreenshot,
  isFeedbackCaptureSender,
  writeFeedbackClipboardImage
} from './feedback.ts'

function image(bytes: Uint8Array, empty = false): NativeImage {
  return {
    isEmpty: () => empty,
    toPNG: () => Buffer.from(bytes),
    getSize: () => ({ width: 1200, height: 800 })
  } as NativeImage
}

test('feedback capture returns bounded PNG bytes and dimensions', async () => {
  const result = await captureFeedbackScreenshot({ capturePage: async () => image(new Uint8Array([1, 2, 3])) })
  assert.deepEqual(result, {
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    width: 1200,
    height: 800
  })
})

test('feedback capture rejects empty, oversized, and failed images', async () => {
  assert.deepEqual(
    await captureFeedbackScreenshot({ capturePage: async () => image(new Uint8Array(), true) }),
    { ok: false, error: 'capture_empty' }
  )
  assert.deepEqual(
    await captureFeedbackScreenshot({
      capturePage: async () => image(new Uint8Array(FEEDBACK_SCREENSHOT_MAX_BYTES + 1))
    }),
    { ok: false, error: 'capture_too_large' }
  )
  assert.deepEqual(
    await captureFeedbackScreenshot({ capturePage: async () => { throw new Error('capture failed') } }),
    { ok: false, error: 'capture_failed' }
  )
})

test('feedback capture accepts only the main renderer frame', () => {
  const frame = {} as WebFrameMain
  const sender = { mainFrame: frame } as WebContents
  assert.equal(isFeedbackCaptureSender(sender, frame, sender), true)
  assert.equal(isFeedbackCaptureSender(sender, null, sender), false)
  assert.equal(isFeedbackCaptureSender(sender, frame, {} as WebContents), false)
})

test('feedback image copy uses the supported Electron ClipboardItem array', async () => {
  const item = {} as ClipboardItem
  let written: ClipboardItem[] | undefined
  assert.deepEqual(
    await writeFeedbackClipboardImage({ write: async (data) => { written = data } }, item),
    { ok: true }
  )
  assert.deepEqual(written, [item])
  assert.deepEqual(
    await writeFeedbackClipboardImage({ write: async () => { throw new Error('clipboard rejected') } }, item),
    { ok: false, error: 'clipboard_image_write_failed' }
  )
})
