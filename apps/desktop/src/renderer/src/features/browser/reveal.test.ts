import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserReveal, PageReply } from '../../../../browser'
import { subscribeBrowserReveal } from './reveal.ts'

const TARGET = { tabId: 'tab', instanceId: 'instance', navigationId: 1 }

test('browser reveal requires the foreground conversation and exact current target', async () => {
  let listener!: (request: BrowserReveal) => void
  let reveals = 0
  let current = 'session'
  let result: PageReply = { ok: true, target: TARGET }
  const dispose = subscribeBrowserReveal({
    subscribeReveal(callback) { listener = callback; return () => {} },
    page: async () => result,
  }, () => current, () => { reveals += 1 })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  listener({ sessionId: 'other', target: TARGET })
  await settle()
  assert.equal(reveals, 0)
  listener({ sessionId: 'session', target: TARGET })
  await settle()
  assert.equal(reveals, 1)
  result = { ok: true, target: { ...TARGET, navigationId: 2 } }
  listener({ sessionId: 'session', target: TARGET })
  await settle()
  assert.equal(reveals, 1)
  result = { ok: true, target: TARGET }
  listener({ sessionId: 'session', target: TARGET })
  current = 'other'
  await settle()
  assert.equal(reveals, 1)
  current = 'session'
  listener({ sessionId: 'session', target: TARGET })
  dispose()
  await settle()
  assert.equal(reveals, 1)
})
