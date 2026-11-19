import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { hasOpenFileEventStream, subscribeFileEvents, whenFileEventCursorLoaded } from './events.ts'

class FileStream {
  static opened: FileStream[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(
    readonly url: string,
    readonly options: EventSourceInit
  ) {
    FileStream.opened.push(this)
  }

  close(): void {
    this.closed = true
  }

  emit(seq: number, epoch = 'epoch'): void {
    this.onmessage?.({ data: JSON.stringify({ seq, epoch }) })
  }
}

function browser(
  context: TestContext,
  fetcher: typeof fetch = async () => Response.json({ epoch: 'initial', last_seq: 4 })
): {
  timers: Map<number, { callback: () => void; delay: number }>
  origin: { value: string }
} {
  const originalWindow = globalThis.window
  const originalSource = globalThis.EventSource
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const origin = { value: 'http://service.test' }
  let timerId = 0
  FileStream.opened = []
  globalThis.window = {
    scholarseed: { getApiBase: () => origin.value },
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++timerId, { callback, delay })
      return timerId
    },
    clearTimeout: (identity: number) => timers.delete(identity),
  } as unknown as Window & typeof globalThis
  globalThis.EventSource = FileStream as unknown as typeof EventSource
  context.mock.method(globalThis, 'fetch', fetcher)
  context.after(() => {
    globalThis.window = originalWindow
    globalThis.EventSource = originalSource
  })
  return { timers, origin }
}

