import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PreviewStorage, PREVIEW_STORAGE } from './storage.ts'
import { PREVIEW_STORAGE_READ, readPreviewStorageBootstrap } from './directory.ts'
import type { PreviewStoragePolicy } from './directory.ts'

const ROOT = '/preview/workspace'

test('storage overview is read-only virtual data and configured root is not effective root or home provenance', async () => {
  const owner = new PreviewStorage(ROOT)
  const initial = owner.bootstrap()
  assert.deepEqual(readPreviewStorageBootstrap(initial), initial)
  assert.deepEqual(initial.choices.map(choice => choice.id), PREVIEW_STORAGE.choiceIds)
  assert.deepEqual(initial.choices.map(choice => choice.label), PREVIEW_STORAGE.choiceIds)
  assert.equal(initial.config.configured, false)
  assert.equal(initial.config.canChangeDataHome, false)
  assert.equal(initial.config.firstLaunchEligible, false)
  const path = initial.choices[0].path
  initial.choices[0].path = '/host/modified'
  initial.config.home = '/host/home'
  assert.notDeepEqual(owner.bootstrap(), initial)
  assert.deepEqual(owner.read(), { root: ROOT, configured: '' })
  assert.deepEqual(await owner.configure({ root: ` ${path} ` }), { root: ROOT, configured: path, restartRequired: true })
  assert.deepEqual(owner.read(), { root: ROOT, configured: path })
  assert.equal(owner.bootstrap().config.configured, false)
  assert.deepEqual(await owner.configure({ root: ' ' }), { root: ROOT, configured: '', restartRequired: false })
})

test('only the current registry can be configured; invalid requests do not consume fail-once', async () => {
  const owner = new PreviewStorage(ROOT, { write: 'fail-once' })
  const other = new PreviewStorage(ROOT)
  const choice = owner.bootstrap().choices[0].path
  for (const value of [null, [], {}, { root: false }, { root: 12 }]) await assert.rejects(owner.configure(value), { status: 422, message: PREVIEW_STORAGE.invalid })
  for (const root of ['/Users/private', 'C:\\Users\\private', '/preview/virtual-workspaces/../private', other.bootstrap().choices[0].path, choice + '/child']) await assert.rejects(owner.configure({ root }), { status: 422, message: PREVIEW_STORAGE.notFound })
  await assert.rejects(owner.configure({ root: choice }), { status: 503, message: PREVIEW_STORAGE.writeFailure })
  assert.equal(owner.read().configured, '')
  assert.equal((await owner.configure({ root: choice })).configured, choice)
  assert.equal(other.read().configured, '')
  owner.dispose()
  const reset = new PreviewStorage(ROOT)
  await assert.rejects(reset.configure({ root: choice }), { status: 422 })
  assert.throws(() => owner.bootstrap(), { status: 410 })
})

test('delayed writes preserve previous state and abort or disposal cannot commit an old selection', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewStorage(ROOT, { write: 'delayed' })
  const choices = owner.bootstrap().choices
  const saved = owner.configure({ root: choices[0].path })
  context.mock.timers.tick(PREVIEW_STORAGE.delayMs - 1)
  assert.equal(owner.read().configured, '')
  context.mock.timers.tick(1)
  assert.equal((await saved).configured, choices[0].path)
  const controller = new AbortController()
  const cancelled = assert.rejects(owner.configure({ root: choices[1].path }, controller.signal), { status: 410 })
  controller.abort()
  await cancelled
  assert.equal(owner.read().configured, choices[0].path)
  const old = assert.rejects(owner.configure({ root: choices[1].path }), { status: 410 })
  owner.dispose()
  context.mock.timers.tick(PREVIEW_STORAGE.delayMs)
  await old
  await assert.rejects(owner.configure({ root: '' }), { status: 410 })
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(new PreviewStorage(ROOT).configure({ root: '' }, aborted.signal), { status: 410 })
})

