import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { PRODUCT_EVENT_SCHEMA_VERSION, streamEvents } from './api.ts'

class Connection extends EventTarget {
  static instances: Connection[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    super()
    Connection.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
  message(seq: number): void {
    this.onmessage?.({
      data: JSON.stringify({
        v: PRODUCT_EVENT_SCHEMA_VERSION,
        session_id: 'session',
        seq,
        type: 'turn_completed',
        ts: 1,
        data: {},
      }),
    })
  }
}

function environment(context: TestContext): {
  window: EventTarget
  document: EventTarget & { visibilityState: string }
  advance: (duration: number) => void
  jump: (duration: number) => void
} {
  Connection.instances = []
  let now = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const window = Object.assign(new EventTarget(), {
    scholarseed: { getApiBase: () => '' },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++nextTimer
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout: (id: number) => timers.delete(id),
  })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  for (const [key, value] of Object.entries({ window, document, EventSource: Connection })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  context.mock.method(Date, 'now', () => now)
  return {
    window,
    document,
    jump: (duration) => {
      now += duration
    },
    advance: (duration) => {
      now += duration
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.callback()
      }
    },
  }
}

test('silent SSE stalls request snapshot recovery within one minute', (context) => {
  const { advance } = environment(context)
  const reasons: string[] = []
  const detach = streamEvents(
    'session',
    10,
    () => undefined,
    undefined,
    (reason) => reasons.push(reason)
  )
  Connection.instances[0].onopen?.()
  advance(60_000)
  assert.deepEqual(reasons, ['idle'])
  assert.equal(Connection.instances[0].closed, true)
  detach()
  advance(60_000)
  assert.equal(reasons.length, 1)
})

test('observable SSE heartbeat keeps a quiet healthy stream alive', (context) => {
  const { advance } = environment(context)
  const reasons: string[] = []
  const detach = streamEvents(
    'session',
    10,
    () => undefined,
    undefined,
    (reason) => reasons.push(reason)
  )
  const connection = Connection.instances[0]
  connection.onopen?.()
  for (let heartbeat = 0; heartbeat < 8; heartbeat += 1) {
    advance(15_000)
    connection.dispatchEvent(new Event('heartbeat'))
  }
  assert.deepEqual(reasons, [])
  detach()
})

test('foreground preserves a healthy stream and continues projecting events', (context) => {
  const { window, document, advance } = environment(context)
  const reasons: string[] = []
  const states: string[] = []
  const applied: number[] = []
  const detach = streamEvents(
    'session',
    10,
    (event) => applied.push(event.seq),
    (state) => states.push(state),
    (reason) => reasons.push(reason)
  )
  const connection = Connection.instances[0]
  connection.onopen?.()
  for (let cycle = 0; cycle < 8; cycle += 1) {
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    advance(15_000)
    connection.dispatchEvent(new Event('heartbeat'))
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    connection.message(11 + cycle)
  }
  assert.deepEqual(reasons, [])
  assert.deepEqual(states, ['connecting', 'live'])
  assert.equal(connection.closed, false)
  assert.equal(Connection.instances.length, 1)
  assert.deepEqual(applied, [11, 12, 13, 14, 15, 16, 17, 18])
  detach()
})

test('foreground recovers a stale stream once before delayed idle timers run', (context) => {
  const { window, document, jump } = environment(context)
  const reasons: string[] = []
  const detach = streamEvents(
    'session',
    10,
    () => undefined,
    undefined,
    (reason) => reasons.push(reason)
  )
  Connection.instances[0].onopen?.()
  jump(60_000)
  document.visibilityState = 'hidden'
  document.dispatchEvent(new Event('visibilitychange'))
  assert.deepEqual(reasons, [])
  document.visibilityState = 'visible'
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  assert.deepEqual(reasons, ['foreground'])
  assert.equal(Connection.instances[0].closed, true)
  detach()
  window.dispatchEvent(new Event('focus'))
  assert.equal(reasons.length, 1)
})

test('recent business frames keep foreground healthy without heartbeats', (context) => {
  const { window, advance } = environment(context)
  const reasons: string[] = []
  const detach = streamEvents(
    'session',
    10,
    () => undefined,
    undefined,
    (reason) => reasons.push(reason)
  )
  advance(59_999)
  Connection.instances[0].message(11)
  advance(59_999)
  window.dispatchEvent(new Event('focus'))
  assert.deepEqual(reasons, [])
  assert.equal(Connection.instances[0].closed, false)
  detach()
})

test('foreground does not supersede connecting or scheduled transport retries', (context) => {
  const { window, document, advance, jump } = environment(context)
  const reasons: string[] = []
  const detach = streamEvents(
    'session',
    10,
    () => undefined,
    undefined,
    (reason) => reasons.push(reason)
  )
  window.dispatchEvent(new Event('focus'))
  assert.deepEqual(reasons, [])
  Connection.instances[0].onerror?.()
  jump(60_000)
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  assert.deepEqual(reasons, [])
  advance(0)
  assert.equal(Connection.instances.length, 2)
  Connection.instances[1].onopen?.()
  window.dispatchEvent(new Event('focus'))
  assert.deepEqual(reasons, [])
  detach()
})

test('stale foreground fallback reconnects from the last projected sequence', (context) => {
  const { window, advance, jump } = environment(context)
  const detach = streamEvents('session', 10, () => undefined)
  Connection.instances[0].message(11)
  jump(60_000)
  window.dispatchEvent(new Event('focus'))
  assert.equal(Connection.instances[0].closed, true)
  advance(1_000)
  assert.equal(Connection.instances.length, 2)
  assert.match(Connection.instances[1].url, /from_seq=11$/)
  detach()
})

test('projection failure never acknowledges the failed sequence', (context) => {
  const { advance } = environment(context)
  let fail = true
  const applied: number[] = []
  const detach = streamEvents('session', 10, (event) => {
    if (fail) throw new Error('projection failed')
    applied.push(event.seq)
  })
  Connection.instances[0].message(11)
  assert.equal(Connection.instances[0].closed, true)
  advance(1_000)
  assert.match(Connection.instances[1].url, /from_seq=10$/)
  fail = false
  Connection.instances[1].message(11)
  Connection.instances[1].message(11)
  assert.deepEqual(applied, [11])
  detach()
})

test('superseded connections cannot project events or own a retry', (context) => {
  const { advance } = environment(context)
  const applied: number[] = []
  const detach = streamEvents('session', 10, (event) => applied.push(event.seq))
  const old = Connection.instances[0]
  old.onerror?.()
  advance(1_000)
  old.message(99)
  old.onerror?.()
  Connection.instances[1].message(11)
  assert.deepEqual(applied, [11])
  detach()
})

test('a sequence gap requests a durable snapshot instead of acknowledging missing events', (context) => {
  environment(context)
  const applied: number[] = []
  const reasons: string[] = []
  const detach = streamEvents(
    'session',
    10,
    (event) => applied.push(event.seq),
    undefined,
    (reason) => reasons.push(reason)
  )
  Connection.instances[0].message(12)
  assert.deepEqual(reasons, ['gap'])
  assert.deepEqual(applied, [])
  detach()
})

test('stream diagnostics distinguish parse and projection failures without logging message bodies', (context) => {
  environment(context)
  const logs: string[] = []
  context.mock.method(console, 'info', (...values: unknown[]) => logs.push(values.join(' ')))
  const detach = streamEvents('session', 10, () => {
    throw new Error('PRIVATE_MESSAGE')
  })
  const connection = Connection.instances[0]
  connection.onmessage?.({ data: 'PRIVATE_MESSAGE' })
  connection.message(11)
  const diagnostic = logs.join('\n')
  assert.match(diagnostic, /"stage":"invalid-json"/)
  assert.match(diagnostic, /"stage":"projection-failed"/)
  assert.match(diagnostic, /"failedSequence":11/)
  assert.doesNotMatch(diagnostic, /PRIVATE_MESSAGE/)
  detach()
})
