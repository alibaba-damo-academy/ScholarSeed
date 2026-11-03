import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { createComposerSubmission } from './submission.ts'
import { canConsumeDraftSubmission } from '../../input.ts'

test('the real composer effect waits for readiness and submits a project draft once', () => {
  const source = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
  const effect = `{${source.slice(
    source.indexOf('const draftSubmissionConsumed ='),
    source.indexOf('const composerKeyDown =')
  )}}`
  const consumed = { current: false }
  const state = { mainView: 'skills', composerSubmitRequested: true }
  let submissions = 0
  const context = {
    React: { useRef: () => consumed, useEffect: (callback: () => void) => callback() },
    state,
    surface: 'assistant',
    canSend: true,
    submittingMessage: false,
    nonConversationSurfaceOpen: false,
    canConsumeDraftSubmission,
    set: (patch: object) => Object.assign(state, patch),
    submit: () => {
      submissions++
      return Promise.resolve(true)
    },
  }
  runInNewContext(effect, context)
  assert.equal(submissions, 0)
  assert.equal(state.composerSubmitRequested, true)
  state.mainView = 'resource'
  context.canSend = false
  runInNewContext(effect, context)
  assert.equal(submissions, 0)
  assert.equal(state.composerSubmitRequested, true)
  context.canSend = true
  runInNewContext(effect, context)
  runInNewContext(effect, context)
  assert.equal(submissions, 1)
  assert.equal(state.composerSubmitRequested, false)
})

test('next-turn submission requires the active ready composer and nonempty text', async () => {
  const bridge = createComposerSubmission()
  let calls = 0
  const send = async () => {
    calls++
    return true
  }
  assert.equal(await bridge.submit('session-a', 'card', 'hello'), false)
  bridge.register({ sessionId: 'session-a', disabled: true, submit: send })
  assert.equal(bridge.getSnapshot(), null)
  assert.equal(await bridge.submit('session-a', 'card', 'hello'), false)
  bridge.register({ sessionId: 'session-a', disabled: false, submit: send })
  assert.equal(bridge.getSnapshot(), 'session-a')
  assert.equal(await bridge.submit('session-b', 'card', 'hello'), false)
  assert.equal(await bridge.submit('session-a', 'card', '  '), false)
  assert.equal(calls, 0)
})

test('next-turn submission is single-flight, preserves visible text and consumes only success', async () => {
  const bridge = createComposerSubmission()
  let resolve!: (result: boolean) => void
  const messages: string[] = []
  bridge.register({
    sessionId: 'session',
    disabled: false,
    submit: async (message) => {
      messages.push(message)
      return new Promise<boolean>((done) => {
        resolve = done
      })
    },
  })
  const first = bridge.submit('session', 'card', '  visible user text  ')
  assert.equal(bridge.getSnapshot(), null)
  assert.equal(await bridge.submit('session', 'card', 'duplicate'), false)
  resolve(false)
  assert.equal(await first, false)
  assert.equal(bridge.getSnapshot(), 'session')
  const retry = bridge.submit('session', 'card', '  visible user text  ')
  resolve(true)
  assert.equal(await retry, true)
  assert.equal(bridge.consumed('session', 'card'), true)
  assert.equal(await bridge.submit('session', 'card', 'duplicate'), false)
  assert.deepEqual(messages, ['  visible user text  ', '  visible user text  '])
})

test('registration cleanup and a late result cannot consume a different session card', async () => {
  const bridge = createComposerSubmission()
  let resolve!: (result: boolean) => void
  const cleanup = bridge.register({
    sessionId: 'old',
    disabled: false,
    submit: () =>
      new Promise<boolean>((done) => {
        resolve = done
      }),
  })
  const old = bridge.submit('old', 'card', 'hello')
  bridge.register({ sessionId: 'new', disabled: false, submit: async () => true })
  cleanup()
  resolve(true)
  await old
  assert.equal(bridge.getSnapshot(), 'new')
  assert.equal(bridge.consumed('old', 'card'), true)
  assert.equal(bridge.consumed('new', 'card'), false)
  assert.equal(await bridge.submit('new', 'card', 'next'), true)
})

test('a thrown submission releases the synchronous lock for retry', async () => {
  const bridge = createComposerSubmission()
  let fail = true
  bridge.register({
    sessionId: 'session',
    disabled: false,
    submit: async () => {
      if (fail) throw new Error('transport failed')
      return true
    },
  })
  await assert.rejects(bridge.submit('session', 'card', 'hello'), /transport failed/)
  fail = false
  assert.equal(await bridge.submit('session', 'card', 'hello'), true)
})
