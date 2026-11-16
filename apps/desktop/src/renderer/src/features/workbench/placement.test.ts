import assert from 'node:assert/strict'
import test from 'node:test'
import {
  constrainSelectionSurface,
  selectionSurfaceBoundary,
  selectionSurfacePosition,
} from './placement.ts'

test('expanded surfaces can use the viewport height instead of shrinking beside the selection', () => {
  const result = selectionSurfacePosition(
    { left: 100, right: 600, top: 280, bottom: 340 },
    { width: 500, height: 360 },
    { width: 800, height: 600 },
    { allowOverlap: true }
  )
  assert.equal(result.height, 360)
  assert.ok(result.top >= 12)
  assert.ok(result.top + result.height <= 588)
})

test('floating results avoid the full selected rectangle, not only the mouse endpoint', () => {
  const bounds = { left: 100, right: 700, top: 360, bottom: 520 }
  const result = selectionSurfacePosition(
    bounds,
    { width: 500, height: 400 },
    { width: 800, height: 600 }
  )
  assert.ok(result.top + result.height <= bounds.top)
  assert.ok(result.left >= 12)
  assert.ok(result.left + result.width <= 788)
})

test('short space reduces the result height and keeps the selected text clear', () => {
  const bounds = { left: 100, right: 700, top: 100, bottom: 350 }
  const result = selectionSurfacePosition(
    bounds,
    { width: 500, height: 400 },
    { width: 800, height: 600 }
  )
  assert.ok(result.top >= bounds.bottom)
  assert.ok(result.height < 400)
  assert.ok(result.top + result.height <= 588)
})

test('PDF surfaces stay within the inset reader boundary even when the selection scrolls away', () => {
  const boundary = { left: 620, right: 1180, top: 160, bottom: 760 }
  for (const top of [-800, 180, 700, 1600]) {
    const result = selectionSurfacePosition(
      { left: 700, right: 1100, top, bottom: top + 40 },
      { width: 900, height: 1000 },
      { width: 1400, height: 900 },
      { allowOverlap: true, boundary }
    )
    assert.ok(result.left >= boundary.left)
    assert.ok(result.top >= boundary.top)
    assert.ok(result.left + result.width <= boundary.right)
    assert.ok(result.top + result.height <= boundary.bottom)
  }
})

test('reader insets and constrained geometry remain valid after the reader shrinks', () => {
  const boundary = selectionSurfaceBoundary({ left: 600, top: 140, right: 1200, bottom: 780 }, 20)
  assert.deepEqual(boundary, { left: 620, top: 160, right: 1180, bottom: 760 })
  const surface = constrainSelectionSurface(
    { left: 0, top: 0, width: 1600, height: 1200 },
    boundary
  )
  assert.deepEqual(surface, { left: 620, top: 160, width: 560, height: 600 })
  const narrow = selectionSurfaceBoundary({ left: 900, top: 200, right: 1200, bottom: 640 }, 20)
  assert.deepEqual(constrainSelectionSurface(surface, narrow), {
    left: 920,
    top: 220,
    width: 260,
    height: 400,
  })
})
