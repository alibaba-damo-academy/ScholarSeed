import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from 'electron'
import { validatePluginBinding } from './skills.ts'
import { REFERENCE, HOST_HEADERS } from './binding.fixture.ts'

const BASE = 'http://127.0.0.1:51823'

function sessionWith(fetcher: typeof fetch): Pick<Session, 'fetch'> {
  return { fetch: fetcher }
}

for (const status of [200, 403]) {
  test(`binding validation consumes the complete ${status} response`, async () => {
    let chunks = 0
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks === 3) controller.close()
          else {
            chunks += 1
            controller.enqueue(new Uint8Array(32))
          }
        },
      }),
      { status }
    )
    const session = sessionWith(async (input, init) => {
      assert.equal(input, `${BASE}/api/capabilities/skills/plugins/binding`)
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json')
      assert.equal(new Headers(init?.headers).get('x-test-host-key'), 'test-host')
      assert.deepEqual(JSON.parse(String(init?.body)), { reference: REFERENCE })
      return response
    })
    assert.equal(await validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS), status)
    assert.equal(response.bodyUsed, true)
    assert.equal(response.body?.locked, false)
    assert.equal(chunks, 3)
  })
}

test('binding validation accepts an empty response', async () => {
  const session = sessionWith(async () => new Response(null, { status: 204 }))
  assert.equal(await validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS), 204)
})

test('binding validation aborts the original request when the body fails', async () => {
  const failure = new Error('response_disconnected')
  let signal: AbortSignal | null | undefined
  const session = sessionWith(async (_input, init) => {
    signal = init?.signal
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.error(failure)
        },
      })
    )
  })
  await assert.rejects(validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS), failure)
  assert.equal(signal?.aborted, true)
})

test('binding validation aborts both a stalled fetch and a stalled body', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const phase of ['headers', 'body']) {
    let signal: AbortSignal | null | undefined
    const session = sessionWith(async (_input, init) => {
      signal = init?.signal
      if (phase === 'headers')
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        })
      return new Response(
        new ReadableStream({
          start(controller) {
            signal!.addEventListener('abort', () => controller.error(signal!.reason), {
              once: true,
            })
          },
        })
      )
    })
    const pending = validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS)
    const rejected = assert.rejects(pending, /plugin_binding_timeout/)
    await Promise.resolve()
    context.mock.timers.tick(10_000)
    await rejected
    assert.equal(signal?.aborted, true)
  }
})

test('binding validation aborts the completed request and clears its deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | null | undefined
  const session = sessionWith(async (_input, init) => {
    signal = init?.signal
    return new Response('{}')
  })
  await validatePluginBinding(session, BASE, REFERENCE, HOST_HEADERS)
  assert.equal(signal?.aborted, true)
  const reason = signal?.reason
  context.mock.timers.tick(10_000)
  assert.equal(signal?.reason, reason)
})
