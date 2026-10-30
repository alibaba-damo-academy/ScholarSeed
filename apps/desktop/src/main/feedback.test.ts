import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClipboardItem, NativeImage, WebContents, WebFrameMain } from 'electron'

import { FEEDBACK_SCREENSHOT_MAX_BYTES } from '../feedback.ts'
import {
  captureFeedbackScreenshot,
  matchesFeedbackShortcut,
  isFeedbackCaptureSender,
  writeFeedbackClipboardImage,
} from './feedback.ts'

function image(bytes: Uint8Array, empty = false): NativeImage {
  return {
    isEmpty: () => empty,
    toPNG: () => Buffer.from(bytes),
    getSize: () => ({ width: 1200, height: 800 }),
  } as NativeImage
}

test('feedback capture returns bounded PNG bytes and dimensions', async () => {
  const result = await captureFeedbackScreenshot({
    capturePage: async () => image(new Uint8Array([1, 2, 3])),
  })
  assert.deepEqual(result, {
    ok: true,
    bytes: new Uint8Array([1, 2, 3]),
    width: 1200,
    height: 800,
  })
})

test('feedback shortcut accepts one application key press on macOS and Windows', () => {
  const input = {
    type: 'keyDown',
    key: 'ƒ',
    code: 'KeyF',
    shift: false,
    meta: true,
    control: false,
    alt: true,
  }
  assert.equal(matchesFeedbackShortcut(input, 'darwin'), true)
  assert.equal(matchesFeedbackShortcut({ ...input, meta: false, control: true }, 'win32'), true)
  assert.equal(matchesFeedbackShortcut(input, 'win32'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, meta: false, control: true }, 'darwin'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, control: true }, 'win32'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, type: 'keyUp' }, 'darwin'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, isAutoRepeat: true }, 'darwin'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, alt: false }, 'darwin'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, shift: true }, 'darwin'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, code: 'Digit7', key: '&' }, 'darwin'), false)
  assert.equal(matchesFeedbackShortcut({ ...input, meta: false }, 'darwin'), false)
})

test('feedback capture includes native layers without requesting focus', async () => {
  const source = { capturePage: async () => image(new Uint8Array([1])) }
  const bounds = { x: 10, y: 20, width: 100, height: 50 }
  const result = await captureFeedbackScreenshot(source, {
    viewport: { width: 1200, height: 800 },
    layers: [{ ...source, bounds }],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.viewport, { width: 1200, height: 800 })
    assert.deepEqual(result.layers, [{ bytes: new Uint8Array([1]), bounds }])
  }
})

test('feedback capture preserves native layer safety errors', async () => {
  const result = await captureFeedbackScreenshot(
    { capturePage: async () => image(new Uint8Array([1])) },
    {
      viewport: { width: 1200, height: 800 },
      layers: [
        {
          capturePage: async () => image(new Uint8Array(FEEDBACK_SCREENSHOT_MAX_BYTES + 1)),
          bounds: { x: 0, y: 0, width: 1200, height: 800 },
        },
      ],
    }
  )
  assert.deepEqual(result, { ok: false, error: 'capture_too_large' })
})

test('feedback capture rejects empty, oversized, and failed images', async () => {
  assert.deepEqual(
    await captureFeedbackScreenshot({ capturePage: async () => image(new Uint8Array(), true) }),
    { ok: false, error: 'capture_empty' }
  )
  assert.deepEqual(
    await captureFeedbackScreenshot({
      capturePage: async () => image(new Uint8Array(FEEDBACK_SCREENSHOT_MAX_BYTES + 1)),
    }),
    { ok: false, error: 'capture_too_large' }
  )
  assert.deepEqual(
    await captureFeedbackScreenshot({
      capturePage: async () => {
        throw new Error('capture failed')
      },
    }),
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
    await writeFeedbackClipboardImage(
      {
        write: async (data) => {
          written = data
        },
      },
      item
    ),
    { ok: true }
  )
  assert.deepEqual(written, [item])
  assert.deepEqual(
    await writeFeedbackClipboardImage(
      {
        write: async () => {
          throw new Error('clipboard rejected')
        },
      },
      item
    ),
    { ok: false, error: 'clipboard_image_write_failed' }
  )
})
