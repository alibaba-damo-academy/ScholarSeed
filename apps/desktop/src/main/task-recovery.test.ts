import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import {
  installTaskRecoveryFallback,
  TaskRecovery,
  TASK_RECOVERY_FILENAME,
} from './task-recovery.ts'
import { STARTUP_TASK_RECOVERY_MS } from '../window.ts'

function fixture(context: { after: (cleanup: () => void) => void }) {
  const profile = mkdtempSync(join(tmpdir(), 'scholarseed-task-recovery-'))
  context.after(() => rmSync(profile, { force: true, recursive: true }))
  const messages: string[] = []
  return {
    marker: join(profile, TASK_RECOVERY_FILENAME),
    launch: () => new TaskRecovery(profile, (message) => messages.push(message)),
    messages,
  }
}

test('records pending recovery before issuing a token and starts at home after interruption', (context) => {
  const { marker, launch } = fixture(context)
  const first = launch()
  assert.equal(first.status('old-task'), 'eligible')
  const token = first.begin('old-task')
  assert.ok(token)
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
    state: 'pending',
    sessionId: 'old-task',
  })
  assert.equal(first.begin('second-task'), null)
  const restarted = launch()
  assert.equal(restarted.status('old-task'), 'home')
  assert.equal(restarted.status('second-task'), 'home')
  assert.equal(restarted.status(null), 'home')
  assert.equal(restarted.begin('old-task'), null)
  assert.equal(restarted.finish(token, 'restored'), false)
  assert.equal(launch().status('old-task'), 'home')
  assert.equal(launch().status('second-task'), 'eligible')
  assert.equal(restarted.manualOpened('old-task'), true)
  assert.equal(launch().status('old-task'), 'eligible')
})

test('skipping stays associated with the original task and success clears pending state', (context) => {
  const { launch } = fixture(context)
  const first = launch()
  const firstToken = first.begin('old-task')
  assert.ok(firstToken)
  assert.equal(first.finish(firstToken, 'skipped'), true)
  assert.equal(first.begin('second-task'), null)
  const second = launch()
  assert.equal(second.status('old-task'), 'home')
  assert.equal(second.status('second-task'), 'eligible')
  const secondToken = second.begin('second-task')
  assert.ok(secondToken)
  assert.equal(second.finish(firstToken, 'restored'), false)
  assert.equal(second.finish(secondToken, 'restored'), true)
  assert.equal(second.begin('second-task'), null)
  assert.equal(launch().status('second-task'), 'eligible')
})

test('a native reopen and a different manual task keep the interrupted task suppressed', (context) => {
  const { launch } = fixture(context)
  const first = launch()
  const token = first.begin('old-task')
  assert.ok(token)
  assert.equal(first.reopenHome(token), true)
  assert.equal(first.status(null), 'home')
  assert.equal(first.finish(token, 'restored'), false)
  assert.equal(first.manualOpened('other-task'), true)
  assert.equal(launch().status('old-task'), 'home')
  assert.equal(launch().status('other-task'), 'eligible')
})

test('invalid on-disk recovery state fails closed and supports a manual open', (context) => {
  const { marker, launch, messages } = fixture(context)
  writeFileSync(marker, '{}')
  const first = launch()
  assert.equal(first.status('old-task'), 'home')
  assert.equal(first.begin('old-task'), null)
  assert.equal(messages.length, 1)
  assert.equal(first.manualOpened('old-task'), true)
  assert.equal(launch().status('old-task'), 'eligible')
})

test('failing to persist pending state denies the automatic attempt', (context) => {
  const { marker, launch, messages } = fixture(context)
  const recovery = launch()
  mkdirSync(marker)
  assert.equal(recovery.begin('old-task'), null)
  assert.equal(recovery.pendingToken(), null)
  assert.equal(recovery.status('old-task'), 'home')
  assert.match(messages[0], /marker write failed/)
})

