import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { createTurnSourceViewport } from './viewport.ts'

function viewportFixture(context: TestContext) {
  const anchor = { dataset: { turnId: 'turn' } }
  const column = { querySelectorAll: () => [anchor] } as unknown as Element
  const intersections: Intersections[] = []
  const mutations: Mutations[] = []
  class Intersections {
    observe = context.mock.fn()
    disconnect = context.mock.fn()
    enter: () => void
    constructor(notify: (entries: unknown[]) => void) {
      this.enter = () =>
        notify([
          { target: anchor, isIntersecting: true, intersectionRect: { width: 1, height: 1 } },
        ])
      intersections.push(this)
    }
  }
  class Mutations {
    observe = context.mock.fn()
    disconnect = context.mock.fn()
    constructor() {
      mutations.push(this)
    }
  }
  for (const [key, value] of Object.entries({
    IntersectionObserver: Intersections,
    MutationObserver: Mutations,
    getComputedStyle: () => ({ display: 'block' }),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true })
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  return { viewport: createTurnSourceViewport(), column, intersections, mutations }
}

test('failed source loads release their slots and can be invalidated again', async (context) => {
  const { viewport, column, intersections } = viewportFixture(context)
  const calls: string[] = []
  const reader = viewport.watch('turn', () => {
    calls.push('throw')
    throw new Error('synchronous failure')
  })
  viewport.watch('turn', async () => {
    calls.push('reject')
    throw new Error('asynchronous failure')
  })
  viewport.watch('turn', async () => {
    calls.push('next')
  })
  const stop = viewport.observe(null, column)
  intersections[0].enter()
  await setImmediate()
  assert.deepEqual(calls, ['throw', 'reject', 'next'])
  reader.invalidate()
  await setImmediate()
  assert.deepEqual(calls, ['throw', 'reject', 'next', 'throw'])
  stop()
})

test('replacing the observed viewport disconnects both observers and ignores stale cleanup', async (context) => {
  const { viewport, column, intersections, mutations } = viewportFixture(context)
  const load = context.mock.fn(async () => {})
  viewport.watch('turn', load)
  const stopFirst = viewport.observe(null, column)
  intersections[0].enter()
  await setImmediate()
  const stopSecond = viewport.observe(null, column)
  assert.equal(intersections[0].disconnect.mock.callCount(), 1)
  assert.equal(mutations[0].disconnect.mock.callCount(), 1)
  assert.equal(intersections[1].observe.mock.callCount(), 1)
  const nextLoad = context.mock.fn(async () => {})
  viewport.watch('turn', nextLoad)
  stopFirst()
  intersections[0].enter()
  assert.equal(nextLoad.mock.callCount(), 0)
  intersections[1].enter()
  assert.equal(nextLoad.mock.callCount(), 1)
  assert.equal(load.mock.callCount(), 1)
  stopSecond()
  assert.equal(intersections[1].disconnect.mock.callCount(), 1)
  assert.equal(mutations[1].disconnect.mock.callCount(), 1)
})
