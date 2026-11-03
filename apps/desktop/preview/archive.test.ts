import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_ARCHIVE, PreviewArchive, type PreviewArchivePolicy } from './archive.ts'

const POLICY: PreviewArchivePolicy = { seed: 'sample', read: 'normal', history: 'normal', write: 'normal' }
const CLOSED = { message: PREVIEW_ARCHIVE.disposed, status: 410 }
const PROJECT_FAILED = { message: 'preview_archive_project_read_unavailable', status: 503 }

test('project reads inherit normal and failed reads without changing task errors', async () => {
  await new PreviewArchive(POLICY).readProjects()
  const owner = new PreviewArchive({ ...POLICY, read: 'failed' })
  await assert.rejects(owner.readProjects(), PROJECT_FAILED)
  await assert.rejects(owner.read(), { message: PREVIEW_ARCHIVE.readFailure, status: 503 })
})

test('project reads inherit the bounded delay', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArchive({ ...POLICY, read: 'delayed' })
  let completed = false
  const reading = owner.readProjects().then(() => { completed = true })
  context.mock.timers.tick(PREVIEW_ARCHIVE.delayMs - 1)
  await Promise.resolve()
  assert.equal(completed, false)
  context.mock.timers.tick(1)
  await reading
  assert.equal(completed, true)
})

test('explicit project policies override general reads and failures remain persistent', async () => {
  await new PreviewArchive({ ...POLICY, read: 'failed', projectRead: 'normal' }).readProjects()
  const owner = new PreviewArchive({ ...POLICY, projectRead: 'failed' })
  await assert.rejects(owner.readProjects(), PROJECT_FAILED)
  await assert.rejects(owner.readProjects(), PROJECT_FAILED)
  await owner.read()
  await owner.read(true)
})

test('only one concurrent project read fails and write failure has independent state', async () => {
  const owner = new PreviewArchive({ ...POLICY, projectRead: 'fail-once', write: 'fail-once' })
  const outcomes = await Promise.allSettled([owner.readProjects(), owner.readProjects(), owner.readProjects()])
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1)
  const failure = outcomes.find(outcome => outcome.status === 'rejected')
  assert.equal(failure?.status, 'rejected')
  if (failure?.status === 'rejected') assert.equal(failure.reason.message, PROJECT_FAILED.message)
  await assert.rejects(owner.write(), { message: PREVIEW_ARCHIVE.writeFailure, status: 503 })
  await owner.write()
  await owner.readProjects()
})

test('pre-cancelled reads do not consume the independent one-shot failure', async () => {
  const owner = new PreviewArchive({ ...POLICY, projectRead: 'fail-once' })
  const cancelled = new AbortController()
  cancelled.abort('private cancellation reason')
  await assert.rejects(owner.readProjects(cancelled.signal), CLOSED)
  await assert.rejects(owner.readProjects(), PROJECT_FAILED)
  await owner.readProjects()
})

test('aborting a delayed read rejects only that reader and leaves no late success', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArchive({ ...POLICY, projectRead: 'delayed' })
  const controller = new AbortController()
  let completed = false
  const cancelled = assert.rejects(owner.readProjects(controller.signal).then(() => { completed = true }), CLOSED)
  const other = owner.readProjects()
  context.mock.timers.tick(PREVIEW_ARCHIVE.delayMs - 1)
  controller.abort('private cancellation reason')
  await cancelled
  context.mock.timers.tick(1)
  await other
  assert.equal(completed, false)
})

test('dispose cancels all delayed readers and replacement owners start fresh', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArchive({ ...POLICY, projectRead: 'delayed' })
  const first = assert.rejects(owner.readProjects(), CLOSED)
  const second = assert.rejects(owner.readProjects(), CLOSED)
  owner.dispose()
  owner.dispose()
  await Promise.all([first, second])
  context.mock.timers.tick(PREVIEW_ARCHIVE.delayMs)
  await assert.rejects(owner.readProjects(), CLOSED)
  const replacement = new PreviewArchive({ ...POLICY, projectRead: 'fail-once' })
  await assert.rejects(replacement.readProjects(), PROJECT_FAILED)
  await replacement.readProjects()
  replacement.dispose()
})

test('cancellation at the delay boundary is checked before completing', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArchive({ ...POLICY, projectRead: 'delayed' })
  const controller = new AbortController()
  const reading = assert.rejects(owner.readProjects(controller.signal), CLOSED)
  context.mock.timers.tick(PREVIEW_ARCHIVE.delayMs)
  controller.abort()
  await reading
})

test('caller policy mutation does not change the constructed project policy', async () => {
  const policy: PreviewArchivePolicy = { ...POLICY, projectRead: 'fail-once' }
  const owner = new PreviewArchive(policy)
  policy.projectRead = 'normal'
  await assert.rejects(owner.readProjects(), PROJECT_FAILED)
  await owner.readProjects()
})

test('history failures and cancelled legacy writes retain their original contracts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArchive({ ...POLICY, history: 'failed', write: 'delayed' })
  await assert.rejects(owner.read(true), { message: PREVIEW_ARCHIVE.historyFailure, status: 503 })
  const writing = assert.rejects(owner.write(), CLOSED)
  owner.dispose()
  await writing
})

test('explicit project recovery is synchronous and idempotent without changing other policies', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const policy: PreviewArchivePolicy = { ...POLICY, projectRead: 'failed', read: 'failed', history: 'failed', write: 'delayed' }
  const owner = new PreviewArchive(policy)
  await assert.rejects(owner.readProjects(), PROJECT_FAILED)
  assert.equal(owner.recoverProjects(), undefined)
  await owner.readProjects()
  assert.equal(owner.recoverProjects(), undefined)
  await owner.readProjects()
  assert.deepEqual(owner.policy, policy)
  await assert.rejects(owner.read(), { message: PREVIEW_ARCHIVE.readFailure, status: 503 })
  await assert.rejects(owner.read(true), { message: PREVIEW_ARCHIVE.historyFailure, status: 503 })
  let written = false
  const writing = owner.write().then(() => { written = true })
  await Promise.resolve()
  assert.equal(written, false)
  context.mock.timers.tick(PREVIEW_ARCHIVE.delayMs)
  await writing
  assert.equal(written, true)
})

test('recovery is unavailable unless project failure was explicitly configured', async () => {
  const policies: PreviewArchivePolicy[] = [
    POLICY,
    { ...POLICY, read: 'failed' },
    { ...POLICY, projectRead: 'normal' },
    { ...POLICY, projectRead: 'delayed' },
    { ...POLICY, projectRead: 'fail-once' },
  ]
  for (const policy of policies) {
    const owner = new PreviewArchive(policy)
    assert.throws(() => owner.recoverProjects(), { message: 'preview_archive_recovery_unavailable', status: 409 })
  }
})

test('recovery is isolated and reset through a fresh owner reinstates persistent failure', async () => {
  const policy: PreviewArchivePolicy = { ...POLICY, projectRead: 'failed' }
  const first = new PreviewArchive(policy)
  const other = new PreviewArchive(policy)
  first.recoverProjects()
  await first.readProjects()
  await assert.rejects(other.readProjects(), PROJECT_FAILED)
  first.dispose()
  assert.throws(() => first.recoverProjects(), CLOSED)
  await assert.rejects(first.readProjects(), CLOSED)
  const reset = new PreviewArchive(policy)
  await assert.rejects(reset.readProjects(), PROJECT_FAILED)
  reset.recoverProjects()
  await reset.readProjects()
  assert.equal(PREVIEW_ARCHIVE.recoveryPath, '/__preview/archives/recover')
})
