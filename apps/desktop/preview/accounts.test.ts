import assert from 'node:assert/strict'
import test from 'node:test'
import { PreviewAccount, previewAccountBase, previewAccountMode, readPreviewAccountBootstrap } from './accounts.ts'

test('simulated account profiles use per-instance opaque capabilities, never cookies or real tokens', async () => {
  const first = new PreviewAccount('first', 'ready')
  const second = new PreviewAccount('second', 'ready')
  const bootstrap = first.bootstrap()
  assert.notEqual(bootstrap.capability, second.bootstrap().capability)
  assert.ok(bootstrap.capability?.startsWith('preview-account:'))
  assert.equal((await first.profile()).status, 401)
  assert.equal((await first.profile('Bearer real-token')).status, 401)
  assert.equal((await second.profile(`Bearer ${bootstrap.capability}`)).status, 401)
  const response = await first.profile(`Bearer ${bootstrap.capability}`)
  assert.equal(response.status, 200)
  assert.equal(first.identity().auth, true)
  assert.equal(first.identity().user_id, (response.body as { user_id: string }).user_id)
  assert.deepEqual(response.body, { user_id: 'preview-account:first', nickname: '模拟协作账号（非真实用户）' })
  assert.equal(first.authorizes(`Bearer ${bootstrap.capability}`), true)
  assert.equal(first.authorizes(), false)
  assert.equal(first.authorizes(`Bearer ${second.bootstrap().capability}`), false)
  first.dispose()
  assert.equal(first.identity().auth, false)
  assert.equal(first.authorizes(`Bearer ${bootstrap.capability}`), false)
  second.dispose()
})

test('account loading is bounded and disposal settles outstanding reads without a ready response', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const account = new PreviewAccount('delayed', 'delayed')
  let completed = false
  const pending = account.profile(`Bearer ${account.bootstrap().capability}`).then(response => { completed = true; return response })
  context.mock.timers.tick(1_999)
  await Promise.resolve()
  assert.equal(completed, false)
  context.mock.timers.tick(1)
  assert.equal((await pending).status, 200)
  const cancelled = account.profile(`Bearer ${account.bootstrap().capability}`)
  account.dispose()
  assert.equal((await cancelled).status, 410)
})

test('failed reads remain failed while anonymous and unconfigured scenes have no credential', async () => {
  const failed = new PreviewAccount('failed', 'failed')
  const authorization = `Bearer ${failed.bootstrap().capability}`
  assert.equal((await failed.profile(authorization)).status, 503)
  assert.equal((await failed.profile(authorization)).status, 503)
  for (const mode of ['anonymous', 'no-base'] as const) {
    const account = new PreviewAccount(mode, mode)
    assert.equal(account.bootstrap().capability, null)
    assert.equal(account.identity().auth, false)
    assert.equal((await account.profile()).status, 401)
  }
})

test('account bootstrap must match the selected instance and declared scene policy', () => {
  const account = new PreviewAccount('first', 'ready')
  const bootstrap = account.bootstrap()
  assert.deepEqual(readPreviewAccountBootstrap(bootstrap, 'first', 'ready'), bootstrap)
  assert.equal(readPreviewAccountBootstrap(undefined, 'first', undefined), undefined)
  for (const value of [undefined, {}, { ...bootstrap, instance: 'second' }, { ...bootstrap, mode: 'failed' }, { ...bootstrap, capability: 'real-token' }, { ...bootstrap, capability: null }]) {
    assert.throws(() => readPreviewAccountBootstrap(value, 'first', 'ready'), /Invalid preview account bootstrap/)
  }
  assert.throws(() => readPreviewAccountBootstrap(bootstrap, 'first', undefined), /Invalid preview account bootstrap/)
  assert.equal(previewAccountBase('http://127.0.0.1:5175', bootstrap), 'http://127.0.0.1:5175')
  assert.equal(previewAccountBase('http://127.0.0.1:5175', new PreviewAccount('first', 'no-base').bootstrap()), '')
  for (const origin of ['https://example.com', 'http://example.com', 'http://localhost:5175/path']) assert.throws(() => previewAccountBase(origin, bootstrap), /same-origin loopback/)
})

test('public login controls permit only explicit ready/anonymous policies without loosening other account scenarios', () => {
  for (const mode of ['ready', 'anonymous'] as const) {
    const account = new PreviewAccount('center', mode)
    const resolved = previewAccountMode(account.bootstrap(), undefined, true)
    assert.equal(resolved, mode)
    assert.deepEqual(readPreviewAccountBootstrap(account.bootstrap(), 'center', resolved), account.bootstrap())
    account.dispose()
  }
  for (const value of [undefined, null, {}, { mode: 'failed' }, { mode: 'delayed' }, { mode: 'real' }]) assert.throws(() => previewAccountMode(value, undefined, true))
  assert.equal(previewAccountMode({ mode: 'anonymous' }, 'failed', false), 'failed')
  assert.equal(previewAccountMode(undefined, undefined, false), undefined)
})

test('credits remain explicitly unavailable without losing the isolated account identity', async () => {
  const account = new PreviewAccount('credits', 'ready')
  const foreign = new PreviewAccount('foreign', 'ready')
  const authorization = `Bearer ${account.bootstrap().capability}`
  assert.equal((await account.credits()).status, 401)
  assert.equal((await account.credits(`Bearer ${foreign.bootstrap().capability}`)).status, 401)
  assert.deepEqual(await account.credits(authorization), { status: 503, body: { code: 'preview_credits_unavailable' } })
  assert.equal(account.identity().auth, true)
  assert.equal((await account.profile(authorization)).status, 200)
  account.dispose()
  assert.equal((await account.credits(authorization)).status, 410)
  foreign.dispose()
})

test('disposing a delayed credits read settles it without a successful balance', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const account = new PreviewAccount('credits-delayed', 'delayed')
  const pending = account.credits(`Bearer ${account.bootstrap().capability}`)
  account.dispose()
  assert.deepEqual(await pending, { status: 410, body: { code: 'preview_account_disposed' } })
})

test('credits disposal also wins before an already authorized read resumes', async () => {
  const account = new PreviewAccount('credits-ready-dispose', 'ready')
  const pending = account.credits(`Bearer ${account.bootstrap().capability}`)
  account.dispose()
  assert.deepEqual(await pending, { status: 410, body: { code: 'preview_account_disposed' } })
})
