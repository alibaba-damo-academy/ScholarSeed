import assert from 'node:assert/strict'
import test from 'node:test'

import { pdfWheelScale } from './zoom.ts'

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const VIEWPORT_HEIGHT = 800
const TRACKPAD_DELTA_PX = -4
const TRACKPAD_EVENTS_PER_GESTURE = 12
const COARSE_WHEEL_DELTA_PX = -100
const MIN_USEFUL_GESTURE_SCALE = 1.3
const MAX_COMFORTABLE_GESTURE_SCALE = 1.4

test('PDF wheel zoom accepts Control and Command modifiers without consuming ordinary scrolling', () => {
  assert.equal(pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -100, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: false, metaKey: false }), null)
  assert.equal(pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -100, deltaMode: 3, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false }), null)
  assert.ok((pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -100, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false }) ?? 0) > 1)
  assert.ok((pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: 100, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: false, metaKey: true }) ?? 1) < 1)
})

test('PDF wheel zoom keeps fine trackpad deltas continuous and directionally symmetric', () => {
  const zoomedOnce = pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -4, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })!
  const zoomedTwice = pdfWheelScale({ scale: zoomedOnce, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -4, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })!
  const zoomedCombined = pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -8, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })!

  assert.ok(zoomedOnce > 1 && zoomedOnce < zoomedTwice)
  assert.ok(Math.abs(zoomedTwice - zoomedCombined) < Number.EPSILON)
  assert.ok(Math.abs(pdfWheelScale({ scale: zoomedOnce, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: 4, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })! - 1) < Number.EPSILON)
})

test('PDF wheel zoom reaches a useful scale in one fine gesture without coarse-wheel overshoot', () => {
  let gestureScale = 1
  for (let index = 0; index < TRACKPAD_EVENTS_PER_GESTURE; index += 1) {
    gestureScale = pdfWheelScale({ scale: gestureScale, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: TRACKPAD_DELTA_PX, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })!
  }
  const coarseWheelScale = pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: COARSE_WHEEL_DELTA_PX, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })!

  assert.ok(gestureScale >= MIN_USEFUL_GESTURE_SCALE && gestureScale <= MAX_COMFORTABLE_GESTURE_SCALE)
  assert.ok(coarseWheelScale >= MIN_USEFUL_GESTURE_SCALE && coarseWheelScale <= MAX_COMFORTABLE_GESTURE_SCALE)
})

test('PDF wheel zoom normalizes line and page deltas and clamps extreme input', () => {
  const line = pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -3, deltaMode: 1, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })!
  const pixels = pdfWheelScale({ scale: 1, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -48, deltaMode: 0, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false })!

  assert.equal(line, pixels)
  assert.equal(pdfWheelScale({ scale: MAX_SCALE, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: -100_000, deltaMode: 2, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: true, metaKey: false }), MAX_SCALE)
  assert.equal(pdfWheelScale({ scale: MIN_SCALE, minScale: MIN_SCALE, maxScale: MAX_SCALE, deltaY: 100_000, deltaMode: 2, viewportHeight: VIEWPORT_HEIGHT, ctrlKey: false, metaKey: true }), MIN_SCALE)
})
