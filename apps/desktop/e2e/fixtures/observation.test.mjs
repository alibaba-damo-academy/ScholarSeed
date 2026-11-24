import assert from 'node:assert/strict'
import { basename } from 'node:path'
import test from 'node:test'
import { captureFirstScreen, observeOldTurn } from './observation.mjs'

const options = { oldTurn: 'turn-1', checkOldSources: true }
const deadline = 1000

function observe(page, emit) {
  return observeOldTurn(page, options, '/unused', emit, deadline)
}

test('first-screen screenshot shares the window and retains the earlier visibility evidence', async (t) => {
  let now = deadline - 1
  t.mock.method(Date, 'now', () => now)
  const events = []
  const firstScreen = {}
  const page = {
    async waitForFunction() {
      return { jsonValue: async () => now }
    },
    async screenshot({ path, timeout }) {
      assert.equal(basename(path), 'history-visible.png')
      assert.equal(timeout, 1)
      now = deadline
      throw Object.assign(new Error('screenshot timeout'), { name: 'TimeoutError' })
    },
  }
  await assert.rejects(
    captureFirstScreen(
      page,
      {
        lastTurnId: 'tail',
        desktopStartedAt: 0,
        artifact: '/unused',
        profileHistory: false,
        emit: (event) => events.push(event),
        deadline,
      },
      firstScreen
    ),
    /window exhausted during first history screen/
  )
  assert.deepEqual(events, ['history_visible'])
  assert.equal(firstScreen.visibleAt, deadline - 1)
})

test('an exhausted observation window never starts the older-turn scroll', async (t) => {
  t.mock.method(Date, 'now', () => deadline)
  const scroll = t.mock.fn()
  await assert.rejects(
    observe({ locator: scroll }, scroll),
    /window exhausted during scrolling to older turn turn-1/
  )
  assert.equal(scroll.mock.callCount(), 0)
})

test('a hover limited by the last millisecond reports the round deadline', async (t) => {
  let now = deadline - 1
  t.mock.method(Date, 'now', () => now)
  const events = []
  const page = {
    locator: () => ({
      async hover({ timeout }) {
        assert.equal(timeout, 1)
        now = deadline
        throw Object.assign(new Error('hover timeout'), { name: 'TimeoutError' })
      },
    }),
  }
  await assert.rejects(
    observe(page, (event) => events.push(event)),
    /window exhausted during scrolling to older turn turn-1/
  )
  assert.deepEqual(events, ['older_turn_scroll_started'])
})

test('a missing stream before the round deadline retains the locator error', async (t) => {
  t.mock.method(Date, 'now', () => 100)
  const failure = Object.assign(new Error('missing stream'), { name: 'TimeoutError' })
  const page = {
    locator: () => ({
      hover: async () => {
        throw failure
      },
    }),
  }
  await assert.rejects(
    observe(page, () => {}),
    (error) => error === failure
  )
})

for (const expireAtScreenshot of [false, true]) {
  test(
    expireAtScreenshot
      ? 'finishing the older-turn screenshot at the deadline does not click sources'
      : 'scroll and source evidence preserve their event and screenshot order',
    async (t) => {
      let now = 100
      t.mock.method(Date, 'now', () => now)
      const events = []
      const locator = {
        first() {
          return this
        },
        last() {
          return this
        },
        getByRole() {
          return this
        },
        locator() {
          return this
        },
        async boundingBox() {
          return { y: 0, height: 100 }
        },
        async hover() {
          events.push('hover')
        },
        async click() {
          events.push('click')
        },
        async waitFor() {},
      }
      const page = {
        locator: () => locator,
        async screenshot({ path }) {
          events.push(basename(path))
          if (expireAtScreenshot) now = deadline
        },
      }
      const result = observe(page, (event) => events.push(event))
      const scroll = ['older_turn_scroll_started', 'hover', 'older_turn_visible', 'older-turn.png']
      if (expireAtScreenshot) {
        await assert.rejects(
          result,
          /window exhausted during opening sources for older turn turn-1/
        )
        assert.deepEqual(events, scroll)
      } else {
        await result
        assert.deepEqual(events, [
          ...scroll,
          'click',
          'older_turn_sources_opened',
          'older-sources.png',
        ])
      }
    }
  )
}
