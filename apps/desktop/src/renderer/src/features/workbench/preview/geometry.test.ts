import assert from 'node:assert/strict'
import test from 'node:test'

import { axisPositions, positionIndex, rangeBox, resizedSize } from './geometry.ts'

test('view sizes shift following cells without changing source sizes or hidden rows', () => {
  const source = [20, 0, 30, 40]
  const overrides = new Map([
    [0, 50],
    [1, 100],
  ])
  assert.deepEqual(
    axisPositions(source.length, (index) => source[index], overrides, 1),
    [0, 50, 50, 80, 120]
  )
  assert.deepEqual(source, [20, 0, 30, 40])
  assert.deepEqual(
    axisPositions(source.length, (index) => source[index], overrides, 1.5),
    [0, 75, 75, 120, 180]
  )
})

test('pointer movement is converted from zoomed pixels with bounded positive view sizes', () => {
  assert.equal(resizedSize('column', 120, 90, 1.5), 180)
  assert.equal(resizedSize('row', 28, -1000, 1), 14)
  assert.equal(resizedSize('column', 120, 100000, 1), 4096)
})

test('merged selection and editor bounds use the same resized positions', () => {
  const rows = axisPositions(3, () => 28, new Map([[0, 50]]), 1)
  const columns = axisPositions(3, () => 120, new Map([[0, 200]]), 1)
  assert.deepEqual(rangeBox({ rows, columns }, { top: 2, bottom: 3, left: 2, right: 3 }), {
    left: 200,
    top: 50,
    width: 240,
    height: 56,
  })
  assert.equal(positionIndex(columns, 201), 2)
  assert.equal(positionIndex(rows, 51), 2)
})

test('hidden coordinates and outside pointers resolve to bounded real grid indexes', () => {
  assert.equal(positionIndex([0, 20, 20, 50], 20), 3)
  assert.equal(positionIndex([0, 20, 20, 50], -10), 1)
  assert.equal(positionIndex([0, 20, 20, 50], 10000), 3)
})
