import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createPageActions, pageFindShortcut } from './page.ts'
import { PAGE_ZOOM_FACTORS } from '../browser.ts'

function fixture() {
  let alive = true
  let epoch = 1
  let factor = 1
  let requestId = 0
  let printCallback: ((success: boolean, reason: string) => void) | null = null
  let busy = false
  const calls: unknown[] = []
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => !alive,
    setZoomMode: (mode: string) => calls.push(mode),
    setZoomFactor: (value: number) => {
      factor = value
    },
    getZoomFactor: () => factor,
    findInPage: (text: string, options: unknown) => {
      calls.push({ text, options })
      return ++requestId
    },
    stopFindInPage: (action: string) => calls.push(action),
    print: (options: unknown, callback: (success: boolean, reason: string) => void) => {
      calls.push(options)
      printCallback = callback
    },
  })
  const owner = createPageActions({
    contents,
    current: () => (alive ? epoch : null),
    acquirePrint: () => {
      if (busy) return null
      busy = true
      return () => {
        busy = false
      }
    },
  })
  return {
    owner,
    contents,
    calls,
    change: () => {
      epoch += 1
      owner.invalidate()
    },
    destroy: () => {
      alive = false
      owner.dispose()
    },
    finish: (success: boolean, reason = '') => printCallback!(success, reason),
  }
}

test('find filters old requests and invalidation even after returning to a previous tab', () => {
  const probe = fixture()
  const results: unknown[] = []
  probe.owner.find({ text: 'one', direction: 'forward', querySequence: 1 }, (state) =>
    results.push(state)
  )
  probe.owner.find({ text: 'two', direction: 'forward', querySequence: 2 }, (state) =>
    results.push(state)
  )
  probe.contents.emit(
    'found-in-page',
    {},
    { requestId: 1, activeMatchOrdinal: 1, matches: 4, finalUpdate: true }
  )
  assert.equal(results.length, 2)
  probe.contents.emit(
    'found-in-page',
    {},
    { requestId: 2, activeMatchOrdinal: 1, matches: 2, finalUpdate: true }
  )
  assert.equal((results.at(-1) as { count: number }).count, 2)
  probe.change()
  probe.contents.emit(
    'found-in-page',
    {},
    { requestId: 2, activeMatchOrdinal: 2, matches: 2, finalUpdate: true }
  )
  assert.equal(results.length, 3)
  probe.destroy()
  assert.equal(probe.contents.listenerCount('found-in-page'), 0)
})

test('find uses Electron 44 new-session semantics and clears before empty queries', () => {
  const probe = fixture()
  const callback = () => undefined
  probe.owner.find({ text: 'word', direction: 'forward', querySequence: 1 }, callback)
  probe.owner.find({ text: 'word', direction: 'backward', querySequence: 2 }, callback)
  assert.deepEqual(
    probe.calls.filter((call) => typeof call === 'object'),
    [
      { text: 'word', options: { forward: true, findNext: true } },
      { text: 'word', options: { forward: false, findNext: false } },
    ]
  )
  probe.owner.find({ text: '', direction: 'forward', querySequence: 3 }, callback)
  assert.equal(probe.calls.at(-1), 'clearSelection')
  assert.throws(() =>
    probe.owner.find({ text: 'stale', direction: 'forward', querySequence: 2 }, callback)
  )
})

test('zoom is isolated at construction and rejects values outside the exact table', () => {
  const first = fixture(),
    second = fixture()
  assert.equal(first.calls[0], 'isolated')
  for (const factor of PAGE_ZOOM_FACTORS) assert.equal(first.owner.setZoom(factor), factor)
  assert.equal(second.owner.zoom(), 1)
  assert.throws(() => first.owner.setZoom(1.21))
  assert.equal(first.owner.setZoom(1), 1)
})

test('print has real callback outcomes, duplicate exclusion and stale result rejection', async () => {
  for (const [success, reason, status] of [
    [true, '', 'success'],
    [false, 'Print job canceled', 'canceled'],
    [false, 'Print job failed', 'failed'],
  ] as const) {
    const probe = fixture()
    const pending = probe.owner.print()
    await assert.rejects(probe.owner.print(), /print_busy/)
    probe.finish(success, reason)
    assert.equal((await pending).status, status)
    assert.deepEqual(probe.calls.at(-1), { silent: false })
  }
  const probe = fixture()
  const pending = probe.owner.print()
  probe.change()
  probe.finish(true)
  await assert.rejects(pending, /target_closed/)
})

test('find shortcut excludes IME, keyup, wrong platform modifiers and other keys', () => {
  const input = {
    type: 'keyDown',
    key: 'f',
    control: true,
    meta: false,
    shift: false,
    alt: false,
    isComposing: false,
  }
  assert.equal(pageFindShortcut(input, 'win32'), true)
  assert.equal(pageFindShortcut({ ...input, control: false, meta: true }, 'darwin'), true)
  for (const changed of [{ type: 'keyUp' }, { isComposing: true }, { alt: true }, { key: 'l' }])
    assert.equal(pageFindShortcut({ ...input, ...changed }, 'win32'), false)
  assert.equal(pageFindShortcut(input, 'darwin'), false)
})

test('print remains pending past menu TTL and disposal settles without claiming OS cancellation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const probe = fixture()
  const pending = probe.owner.print()
  let settled = false
  const observed = pending.then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      assert.match(error.message, /target_closed/)
    }
  )
  context.mock.timers.tick(20_000)
  await Promise.resolve()
  assert.equal(settled, false)
  probe.destroy()
  await Promise.resolve()
  assert.equal(settled, true)
  probe.finish(true)
  await observed
})

test('renderer crash retires pending print without poisoning recovery', async () => {
  const probe = fixture()
  const pending = probe.owner.print()
  const rejection = assert.rejects(pending, /target_closed/)
  probe.owner.crash()
  await rejection
  const recovered = probe.owner.print()
  probe.finish(false, 'Print job canceled')
  assert.deepEqual(await recovered, { status: 'canceled' })
})
