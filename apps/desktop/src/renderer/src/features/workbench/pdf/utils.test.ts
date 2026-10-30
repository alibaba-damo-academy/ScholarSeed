import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestIntersection } from './utils.ts'

test('PDF visibility uses the latest transition in a batched observer callback', () => {
  assert.equal(latestIntersection([
    { time: 10, isIntersecting: false },
    { time: 20, isIntersecting: true }
  ])?.isIntersecting, true)
  assert.equal(latestIntersection([
    { time: 10, isIntersecting: true },
    { time: 20, isIntersecting: false }
  ])?.isIntersecting, false)
})

test('PDF visibility selects the newest timestamp and preserves arrival order on ties', () => {
  assert.equal(latestIntersection([
    { time: 20, isIntersecting: true },
    { time: 10, isIntersecting: false }
  ])?.isIntersecting, true)
  assert.equal(latestIntersection([
    { time: 20, isIntersecting: false },
    { time: 20, isIntersecting: true }
  ])?.isIntersecting, true)
})

test('PDF visibility handles empty and single-entry callbacks', () => {
  assert.equal(latestIntersection([]), undefined)
  assert.equal(latestIntersection([{ time: 10, isIntersecting: true }])?.isIntersecting, true)
})
