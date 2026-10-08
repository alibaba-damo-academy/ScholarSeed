import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UpdateProgress } from '../updates.ts'
import { InstallationProgress, type InstallationDiagnostic } from './installation.ts'
import { runCommandAsync } from './subprocess.ts'

test('installation reports real step limits and preserves the attempt clock across both app checks', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const events: UpdateProgress[] = []
  const progress = new InstallationProgress((event) => events.push(event))
  progress.step('signature', 180_000, 'source')
  t.mock.timers.tick(76_000)
  progress.step('gatekeeper', 180_000, 'source')
  t.mock.timers.tick(75_000)
  progress.step('copying', 600_000)
  t.mock.timers.tick(80_000)
  progress.step('signature', 180_000, 'staged')
  assert.deepEqual(
    events.map((event) => event.installation?.startedAt),
    [1_000, 1_000, 1_000, 1_000]
  )
  assert.deepEqual(
    events.map((event) => event.installation?.stepStartedAt),
    [1_000, 77_000, 152_000, 232_000]
  )
  assert.deepEqual(
    events.map((event) => event.installation?.timeoutMs),
    [180_000, 180_000, 600_000, 180_000]
  )
  assert.equal(events.at(-1)?.installation?.application, 'staged')
  assert.equal(events.at(-1)?.install_stage, 'copying')
  assert.ok(events.every((event) => event.percent === undefined))
  progress.dispose()
})

test('cancellation publishes immediately, stops a running command, and only permits cleanup', async () => {
  const events: UpdateProgress[] = []
  const controller = new AbortController()
  const progress = new InstallationProgress((event) => events.push(event), controller.signal)
  progress.step('copying', 600_000)
  const pending = runCommandAsync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    signal: progress.signal,
  })
  controller.abort()
  assert.equal(events.at(-1)?.installation?.cancelling, true)
  await assert.rejects(pending, /command aborted/)
  assert.throws(() => progress.step('signature', 180_000, 'staged'), /abort/i)
  progress.step('cleanup', 120_000)
  assert.equal(events.at(-1)?.installation?.step, 'cleanup')
  assert.equal(events.at(-1)?.installation?.cancelling, true)
  progress.dispose()
})

test('already cancelled attempts cannot start, and disposed attempts cannot overwrite later state', () => {
  const events: UpdateProgress[] = []
  const controller = new AbortController()
  const progress = new InstallationProgress((event) => events.push(event), controller.signal)
  progress.step('restarting')
  assert.equal(events.at(-1)?.install_stage, 'restarting')
  progress.dispose()
  controller.abort()
  assert.equal(events.length, 1)
  const next = new InstallationProgress((event) => events.push(event), controller.signal)
  assert.throws(() => next.step('package'), /abort/i)
  assert.equal(events.length, 1)
  next.dispose()
})

test('diagnostics correlate slow steps, cancellation and cleanup without reporting upgrade success', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 })
  const events: InstallationDiagnostic[] = []
  const controller = new AbortController()
  const progress = new InstallationProgress(
    () => {},
    controller.signal,
    (event) => events.push(event)
  )
  progress.step('signature', 180_000, 'source')
  t.mock.timers.tick(76_000)
  progress.step('gatekeeper', 180_000, 'source')
  assert.equal(events[1].event, 'step-end')
  assert.equal(events[1].stepElapsedMs, 76_000)
  assert.equal(events[1].application, 'source')
  t.mock.timers.tick(75_000)
  controller.abort()
  assert.equal(events.at(-1)?.event, 'cancel-requested')
  assert.equal(events.at(-1)?.elapsedMs, 151_000)
  assert.equal(events.at(-1)?.stepElapsedMs, 75_000)
  assert.equal(events.at(-1)?.timeoutMs, 180_000)
  progress.step('cleanup', 120_000)
  t.mock.timers.tick(2_000)
  progress.finish('cancelled')
  assert.equal(events.at(-1)?.result, 'cancelled')
  assert.equal(events.at(-1)?.step, 'cleanup')
  assert.equal(events.at(-1)?.elapsedMs, 153_000)
  assert.ok(events.every((event) => event.updateId === progress.updateId))
  assert.match(progress.updateId, /^[a-f0-9-]{36}$/)
  progress.dispose()
})
