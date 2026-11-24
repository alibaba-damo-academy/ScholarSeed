import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { flushApiDiagnostics } from './app/api/diagnostics.ts'
import type { Thread } from './model.ts'
import { prepareStartupSession, projectResumedSession } from './resume.ts'

const SESSION_ID = 'saved-session'
const INITIAL_THREAD: Thread = {
  id: SESSION_ID,
  title: 'Saved task',
  sessionId: SESSION_ID,
  conversation: [],
  lastSeq: 0,
}
const OPENED = {
  session_id: SESSION_ID,
  running: false,
  active_turn_id: null,
  last_turn_id: 'old-turn',
  unknown_outcome: false,
  uncertain_operations: [],
  last_seq: 41,
}
const HISTORY = {
  turns: [{ kind: 'text', role: 'assistant', turn_id: 'old-turn', text: 'Saved answer' }],
}

function useTestRequests(context: TestContext, fetch: typeof globalThis.fetch): void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: { getApiBase: () => '' } },
  })
  context.mock.method(globalThis, 'fetch', fetch)
  context.after(() => {
    flushApiDiagnostics()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
}

for (const result of ['denied', 'rejected'] as const)
  test(`startup reports the ${result} session root and stops before reading history or the queue`, async (context) => {
    const runtimeRoot = '/fixture/session workspace'
    const requests: string[] = []
    useTestRequests(context, async (input) => {
      requests.push(String(input))
      return Response.json({
        ...OPENED,
        last_turn_status: 'completed',
        runtime_workdir: runtimeRoot,
      })
    })
    window.scholarseed.addAuthorizedRoot = async (scope, root) => {
      assert.equal(scope, 'session')
      assert.equal(root, runtimeRoot)
      if (result === 'rejected') throw new Error('IPC unavailable')
      return false
    }
    const warning = context.mock.method(console, 'warn', () => {})
    assert.equal(await prepareStartupSession(SESSION_ID, new AbortController().signal), null)
    assert.deepEqual(requests, ['/api/serve/sessions/open'])
    assert.equal(warning.mock.callCount(), 1)
    const [prefix, detail] = warning.mock.calls[0].arguments
    assert.equal(prefix, '[session-recovery]')
    assert.deepEqual(JSON.parse(detail), {
      stage: 'startup-root-denied',
      sessionId: SESSION_ID,
      runtimeRoot,
    })
  })

for (const [running, lastTurnStatus, expectedStatus] of [
  [false, 'failed', 'failed'],
  [false, 'interrupted', 'abandon'],
  [false, 'completed', 'done'],
  [true, 'failed', 'running'],
] as const) {
  test(
    `startup shows ${expectedStatus} for ${lastTurnStatus} history without waiting for the queue`,
    {
      timeout: 2_000,
    },
    async (context) => {
      const requests: string[] = []
      useTestRequests(context, async (input, init) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/open')) {
          assert.deepEqual(JSON.parse(String(init?.body)), { resume_session_id: SESSION_ID })
          return Response.json({ ...OPENED, running, last_turn_status: lastTurnStatus })
        }
        return Response.json(HISTORY)
      })
      const controller = new AbortController()
      const snapshot = await prepareStartupSession(SESSION_ID, controller.signal)
      assert.ok(snapshot)
      assert.equal(controller.signal.aborted, false)
      assert.deepEqual(requests, [
        '/api/serve/sessions/open',
        `/api/serve/history/${SESSION_ID}?compact_activity=true`,
      ])
      const restored = projectResumedSession(INITIAL_THREAD, {
        ...snapshot,
        serviceInstanceId: 'instance',
        timestamp: 1,
      })
      assert.equal(restored.resumeState, 'ready')
      assert.equal(restored.resumeServiceInstanceId, 'instance')
      assert.equal(restored.lastSeq, 41)
      assert.equal(restored.status, expectedStatus)
      assert.equal(restored.turnOutcomes?.['old-turn'], lastTurnStatus)
      assert.ok(
        restored.conversation.some((item) => item.kind === 'agent' && item.text === 'Saved answer')
      )
    }
  )
}

test(
  'a clear startup history failure starts no background queue read',
  {
    timeout: 2_000,
  },
  async (context) => {
    const paths: string[] = []
    useTestRequests(context, async (input) => {
      const url = String(input)
      paths.push(url)
      if (url.endsWith('/open')) return Response.json({ ...OPENED, last_turn_status: 'completed' })
      return new Response(null, { status: 503 })
    })
    assert.equal(await prepareStartupSession(SESSION_ID, new AbortController().signal), null)
    assert.deepEqual(paths, [
      '/api/serve/sessions/open',
      `/api/serve/history/${SESSION_ID}?compact_activity=true`,
    ])
  }
)

test('canceling startup invalidates the history body even if the transport returns late', async (context) => {
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  useTestRequests(context, async (input, init) => {
    const url = String(input)
    if (url.endsWith('/open')) return Response.json({ ...OPENED, last_turn_status: 'completed' })
    signals.push(init!.signal!)
    controller.abort()
    return Response.json(HISTORY)
  })
  assert.equal(await prepareStartupSession(SESSION_ID, controller.signal), null)
  assert.equal(signals.length, 1)
  assert.ok(signals.every((signal) => signal.aborted))
})
