import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PreviewContent, PREVIEW_CONTENT } from './content.ts'

const TARGET = { project: 'project-one', identity: 'file-one' }

test('content policy scopes failures to a VFS identity and keeps fail-once explicit', async () => {
  const policy = new PreviewContent(TARGET, 'fail-once')
  assert.equal(await policy.read({ ...TARGET, identity: 'other' }), 'ready')
  assert.equal(await policy.read({ ...TARGET, project: 'other' }), 'ready')
  assert.equal(await policy.read(TARGET), 'failed')
  assert.equal(await policy.read(TARGET), 'ready')
  const failed = new PreviewContent(TARGET, 'failed')
  assert.equal(await failed.read(TARGET), 'failed')
  assert.equal(await failed.read(TARGET), 'failed')
  assert.equal(await new PreviewContent(TARGET, 'fail-once').read(TARGET), 'failed')
})

test('content delay is bounded and reset/disconnect cancel pending reads', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const policy = new PreviewContent(TARGET, 'delayed')
  let settled = false
  const pending = policy.read(TARGET).then(result => { settled = true; return result })
  context.mock.timers.tick(PREVIEW_CONTENT.delayMs - 1)
  await Promise.resolve()
  assert.equal(settled, false)
  context.mock.timers.tick(1)
  assert.equal(await pending, 'ready')
  const controller = new AbortController()
  const aborted = policy.read(TARGET, controller.signal)
  controller.abort()
  assert.equal(await aborted, 'cancelled')
  const disposed = policy.read(TARGET)
  policy.dispose()
  assert.equal(await disposed, 'cancelled')
  assert.equal(await policy.read(TARGET), 'cancelled')
  context.mock.timers.tick(PREVIEW_CONTENT.delayMs)
})

test('a disconnected failure request cannot consume fail-once', async () => {
  const policy = new PreviewContent(TARGET, 'fail-once')
  const controller = new AbortController()
  controller.abort()
  assert.equal(await policy.read(TARGET, controller.signal), 'cancelled')
  assert.equal(await policy.read(TARGET), 'failed')
})

test('persistent content recovery is explicit, idempotent and isolated from reset and other modes', async () => {
  const owner = new PreviewContent(TARGET, 'failed')
  const other = new PreviewContent(TARGET, 'failed')
  assert.equal(await owner.read(TARGET), 'failed')
  owner.recover()
  owner.recover()
  assert.equal(await owner.read(TARGET), 'ready')
  assert.equal(await other.read(TARGET), 'failed')
  assert.equal(await new PreviewContent(TARGET, 'failed').read(TARGET), 'failed')
  for (const mode of ['delayed', 'fail-once'] as const) {
    const unchanged = new PreviewContent(TARGET, mode)
    assert.throws(() => unchanged.recover(), { status: 409, code: PREVIEW_CONTENT.recoveryUnavailable })
    if (mode === 'fail-once') assert.equal(await unchanged.read(TARGET), 'failed')
  }
  owner.dispose()
  assert.throws(() => owner.recover(), { status: 410, code: PREVIEW_CONTENT.disposedCode })
  assert.equal(await owner.read(TARGET), 'cancelled')
})

test('timer resolution is not a receipt when disposal or abort precedes the async continuation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewContent(TARGET, 'delayed')
  const read = owner.read(TARGET)
  context.mock.timers.tick(PREVIEW_CONTENT.delayMs)
  owner.dispose()
  assert.equal(await read, 'cancelled')
  const other = new PreviewContent(TARGET, 'delayed')
  const controller = new AbortController()
  const aborted = other.read(TARGET, controller.signal)
  context.mock.timers.tick(PREVIEW_CONTENT.delayMs)
  controller.abort()
  assert.equal(await aborted, 'cancelled')
})

test('recovery cannot release delayed reads or revive cancelled requests and target remains captured', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const target = { ...TARGET }
  const delayed = new PreviewContent(target, 'delayed')
  target.identity = 'changed'
  let settled = false
  const pending = delayed.read(TARGET).then(value => { settled = true; return value })
  assert.throws(() => delayed.recover(), { status: 409 })
  context.mock.timers.tick(PREVIEW_CONTENT.delayMs - 1)
  await Promise.resolve()
  assert.equal(settled, false)
  context.mock.timers.tick(1)
  assert.equal(await pending, 'ready')
  const owner = new PreviewContent(TARGET, 'failed')
  const controller = new AbortController()
  controller.abort()
  const cancelled = owner.read(TARGET, controller.signal)
  owner.recover()
  assert.equal(await cancelled, 'cancelled')
  assert.equal(await owner.read(TARGET), 'ready')
  assert.equal(await owner.read(TARGET, controller.signal), 'cancelled')
  delayed.dispose()
  delayed.dispose()
  assert.equal(await delayed.read(target), 'cancelled')
})
