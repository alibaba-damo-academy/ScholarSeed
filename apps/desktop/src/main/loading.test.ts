import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { loadStartupWindow, waitForStartupWindow } from './loading.ts'
import { STARTUP_BUDGET_STEADY_MS } from './startupmarker.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('first window loading waits for both the main document and first paint', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const paintFirst of [true, false]) {
    const window = new EventEmitter()
    const navigation = deferred<void>()
    const controller = new AbortController()
    let painted = 0
    let settled = false
    const result = loadStartupWindow(
      window as unknown as BrowserWindow,
      controller.signal,
      () => navigation.promise,
      () => painted++
    ).then(() => {
      settled = true
    })
    if (paintFirst) window.emit('ready-to-show')
    else navigation.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    assert.equal(painted, paintFirst ? 1 : 0)
    if (paintFirst) navigation.resolve()
    else window.emit('ready-to-show')
    await result
    context.mock.timers.tick(STARTUP_BUDGET_STEADY_MS)
    assert.equal(painted, 1)
    assert.equal(window.listenerCount('ready-to-show'), 0)
  }
})

test('hung main document and missing first paint each exhaust the same deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const paintedBeforeDeadline of [true, false]) {
    const window = new EventEmitter()
    const navigation = deferred<void>()
    let activeLoad: AbortSignal | undefined
    let painted = 0
    const starting = loadStartupWindow(
      window as unknown as BrowserWindow,
      new AbortController().signal,
      (signal) => {
        activeLoad = signal
        return navigation.promise
      },
      () => painted++
    )
    const failed = assert.rejects(
      starting,
      /Main window navigation did not load and paint within 45000 ms/
    )
    if (paintedBeforeDeadline) window.emit('ready-to-show')
    else navigation.resolve()
    context.mock.timers.tick(STARTUP_BUDGET_STEADY_MS)
    await failed
    window.emit('ready-to-show')
    navigation.resolve()
    assert.equal(painted, paintedBeforeDeadline ? 1 : 0)
    assert.equal(activeLoad?.aborted, true)
    assert.equal(window.listenerCount('ready-to-show'), 0)
  }
})

test('a renderer exit cancels the first window immediately even after navigation succeeds', async () => {
  const window = new EventEmitter()
  const controller = new AbortController()
  const loaded = loadStartupWindow(
    window as unknown as BrowserWindow,
    controller.signal,
    async () => undefined,
    () => {}
  )
  window.emit('ready-to-show')
  await loaded

  let started = false
  const backendReady = deferred<boolean>()
  const pending = waitForStartupWindow(controller.signal, () => {
    started = true
    return backendReady.promise
  })
  const failure = new Error('renderer exited during initial workbench startup')
  const failed = assert.rejects(pending, (error) => error === failure)
  controller.abort(failure)
  await failed
  backendReady.resolve(true)
  assert.equal(started, true)
  await assert.rejects(
    waitForStartupWindow(controller.signal, () => assert.fail('late startup did not stop')),
    (error) => error === failure
  )
})
