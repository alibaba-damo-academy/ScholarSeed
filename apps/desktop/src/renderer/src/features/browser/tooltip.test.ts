import assert from 'node:assert/strict'
import test from 'node:test'
import { tooltipPaint } from './tooltip.ts'

const CONTENT = { x: 55.5, y: 125, width: 68, height: 30 }
const VIEWPORT = { width: 1280, height: 840 }
const SHADOW = 'rgba(0, 0, 0, 0.1) 2px 4px 12px 0px'

test('tooltip shadow paint extent preserves fractional source content geometry', () => {
  assert.deepEqual(tooltipPaint(CONTENT, SHADOW, VIEWPORT), {
    bounds: { x: 39.5, y: 111, width: 104, height: 66 },
    tooltipBounds: { x: 16, y: 14, width: 68, height: 30 }
  })
})

test('tooltip multiple shadows preserve rgba commas and union directional paint extent', () => {
  assert.deepEqual(tooltipPaint(CONTENT, `${SHADOW}, rgba(0, 0, 0, 0.4) -10px -20px 16px 2px`, VIEWPORT), {
    bounds: { x: 19.5, y: 79, width: 124, height: 98 },
    tooltipBounds: { x: 36, y: 46, width: 68, height: 30 }
  })
})

test('tooltip paint clips only window-edge shadows without moving or resizing source', () => {
  const source = { x: 212, y: 170, width: 68, height: 30 }
  assert.deepEqual(tooltipPaint(source, SHADOW, { width: 280, height: 200 }), {
    bounds: { x: 196, y: 156, width: 84, height: 44 },
    tooltipBounds: { x: 16, y: 14, width: 68, height: 30 }
  })
  assert.deepEqual(tooltipPaint({ ...source, x: 0, y: 0 }, SHADOW, VIEWPORT).tooltipBounds, { x: 0, y: 0, width: 68, height: 30 })
})

test('tooltip unknown shadow syntax and out-of-window content fail rather than dropping paint', () => {
  assert.throws(() => tooltipPaint(CONTENT, 'unknown-shadow', VIEWPORT), /invalid_command/)
  assert.throws(() => tooltipPaint(CONTENT, '0px 0px -2px', VIEWPORT), /invalid_command/)
  assert.throws(() => tooltipPaint(CONTENT, SHADOW, { width: 60, height: 130 }), /invalid_command/)
})
