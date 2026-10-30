import assert from 'node:assert/strict'
import test from 'node:test'
import { PreviewArtifacts } from './artifacts.ts'
import { PreviewFiles } from './files.ts'
import { PREVIEW_ARTIFACTS, type PreviewArtifactPolicy } from './publications.ts'

const POLICY: PreviewArtifactPolicy = { seed: 'sample' }
const CLOSED = { message: PREVIEW_ARTIFACTS.disposed, status: 410 }
const MISSING = { message: PREVIEW_ARTIFACTS.notFound, status: 404 }

test('publication captures genuine file metadata and immutable bytes independent of source edits and deletion', () => {
  const files = new PreviewFiles()
  const owner = new PreviewArtifacts(POLICY)
  const file = files.read('readme.md')
  const published = owner.publish('session', 'turn', file, 'final')
  assert.ok(published.publication_id)
  assert.equal(published.role, 'final')
  assert.equal(published.sha256, file.revision.slice('sha256:'.length))
  assert.equal(published.size, file.bytes.byteLength)
  assert.equal(published.media_type, 'text/markdown')
  assert.equal(published.path, file.path)
  assert.equal(published.status, 'available')
  assert.equal(published.change, 'add')
  files.write(file.path, new TextEncoder().encode('changed source'))
  files.delete(file.path)
  assert.deepEqual(owner.read('session', published.artifact_id), file)
})

test('same turn and identity stays idempotent even when source bytes change', () => {
  const files = new PreviewFiles()
  const owner = new PreviewArtifacts(POLICY)
  const first = owner.publish('session', 'turn', files.read('hello.py'), 'intermediate')
  files.write('hello.py', new TextEncoder().encode('revised'))
  assert.deepEqual(owner.publish('session', 'turn', files.read('hello.py'), 'final'), first)
  const next = owner.publish('session', 'next', files.read('hello.py'), 'final')
  assert.notEqual(next.artifact_id, first.artifact_id)
  assert.notEqual(next.publication_id, first.publication_id)
  assert.notDeepEqual(owner.read('session', next.artifact_id).bytes, owner.read('session', first.artifact_id).bytes)
})

test('input, returned metadata and read buffers cannot mutate stored publications', () => {
  const owner = new PreviewArtifacts(POLICY)
  const file = new PreviewFiles().read('sample.pdf')
  const expected = file.bytes.slice()
  const published = owner.publish('session', 'turn', file, 'supporting')
  const id = published.artifact_id
  file.bytes.fill(0)
  published.name = 'private mutation'
  const read = owner.read('session', id)
  read.bytes.fill(0)
  assert.deepEqual(owner.read('session', id).bytes, expected)
  assert.equal(owner.publish('session', 'turn', new PreviewFiles().read('sample.pdf'), 'supporting').name, 'sample.pdf')
})

test('session and owner identities never resolve foreign publications', () => {
  const owner = new PreviewArtifacts(POLICY)
  const other = new PreviewArtifacts(POLICY)
  const file = new PreviewFiles().read('readme.md')
  const first = owner.publish('session', 'turn', file, 'final')
  const second = other.publish('session', 'turn', file, 'final')
  assert.notEqual(first.artifact_id, second.artifact_id)
  assert.throws(() => owner.read('foreign', first.artifact_id), MISSING)
  assert.throws(() => other.read('session', first.artifact_id), MISSING)
  assert.throws(() => owner.read('session', 'unknown'), MISSING)
})

test('all read policies are persistent and explicit recovery is isolated and idempotent', async () => {
  const policy: { seed: 'sample'; catalogRead: 'normal' | 'failed'; historyRead: 'failed'; contentRead: 'failed' } = { seed: 'sample', catalogRead: 'failed', historyRead: 'failed', contentRead: 'failed' }
  const owner = new PreviewArtifacts(policy)
  const other = new PreviewArtifacts(policy)
  policy.catalogRead = 'normal'
  for (const kind of ['catalog', 'history', 'content'] as const) {
    await assert.rejects(owner.beforeRead(kind), { message: PREVIEW_ARTIFACTS.readFailed, status: 503 })
    await assert.rejects(owner.beforeRead(kind), { status: 503 })
  }
  owner.recover()
  owner.recover()
  for (const kind of ['catalog', 'history', 'content'] as const) await owner.beforeRead(kind)
  await assert.rejects(other.beforeRead('catalog'), { status: 503 })
  assert.throws(() => new PreviewArtifacts(POLICY).recover(), { message: PREVIEW_ARTIFACTS.recoveryUnavailable, status: 409 })
})