function nativeWindow(recovery: TaskRecovery) {
  const actions: string[] = []
  const prompts: AbortSignal[] = []
  let reply: (value: boolean) => void = () => assert.fail('No prompt is open')
  let crashed = false
  const webContents = Object.assign(new EventEmitter(), {
    isCrashed: () => crashed,
    forcefullyCrashRenderer: () => {
      actions.push('crash')
    },
  })
  const window = Object.assign(new EventEmitter(), { webContents })
  const onRendererExit = installTaskRecoveryFallback(window as unknown as BrowserWindow, recovery, {
    canPresent: () => true,
    prompt: (signal) => {
      prompts.push(signal)
      return new Promise<boolean>((resolve) => {
        reply = resolve
      })
    },
    reopen: async () => {
      actions.push(recovery.status(null))
      webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    },
    log: () => {},
  })
  return {
    window,
    webContents,
    prompts,
    actions,
    respond: (value: boolean) => reply(value),
    rendererExited: () => {
      crashed = true
      onRendererExit()
    },
  }
}

test('native recovery sets home and waits for the old renderer to exit before reopening', async (context) => {
  const { launch } = fixture(context)
  const recovery = launch()
  const native = nativeWindow(recovery)
  native.window.emit('unresponsive')
  assert.equal(native.prompts.length, 0)
  assert.ok(recovery.begin('old-task'))
  native.window.emit('unresponsive')
  native.window.emit('unresponsive')
  assert.equal(native.prompts.length, 1)
  native.respond(true)
  await Promise.resolve()
  assert.deepEqual(native.actions, ['crash'])
  assert.equal(native.prompts[0].aborted, false)
  assert.equal(recovery.status(null), 'home')
  native.rendererExited()
  assert.deepEqual(native.actions, ['crash'])
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(native.actions, ['crash', 'home'])
  assert.equal(native.prompts.length, 1)
  assert.equal(launch().status('old-task'), 'home')
})

test('native recovery reopens a renderer that already exited without crashing it again', async (context) => {
  const { launch } = fixture(context)
  const recovery = launch()
  const native = nativeWindow(recovery)
  assert.ok(recovery.begin('old-task'))
  native.rendererExited()
  assert.equal(native.prompts.length, 1)
  native.respond(true)
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(native.actions, ['home'])
  assert.equal(native.prompts[0].aborted, false)
})

test('the watchdog offers recovery once without a Chromium hang signal', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { launch } = fixture(context)
  const recovery = launch()
  const native = nativeWindow(recovery)
  assert.ok(recovery.begin('old-task'))
  context.mock.timers.tick(STARTUP_TASK_RECOVERY_MS)
  assert.equal(native.prompts.length, 0)
  context.mock.timers.tick(1_000)
  assert.equal(native.prompts.length, 1)
  native.respond(false)
  await Promise.resolve()
  native.window.emit('unresponsive')
  native.rendererExited()
  assert.equal(native.prompts.length, 1)
  assert.deepEqual(native.actions, [])
})

test('settling within the renderer budget disarms the main watchdog', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { launch } = fixture(context)
  const recovery = launch()
  const native = nativeWindow(recovery)
  const token = recovery.begin('old-task')
  assert.ok(token)
  context.mock.timers.tick(STARTUP_TASK_RECOVERY_MS)
  assert.ok(recovery.finish(token, 'skipped'))
  context.mock.timers.tick(2_000)
  assert.deepEqual(native.prompts, [])
})

test('a late native dialog reply cannot reload a restored task', async (context) => {
  const { launch } = fixture(context)
  const recovery = launch()
  const native = nativeWindow(recovery)
  const token = recovery.begin('old-task')
  assert.ok(token)
  native.window.emit('unresponsive')
  assert.ok(recovery.finish(token, 'restored'))
  assert.ok(native.prompts[0].aborted)
  native.respond(true)
  await Promise.resolve()
  assert.deepEqual(native.actions, [])
})

test('replacing the main document retires a pending recovery and its dialog', async (context) => {
  const { launch } = fixture(context)
  const recovery = launch()
  const native = nativeWindow(recovery)
  assert.ok(recovery.begin('old-task'))
  native.window.emit('unresponsive')
  native.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.ok(native.prompts[0].aborted)
  native.respond(true)
  await Promise.resolve()
  assert.deepEqual(native.actions, [])
  assert.equal(recovery.status(null), 'home')
})
