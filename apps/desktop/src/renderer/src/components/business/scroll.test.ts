import assert from 'node:assert/strict'
import test from 'node:test'
import { createFollowScroll } from './scroll.ts'

function fixture() {
  const pending = new Map<number, FrameRequestCallback>()
  let sequence = 0
  let updates = 0
  const scroll = createFollowScroll(
    () => { updates += 1 },
    (callback) => { pending.set(++sequence, callback); return sequence },
    (frame) => { pending.delete(frame) }
  )
  return {
    scroll,
    pending,
    updates: () => updates,
    flush: () => {
      const callbacks = [...pending.values()]
      pending.clear()
      callbacks.forEach((callback) => callback(0))
    }
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