test('read policies are independent and bootstrap stays synchronous during persistent failure', async () => {
  for (const kind of ['home', 'workspace'] as const) {
    const policy = { write: 'normal' as const, [kind === 'home' ? 'homeRead' : 'workspaceRead']: 'failed' as const }
    const owner = new PreviewStorage(ROOT, policy)
    const before = owner.bootstrap()
    const config = owner.readConfig()
    config.home = '/changed'
    assert.deepEqual(owner.readConfig(), before.config)
    const other = kind === 'home' ? 'workspace' : 'home'
    await owner.beforeRead(other)
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(owner.beforeRead(kind), { status: 503, message: PREVIEW_STORAGE_READ.failure })
    const choice = before.choices[0].path
    await owner.configure({ root: choice })
    owner.recoverRead()
    owner.recoverRead()
    await owner.beforeRead(kind)
    assert.deepEqual(owner.bootstrap(), before)
    assert.deepEqual(owner.read(), { root: ROOT, configured: choice })
    const reset = new PreviewStorage(ROOT, policy)
    await assert.rejects(reset.beforeRead(kind), { status: 503 })
    owner.dispose()
    assert.throws(() => owner.recoverRead(), { status: 410 })
    assert.throws(() => owner.readConfig(), { status: 410 })
  }
  assert.throws(() => new PreviewStorage(ROOT).recoverRead(), { status: 409, message: PREVIEW_STORAGE_READ.recoveryUnavailable })
})

test('delayed reads share cancellation safety with writes and fence post-await disposal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const policy: PreviewStoragePolicy = { write: 'delayed', homeRead: 'delayed', workspaceRead: 'normal' }
  const owner = new PreviewStorage(ROOT, policy)
  policy.homeRead = 'normal'
  let complete = false
  const pending = owner.beforeRead('home').then(() => { complete = true })
  await owner.beforeRead('workspace')
  context.mock.timers.tick(PREVIEW_STORAGE.delayMs - 1)
  await Promise.resolve()
  assert.equal(complete, false)
  context.mock.timers.tick(1)
  await pending
  const abort = new AbortController()
  const cancelled = assert.rejects(owner.beforeRead('home', abort.signal), { status: 410 })
  abort.abort()
  await cancelled
  await assert.rejects(owner.beforeRead('workspace', abort.signal), { status: 410 })
  const lateAbort = new AbortController()
  const cancelledAfterTimer = assert.rejects(owner.beforeRead('home', lateAbort.signal), { status: 410 })
  context.mock.timers.tick(PREVIEW_STORAGE.delayMs)
  lateAbort.abort()
  await cancelledAfterTimer
  const afterTimer = assert.rejects(owner.beforeRead('home'), { status: 410 })
  context.mock.timers.tick(PREVIEW_STORAGE.delayMs)
  owner.dispose()
  await afterTimer
  await assert.rejects(owner.beforeRead('workspace'), { status: 410 })
  const disposed = new PreviewStorage(ROOT, { write: 'delayed', homeRead: 'delayed', workspaceRead: 'delayed' })
  const jobs = [disposed.beforeRead('home'), disposed.beforeRead('workspace'), disposed.configure({ root: disposed.bootstrap().choices[0].path })].map(job => assert.rejects(job, { status: 410 }))
  disposed.dispose()
  context.mock.timers.tick(PREVIEW_STORAGE.delayMs)
  await Promise.all(jobs)
})

test('recovery only releases this owner read faults and does not consume write failures', async () => {
  const policy = { write: 'fail-once' as const, homeRead: 'failed' as const, workspaceRead: 'failed' as const }
  const owner = new PreviewStorage(ROOT, policy)
  const other = new PreviewStorage(ROOT, policy)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(owner.beforeRead('home', abort.signal), { status: 410 })
  owner.recoverRead()
  await owner.beforeRead('home')
  await owner.beforeRead('workspace')
  for (const kind of ['home', 'workspace'] as const) await assert.rejects(other.beforeRead(kind), { status: 503 })
  const choice = owner.bootstrap().choices[0].path
  await assert.rejects(owner.configure({ root: choice }), { status: 503, message: PREVIEW_STORAGE.writeFailure })
  assert.equal(owner.read().configured, '')
  assert.equal((await owner.configure({ root: choice })).configured, choice)
  const normal = new PreviewStorage(ROOT)
  const controller = new AbortController()
  const pending = normal.beforeRead('home', controller.signal)
  controller.abort()
  await pending
  await assert.rejects(normal.beforeRead('home', controller.signal), { status: 410 })
})
