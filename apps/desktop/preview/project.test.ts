import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProjectSimulation } from './project.ts'
import { PreviewArchive, PREVIEW_ARCHIVE } from './archive.ts'

const ROOT = '/preview/workspace'
const SEED = { id: 'owned-project', name: 'Owned project', root: `${ROOT}/owned`, layout: 'managed' as const, available: true, created_at: 1, archived_at: 1 }
const POLICY = { seed: 'sample' as const, read: 'normal' as const, history: 'normal' as const, write: 'normal' as const }
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 350)) }

test('project archive changes registration visibility only and forget retains original file bytes behind an inaccessible identity', async () => {
  const owner = new ProjectSimulation(ROOT, [SEED])
  try {
    const files = owner.files(SEED.id)
    const manifest = files.manifest()
    const content = files.read('readme.md')
    assert.equal(owner.archive(SEED.id, false).archived_at, null)
    assert.equal(typeof owner.archive(SEED.id, true).archived_at, 'number')
    assert.deepEqual(files.manifest(), manifest)
    const identity = owner.forget(SEED.id)
    assert.match(identity, /^[a-f0-9]{32}$/)
    assert.equal(owner.operation(identity).state, 'queued')
    await settle()
    assert.deepEqual(owner.operation(identity), { operation: identity, state: 'succeeded', result: { id: SEED.id, removed: true, files_kept: true }, error: null })
    assert.deepEqual(owner.all(), [])
    assert.throws(() => owner.files(SEED.id), { code: 'unknown_project' })
    assert.deepEqual(files.read('readme.md'), content)
    assert.deepEqual(files.manifest(), manifest)
  } finally { owner.dispose() }
})

test('project root guards and failed forgetting do not consume archive failure before valid registration validation', async () => {
  const archive = new PreviewArchive({ ...POLICY, write: 'fail-once' })
  const owner = new ProjectSimulation(ROOT, [SEED, { ...SEED, id: 'current', root: ROOT }])
  try {
    assert.throws(() => owner.archive('current', true), { code: 'cannot_archive_current_project' })
    const current = owner.forget('current', () => archive.write())
    const unknown = owner.forget('foreign', () => archive.write())
    await settle()
    assert.equal(owner.operation(current).error, 'cannot_forget_current_project')
    assert.equal(owner.operation(unknown).error, 'unknown_project')
    const failed = owner.forget(SEED.id, () => archive.write())
    await settle()
    assert.equal(owner.operation(failed).state, 'failed')
    assert.equal(owner.operation(failed).error, PREVIEW_ARCHIVE.writeFailure)
    assert.ok(owner.project(SEED.id))
    const retry = owner.forget(SEED.id, () => archive.write())
    await settle()
    assert.equal(owner.operation(retry).state, 'succeeded')
  } finally { archive.dispose(); owner.dispose() }
})

test('archive read/history policies preserve persistent failures, delay and dispose cancellation', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArchive({ ...POLICY, read: 'delayed', history: 'failed', write: 'delayed' })
  await assert.rejects(owner.read(true), { status: 503, message: PREVIEW_ARCHIVE.historyFailure })
  await assert.rejects(owner.read(true), { status: 503, message: PREVIEW_ARCHIVE.historyFailure })
  const reading = owner.read()
  context.mock.timers.tick(PREVIEW_ARCHIVE.delayMs)
  await reading
  const controller = new AbortController()
  const cancelled = assert.rejects(owner.write(controller.signal), { status: 410 })
  controller.abort()
  await cancelled
  const old = assert.rejects(owner.write(), { status: 410 })
  owner.dispose()
  await old
  await assert.rejects(owner.read(), { status: 410 })
})

test('disposing a project owner during accepted forgetting cannot retire the old registration', async () => {
  const owner = new ProjectSimulation(ROOT, [SEED])
  const policy = new PreviewArchive({ ...POLICY, write: 'delayed' })
  const files = owner.files(SEED.id)
  const operation = owner.forget(SEED.id, () => policy.write())
  await settle()
  assert.equal(owner.operation(operation).state, 'running')
  owner.dispose()
  policy.dispose()
  await Promise.resolve()
  assert.equal(owner.all().length, 1)
  assert.ok(files.read('readme.md').bytes.length)
  assert.throws(() => owner.operation(operation), { code: 'content_operation_unknown' })
})