test('each read kind delays for the bounded interval independently', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArtifacts({ seed: 'empty', catalogRead: 'delayed', historyRead: 'delayed', contentRead: 'delayed' })
  let completed = 0
  const reads = ['catalog', 'history', 'content'].map(kind => owner.beforeRead(kind as 'catalog' | 'history' | 'content').then(() => { completed++ }))
  context.mock.timers.tick(PREVIEW_ARTIFACTS.delayMs - 1)
  await Promise.resolve()
  assert.equal(completed, 0)
  context.mock.timers.tick(1)
  await Promise.all(reads)
  assert.equal(completed, 3)
})

test('abort cancels only its delayed reader and does not leak a later receipt', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArtifacts({ seed: 'sample', contentRead: 'delayed' })
  const controller = new AbortController()
  const aborted = assert.rejects(owner.beforeRead('content', controller.signal), CLOSED)
  const surviving = owner.beforeRead('content')
  controller.abort('sensitive reason')
  await aborted
  context.mock.timers.tick(PREVIEW_ARTIFACTS.delayMs)
  await surviving
})

test('immediate cancellation and post-timer disposal reject before read receipts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArtifacts({ seed: 'sample', historyRead: 'delayed' })
  const controller = new AbortController()
  controller.abort('private')
  await assert.rejects(owner.beforeRead('history', controller.signal), CLOSED)
  const delayed = assert.rejects(owner.beforeRead('history'), CLOSED)
  context.mock.timers.tick(PREVIEW_ARTIFACTS.delayMs)
  owner.dispose()
  await delayed
})

test('dispose cancels all waits and all public operations; replacement owner starts clean', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArtifacts({ seed: 'sample', catalogRead: 'delayed', contentRead: 'delayed' })
  const file = new PreviewFiles().read('readme.md')
  const published = owner.publish('session', 'turn', file, 'final')
  const reads = [assert.rejects(owner.beforeRead('catalog'), CLOSED), assert.rejects(owner.beforeRead('content'), CLOSED)]
  owner.dispose()
  owner.dispose()
  await Promise.all(reads)
  context.mock.timers.tick(PREVIEW_ARTIFACTS.delayMs)
  assert.throws(() => owner.publish('session', 'turn', file, 'final'), CLOSED)
  assert.throws(() => owner.read('session', published.artifact_id), CLOSED)
  assert.throws(() => owner.recover(), CLOSED)
  await assert.rejects(owner.beforeRead('catalog'), CLOSED)
  const replacement = new PreviewArtifacts({ seed: 'empty' })
  assert.throws(() => replacement.read('session', published.artifact_id), MISSING)
  await replacement.beforeRead('catalog')
})

test('invalid publications have fixed errors and do not capture corrupted metadata', () => {
  const owner = new PreviewArtifacts(POLICY)
  const file = new PreviewFiles().read('readme.md')
  const invalid = { message: PREVIEW_ARTIFACTS.invalid, status: 422 }
  assert.throws(() => owner.publish('', 'turn', file, 'final'), invalid)
  assert.throws(() => owner.publish('session', '', file, 'final'), invalid)
  assert.throws(() => owner.publish('session', 'turn', { ...file, size: file.size + 1 }, 'final'), invalid)
  assert.throws(() => owner.publish('session', 'turn', { ...file, revision: 'private invalid digest' }, 'final'), invalid)
  assert.throws(() => owner.publish('session', 'turn', file, 'unknown' as 'final'), invalid)
  const valid = owner.publish('session', 'turn', file, 'final')
  assert.equal(owner.read('session', valid.artifact_id).revision, file.revision)
})

test('session and turn tuple identity cannot collide and policy recovery does not remove independent delay', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewArtifacts({ seed: 'sample', historyRead: 'failed', contentRead: 'delayed' })
  const file = new PreviewFiles().read('readme.md')
  const first = owner.publish('a:b', 'c', file, 'final')
  const second = owner.publish('a', 'b:c', file, 'final')
  assert.notEqual(first.artifact_id, second.artifact_id)
  owner.recover()
  await owner.beforeRead('history')
  const controller = new AbortController()
  const cancelled = assert.rejects(owner.beforeRead('content', controller.signal), CLOSED)
  context.mock.timers.tick(PREVIEW_ARTIFACTS.delayMs)
  controller.abort('do not echo this')
  await cancelled
})
