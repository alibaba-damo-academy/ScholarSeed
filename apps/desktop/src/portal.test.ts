import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePortalBounds } from './portal.ts'

test('native portal bounds accept only finite nonnegative own data fields', () => {
  const rectangle = { x: 10.25, y: 30, width: 388, height: 56 }
  assert.deepEqual(parsePortalBounds(rectangle), rectangle)
  assert.notEqual(parsePortalBounds(rectangle), rectangle)
  for (const invalid of [
    null,
    [],
    { ...rectangle, width: 0 },
    { ...rectangle, height: Infinity },
    { ...rectangle, x: -1 },
    { ...rectangle, extra: 1 },
    Object.create(rectangle),
    { ...rectangle, [Symbol('extra')]: true },
  ]) {
    assert.equal(parsePortalBounds(invalid), null)
  }
  let getterCalled = false
  const accessor = { ...rectangle }
  Object.defineProperty(accessor, 'width', {
    get() {
      getterCalled = true
      return 388
    },
  })
  assert.equal(parsePortalBounds(accessor), null)
  assert.equal(getterCalled, false)
})