async function opened(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('project consumers share one stream until the last subscription leaves', async (context) => {
  browser(context)
  const first: number[] = []
  const second: number[] = []
  const stopFirst = subscribeFileEvents('project', (event) => first.push(event.seq))
  const stopSecond = subscribeFileEvents('project', (event) => second.push(event.seq))
  context.after(() => {
    stopFirst()
    stopSecond()
  })
  await opened()
  assert.equal(FileStream.opened.length, 1)
  const stream = FileStream.opened[0]
  assert.equal(stream.options.withCredentials, true)
  assert.equal(new URL(stream.url).searchParams.get('from_seq'), '4')
  stream.emit(5)
  assert.deepEqual(first, [5])
  assert.deepEqual(second, [5])
  stopFirst()
  stopFirst()
  assert.equal(stream.closed, false)
  stream.emit(6)
  assert.deepEqual(first, [5])
  assert.deepEqual(second, [5, 6])
  stopSecond()
  assert.equal(stream.closed, true)
})

test('separate projects never share a stream', async (context) => {
  browser(context)
  const stops = [subscribeFileEvents('first', () => {}), subscribeFileEvents('second', () => {})]
  context.after(() => stops.forEach((stop) => stop()))
  await opened()
  assert.equal(FileStream.opened.length, 2)
  assert.deepEqual(
    FileStream.opened.map((stream) => new URL(stream.url).searchParams.get('project')),
    ['first', 'second']
  )
})

test('identical callbacks retain independent subscription lifetimes', async (context) => {
  browser(context)
  const received: number[] = []
  const listener = (event: { seq: number }): void => {
    received.push(event.seq)
  }
  const first = subscribeFileEvents('project', listener)
  const second = subscribeFileEvents('project', listener)
  context.after(() => {
    first()
    second()
  })
  await opened()
  assert.equal(FileStream.opened.length, 1)
  const stream = FileStream.opened[0]
  first()
  stream.emit(7)
  assert.deepEqual(received, [7])
  assert.equal(stream.closed, false)
})

test('reconnection uses the shared latest cursor and closes its retry timer', async (context) => {
  const { timers, origin } = browser(context)
  const stop = subscribeFileEvents('project', () => {})
  try {
    await opened()
    const first = FileStream.opened[0]
    first.onopen?.()
    first.emit(9, 'resumed')
    first.onerror?.()
    first.onerror?.()
    assert.equal(first.closed, true)
    assert.equal(timers.size, 1)
    const [timerId, retry] = [...timers][0]
    assert.equal(retry.delay, 500)
    timers.delete(timerId)
    origin.value = 'http://other.test'
    retry.callback()
    const second = FileStream.opened[1]
    assert.equal(new URL(second.url).origin, 'http://other.test')
    assert.equal(new URL(second.url).searchParams.get('epoch'), 'resumed')
    assert.equal(new URL(second.url).searchParams.get('from_seq'), '9')
    second.onerror?.()
    assert.equal(timers.size, 1)
    stop()
    assert.equal(timers.size, 0)
  } finally {
    stop()
  }
})

test('the initial cursor is available before the stream opens, and a new epoch resets its sequence', async (context) => {
  const { timers } = browser(context)
  const stop = subscribeFileEvents('project', () => {})
  context.after(stop)
  await whenFileEventCursorLoaded('project')
  assert.equal(hasOpenFileEventStream('project'), false)
  const first = FileStream.opened[0]
  first.onopen?.()
  assert.equal(hasOpenFileEventStream('project'), true)
  first.emit(1, 'new-epoch')
  first.onerror?.()
  assert.equal(hasOpenFileEventStream('project'), false)
  const [timerId, retry] = [...timers][0]
  timers.delete(timerId)
  retry.callback()
  const resumed = new URL(FileStream.opened[1].url).searchParams
  assert.equal(resumed.get('epoch'), 'new-epoch')
  assert.equal(resumed.get('from_seq'), '1')
})

test('the cursor settles and connection retries back off when the stream constructor throws', async (context) => {
  const { timers } = browser(context)
  let failures = 2
  globalThis.EventSource = class extends FileStream {
    constructor(url: string, options: EventSourceInit) {
      if (failures > 0) {
        failures -= 1
        throw new DOMException('Cannot open stream', 'SyntaxError')
      }
      super(url, options)
    }
  } as unknown as typeof EventSource
  const received: number[] = []
  const stop = subscribeFileEvents('project', (event) => received.push(event.seq))
  try {
    await whenFileEventCursorLoaded('project')
    assert.equal(hasOpenFileEventStream('project'), false)
    assert.equal(FileStream.opened.length, 0)
    for (const milliseconds of [500, 1000]) {
      assert.equal(timers.size, 1)
      const [timerId, retry] = [...timers][0]
      assert.equal(retry.delay, milliseconds)
      timers.delete(timerId)
      retry.callback()
    }
    assert.equal(timers.size, 0)
    assert.equal(FileStream.opened.length, 1)
    const connection = FileStream.opened[0]
    const cursor = new URL(connection.url).searchParams
    assert.equal(cursor.get('epoch'), 'initial')
    assert.equal(cursor.get('from_seq'), '4')
    connection.onopen?.()
    connection.emit(5, 'initial')
    assert.equal(hasOpenFileEventStream('project'), true)
    assert.deepEqual(received, [5])
  } finally {
    stop()
  }
})

test('last unsubscribe during cursor loading cannot open an orphan stream', async (context) => {
  let resolveCursor: (response: Response) => void = () => {}
  browser(
    context,
    () =>
      new Promise<Response>((resolve) => {
        resolveCursor = resolve
      })
  )
  const stop = subscribeFileEvents('project', () => {})
  stop()
  resolveCursor(Response.json({ epoch: 'old', last_seq: 1 }))
  await opened()
  assert.equal(FileStream.opened.length, 0)
  context.mock.method(globalThis, 'fetch', async () => Response.json({ epoch: 'new', last_seq: 2 }))
  const next = subscribeFileEvents('project', () => {})
  context.after(next)
  await opened()
  assert.equal(FileStream.opened.length, 1)
  assert.equal(new URL(FileStream.opened[0].url).searchParams.get('epoch'), 'new')
})

test('a consumer failure does not prevent delivery to independent subscribers', async (context) => {
  browser(context)
  const received: number[] = []
  const first = subscribeFileEvents('project', () => {
    throw new Error('consumer failure')
  })
  const second = subscribeFileEvents('project', (event) => received.push(event.seq))
  context.after(() => {
    first()
    second()
  })
  await opened()
  const stream = FileStream.opened[0]
  stream.onmessage?.({ data: 'invalid JSON' })
  stream.emit(8)
  assert.deepEqual(received, [8])
})
