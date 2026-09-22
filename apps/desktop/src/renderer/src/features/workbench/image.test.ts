import assert from 'node:assert/strict'
import test from 'node:test'

import { fitImage, imageMediaType, imageViewState, panImage, zoomImage, IMAGE_MAX_SCALE, IMAGE_MIN_SCALE } from './image.ts'

test('fit contains landscape and portrait images without distortion and resets pan', () => {
  assert.deepEqual(fitImage({ width: 2000, height: 1000 }, { width: 500, height: 500 }), { mode: 'fit', scale: 0.25, x: 0, y: 0 })
  assert.equal(fitImage({ width: 100, height: 400 }, { width: 600, height: 300 }).scale, 0.75)
  assert.equal(fitImage({ width: 0, height: 0 }, { width: 0, height: 0 }).scale, 1)
})

test('zoom preserves the image point at viewport center and clamps controls', () => {
  const view = { mode: 'manual' as const, scale: 1, x: 60, y: -40 }
  assert.deepEqual(zoomImage(view, 2), { mode: 'manual', scale: 2, x: 120, y: -80 })
  assert.equal(zoomImage(view, 1000).scale, IMAGE_MAX_SCALE)
  assert.equal(zoomImage(view, 0).scale, IMAGE_MIN_SCALE)
})

test('pan accumulates screen-space deltas without mutating the saved state', () => {
  const saved = { mode: 'fit' as const, scale: 0.5, x: 0, y: 0 }
  assert.deepEqual(panImage(saved, 25, -10), { mode: 'manual', scale: 0.5, x: 25, y: -10 })
  assert.equal(saved.x, 0)
})

test('persisted tab state survives restoration and invalid values are normalized', () => {
  const saved = { mode: 'manual', scale: 2, x: 95, y: -12 }
  assert.deepEqual(imageViewState(saved), saved)
  assert.deepEqual(imageViewState({ mode: 'unknown', scale: NaN, x: Infinity, y: 'bad' }), { mode: 'fit', scale: 1, x: 0, y: 0 })
  assert.notEqual(imageViewState(saved), saved)
})


test('image MIME follows a known image suffix when transport returns a generic type', () => {
  assert.equal(imageMediaType('photo.SVG', 'application/octet-stream'), 'image/svg+xml')
  assert.equal(imageMediaType('animation.gif', ''), 'image/gif')
  assert.equal(imageMediaType('photo.jpeg', 'application/octet-stream'), 'image/jpeg')
  assert.equal(imageMediaType('photo', 'image/webp'), 'image/webp')
})

test('panning an extremely large fitted image preserves its fitted scale on restore', () => {
  const fitted = fitImage({ width: 100000, height: 100000 }, { width: 500, height: 500 })
  const moved = panImage(fitted, 5, 8)
  assert.deepEqual(imageViewState({ ...moved }), moved)
})
