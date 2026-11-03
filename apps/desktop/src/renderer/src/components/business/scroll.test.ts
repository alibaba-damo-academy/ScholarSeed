import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversationInlinePadding,
  createFollowScroll,
  createScrollbarVisibility,
  SCROLLBAR_IDLE_DELAY_MS,
} from './scroll.ts'

test('conversation padding compensates only the actual reserved scrollbar gutters', () => {
  assert.equal(
    conversationInlinePadding({ offsetWidth: 480, clientWidth: 480 }),
    'calc(var(--vds-space-4) - 0px)'
  )
  assert.equal(
    conversationInlinePadding({ offsetWidth: 480, clientWidth: 462 }),
    'calc(var(--vds-space-4) - 9px)'
  )
})

test('scrollbar appears only on scroll, resets idle delay and hides on leave or cleanup', () => {
  let visible = false
  const pending = new Map<number, () => void>()
  let sequence = 0
  const visibility = createScrollbarVisibility(
    (value) => {
      visible = value
    },
    (callback, delay) => {
      assert.equal(delay, SCROLLBAR_IDLE_DELAY_MS)
      pending.set(++sequence, callback)
      return sequence
    },
    (timer) => {
      pending.delete(timer)
    }
  )
  assert.equal(visible, false)
  visibility.scroll()
  assert.equal(visible, true)
  visibility.scroll()
  assert.equal(pending.size, 1)
  const callback = [...pending.values()][0]
  pending.clear()
  callback()
  assert.equal(visible, false)
  visibility.scroll()
  visibility.hide()
  assert.equal(visible, false)
  assert.equal(pending.size, 0)
})

function fixture() {
  const pending = new Map<number, FrameRequestCallback>()
  let sequence = 0
  let updates = 0
  const scroll = createFollowScroll(
    () => {
      updates += 1
    },
    (callback) => {
      pending.set(++sequence, callback)
      return sequence
    },
    (frame) => {
      pending.delete(frame)
    }
  )
  return {
    scroll,
    pending,
    updates: () => updates,
    flush: () => {
      const callbacks = [...pending.values()]
      pending.clear()
      callbacks.forEach((callback) => callback(0))
    },
  }
}

test('conversation and resize updates share one scroll per frame', () => {
  const state = fixture()
  state.scroll.request()
  state.scroll.request()
  assert.equal(state.pending.size, 1)
  state.flush()
  assert.equal(state.updates(), 1)
  state.scroll.request()
  state.flush()
  assert.equal(state.updates(), 2)
})

test('reading pauses pending and future following until explicitly resumed', () => {
  const state = fixture()
  state.scroll.request()
  state.scroll.pause()
  state.scroll.request()
  state.flush()
  assert.equal(state.updates(), 0)
  state.scroll.resume()
  state.scroll.request()
  state.flush()
  assert.equal(state.updates(), 1)
})

test('cleanup cancels pending work without disabling subsequent following', () => {
  const state = fixture()
  state.scroll.request()
  state.scroll.cancel()
  state.flush()
  assert.equal(state.updates(), 0)
  state.scroll.request()
  state.flush()
  assert.equal(state.updates(), 1)
})
