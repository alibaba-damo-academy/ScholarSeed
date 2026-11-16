import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { ElectronApplication } from '@playwright/test'
import { nativeFixture } from './native.ts'

function scope(context: TestContext, cleanup: () => void | Promise<void>) {
  const hooks: (() => void | Promise<void>)[] = []
  const controller = new AbortController()
  const fixture = nativeFixture(
    {
      signal: controller.signal,
      after(callback) {
        if (callback) hooks.push(() => callback(context, () => {}))
      },
    },
    cleanup
  )
  return { fixture, hooks, controller }
}

function application(close: () => Promise<void>) {
  return { close } as ElectronApplication
}

test('native scope registers cleanup before acquisition and closes exactly once before releasing files', async (context) => {
  const events: string[] = []
  const owner = scope(context, () => {
    events.push('files')
  })
  assert.equal(owner.hooks.length, 1)
  const instance = application(async () => {
    events.push('application')
  })
  assert.equal(await owner.fixture.launch(async () => instance), instance)
  await assert.rejects(
    owner.fixture.launch(async () => instance),
    /already acquired/
  )
  const closing = owner.fixture.close()
  assert.equal(owner.fixture.close(), closing)
  await closing
  await owner.hooks[0]()
  assert.deepEqual(events, ['application', 'files'])
})

test('native scope cancellation waits for an in-flight acquisition and never returns the retired application', async (context) => {
  const events: string[] = []
  const owner = scope(context, () => {
    events.push('files')
  })
  let complete: (value: ElectronApplication) => void = () => {
    throw new Error('acquisition not started')
  }
  const pending = owner.fixture.launch(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  await Promise.resolve()
  const failure = new Error('cancelled native fixture')
  owner.controller.abort(failure)
  const closing = owner.hooks[0]()
  assert.equal(events.length, 0)
  const rejected = assert.rejects(pending, (error) => error === failure)
  complete(
    application(async () => {
      events.push('application')
    })
  )
  await rejected
  await closing
  assert.deepEqual(events, ['application', 'files'])
})

test('native scope preserves acquisition failure and releases preparation files without an application', async (context) => {
  let cleaned = 0
  const owner = scope(context, () => {
    cleaned += 1
  })
  const failure = new Error('native acquisition failed')
  await assert.rejects(
    owner.fixture.launch(async () => {
      throw failure
    }),
    (error) => error === failure
  )
  await owner.hooks[0]()
  assert.equal(cleaned, 1)
})

test('native scope preserves close failure and retains files instead of reporting successful cleanup', async (context) => {
  let closed = 0
  let cleaned = 0
  const owner = scope(context, () => {
    cleaned += 1
  })
  const failure = new Error('native close failed')
  await owner.fixture.launch(async () =>
    application(async () => {
      closed += 1
      throw failure
    })
  )
  await assert.rejects(owner.fixture.close(), (error) => error === failure)
  await assert.rejects(Promise.resolve().then(owner.hooks[0]), (error) => error === failure)
  assert.equal(closed, 1)
  assert.equal(cleaned, 0)
})

test('native scope refuses acquisition after cancellation or completed cleanup', async (context) => {
  let invoked = 0
  const create = async () => {
    invoked += 1
    return application(async () => {})
  }
  const cancelled = scope(context, () => {})
  const failure = new Error('already cancelled')
  cancelled.controller.abort(failure)
  await assert.rejects(cancelled.fixture.launch(create), (error) => error === failure)
  await cancelled.hooks[0]()
  const closed = scope(context, () => {})
  await closed.fixture.close()
  await assert.rejects(closed.fixture.launch(create), /already closing/)
  assert.equal(invoked, 0)
})
