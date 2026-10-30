import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PreviewModels, PreviewModelError, PREVIEW_MODELS, PREVIEW_MODEL_SAMPLE } from './models.ts'

test('model profiles preserve the complete redacted DTO with immutable disabled sample and distinct instance identities', async () => {
  const owner = new PreviewModels({ read: 'sample' })
  const document = await owner.read()
  assert.equal(document.path, PREVIEW_MODELS.logicalPath)
  assert.deepEqual(document.enabled_profile_ids, [])
  assert.equal(document.profiles.length, 1)
  const { id, ...profile } = document.profiles[0]
  assert.match(id, /^personal-[a-f0-9]{32}$/)
  assert.deepEqual(profile, PREVIEW_MODEL_SAMPLE)
  assert.deepEqual(owner.providers(), { providers: [] })
  assert.equal(owner.hasProfile(id), true)
  const other = new PreviewModels({ read: 'sample' })
  assert.equal(other.hasProfile(id), false)
  assert.notEqual((await other.read()).profiles[0].id, id)
  assert.equal(document.profiles[0].selected_models.length, 2)
  document.profiles[0].selected_models[0].id = 'changed-returned-copy'
  document.profiles[0].header_names.push('not-persisted')
  document.profiles[0].enabled = true
  assert.deepEqual((await owner.read()).profiles[0], { ...PREVIEW_MODEL_SAMPLE, id })
  owner.dispose()
  assert.equal(owner.hasProfile(id), false)
  await assert.rejects(owner.read(), (error: unknown) => error instanceof PreviewModelError && error.status === 410)
})

test('model empty and persistent failed policies do not invent available profiles or consume a failure on refresh', async () => {
  const empty = new PreviewModels()
  assert.deepEqual(await empty.read(), { path: PREVIEW_MODELS.logicalPath, profiles: [], enabled_profile_ids: [] })
  const failed = new PreviewModels({ read: 'failed' })
  for (const attempt of [0, 1]) {
    await assert.rejects(failed.read(), { message: PREVIEW_MODELS.readFailure }, `attempt ${attempt}`)
  }
  assert.deepEqual(failed.providers(), { providers: [] })
})

test('model delayed reads remain in flight and cancel on abort/dispose without exposing old profiles', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewModels({ read: 'delayed' })
  let settled = false
  const first = owner.read().then(document => { settled = true; return document })
  context.mock.timers.tick(PREVIEW_MODELS.delayMs - 1)
  await Promise.resolve()
  assert.equal(settled, false)
  context.mock.timers.tick(1)
  assert.equal((await first).profiles.length, 1)
  const abort = new AbortController()
  const cancelled = assert.rejects(owner.read(abort.signal), { message: PREVIEW_MODELS.disposed })
  abort.abort()
  await cancelled
  const oldRead = assert.rejects(owner.read(), { message: PREVIEW_MODELS.disposed })
  owner.dispose()
  context.mock.timers.tick(PREVIEW_MODELS.delayMs)
  await oldRead
  await assert.rejects(owner.read(), { message: PREVIEW_MODELS.disposed })
})
