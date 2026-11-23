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

function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  )
}

for (const [lastTurnStatus, expectedStatus] of [
  ['failed', 'failed'],
  ['interrupted', 'abandon'],
] as const) {
  test(
    `startup renders ${lastTurnStatus} history without waiting for an unavailable queue`,
    {
      timeout: 2_000,
    },
    async (context) => {
      let queueSignal: AbortSignal | undefined
      const requests: string[] = []
      useTestRequests(context, async (input, init) => {
        const url = String(input)
        requests.push(url)
        if (url.endsWith('/open')) {
          assert.deepEqual(JSON.parse(String(init?.body)), { resume_session_id: SESSION_ID })
          return Response.json({ ...OPENED, last_turn_status: lastTurnStatus })
        }
        if (url.endsWith('/queue')) {
          queueSignal = init!.signal!
          return waitForAbort(queueSignal)
        }
        return Response.json(HISTORY)
      })
      const controller = new AbortController()
      const snapshot = await prepareStartupSession(SESSION_ID, controller.signal)
      assert.ok(snapshot)
      assert.equal(snapshot.queuedMessages, null)
      assert.equal(queueSignal?.aborted, true)
      assert.equal(controller.signal.aborted, false)
      assert.deepEqual(requests, [
        '/api/serve/sessions/open',
        `/api/serve/sessions/${SESSION_ID}/queue`,
        `/api/serve/history/${SESSION_ID}`,
      ])
      const restored = projectResumedSession(INITIAL_THREAD, {
        ...snapshot,
        serviceInstanceId: 'instance',
        acknowledgeQueue: false,
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
  'a clear startup history failure releases an outstanding queue read',
  {
    timeout: 2_000,
  },
  async (context) => {
    let queueAborted = false
    useTestRequests(context, async (input, init) => {
      const url = String(input)
      if (url.endsWith('/open')) return Response.json({ ...OPENED, last_turn_status: 'completed' })
      if (url.endsWith('/queue')) {
        const signal = init!.signal!
        signal.addEventListener(
          'abort',
          () => {
            queueAborted = true
          },
          { once: true }
        )
        return waitForAbort(signal)
      }
      return new Response(null, { status: 503 })
    })
    assert.equal(await prepareStartupSession(SESSION_ID, new AbortController().signal), null)
    assert.equal(queueAborted, true)
  }
)

test('canceling startup invalidates history and queue body reads even if the transport returns late', async (context) => {
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  useTestRequests(context, async (input, init) => {
    const url = String(input)
    if (url.endsWith('/open')) return Response.json({ ...OPENED, last_turn_status: 'completed' })
    signals.push(init!.signal!)
    if (url.endsWith('/queue')) return waitForAbort(init!.signal!)
    controller.abort()
    return Response.json(HISTORY)
  })
  assert.equal(await prepareStartupSession(SESSION_ID, controller.signal), null)
  assert.equal(signals.length, 2)
  assert.ok(signals.every((signal) => signal.aborted))
})
