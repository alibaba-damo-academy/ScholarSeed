import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_DEVELOPER, PreviewDeveloper } from './developer.ts'

test('sample keys and idempotent ensure are isolated summaries without usable credentials', async () => {
  const owner = new PreviewDeveloper()
  const initial = await owner.list()
  assert.equal(initial.keys.length, 1)
  assert.equal(initial.keys[0].managed, false)
  assert.match(initial.keys[0].name, /模拟/)
  owner.ensure()
  owner.ensure()
  const snapshot = await owner.list()
  assert.equal(snapshot.keys.length, 2)
  assert.equal(snapshot.keys.filter(key => key.managed).length, 1)
  assert.ok(snapshot.keys.every(key => key.prefix.startsWith('preview-only:')))
  assert.ok(snapshot.keys.every(key => !('token' in key)))
  snapshot.keys[0].name = 'modified snapshot'
  assert.notEqual((await owner.list()).keys[0].name, 'modified snapshot')
  const other = new PreviewDeveloper()
  await assert.rejects(other.revoke(initial.keys[0].key_id), { status: 404 })
})

test('creation returns synthetic plaintext only once, without retaining or echoing supplied credentials', async () => {
  const owner = new PreviewDeveloper({ read: 'empty', write: 'normal' })
  owner.ensure()
  assert.deepEqual(await owner.list(), { keys: [] })
  const created = await owner.create({ name: '  模拟客户端  ' })
  assert.equal(created.name, '模拟客户端')
  assert.match(created.token, /^preview-only:/)
  assert.equal(created.prefix, PREVIEW_DEVELOPER.tokenPrefix + created.token.slice(PREVIEW_DEVELOPER.tokenPrefix.length, PREVIEW_DEVELOPER.tokenPrefix.length + 8))
  assert.equal(created.key_id.includes(created.token.slice(PREVIEW_DEVELOPER.tokenPrefix.length)), false)
  assert.equal(created.token.startsWith('ssk-'), false)
  assert.equal(created.token.split('.').length, 1)
  const list = await owner.list()
  assert.equal(list.keys.length, 1)
  assert.equal(list.keys[0].key_id, created.key_id)
  assert.equal(JSON.stringify(list).includes(created.token), false)
  for (const body of [null, [], 'name', {}, { name: false }, { name: 'x'.repeat(PREVIEW_DEVELOPER.maxName + 1) }, { name: 'safe', token: 'never-echo-this' }, Object.create({ name: 'inherited' })]) {
    await assert.rejects(owner.create(body), error => {
      assert.equal((error as { status: number }).status, 400)
      assert.equal(String(error).includes('never-echo-this'), false)
      return true
    })
  }
  assert.equal((await owner.list()).keys.length, 1)
  assert.equal((await owner.revoke(created.key_id)).revoked, true)
  await assert.rejects(owner.revoke(created.key_id), { status: 404 })
})

test('managed keys rotate but cannot revoke; manual keys revoke but cannot rotate', async () => {
  const owner = new PreviewDeveloper()
  owner.ensure()
  const keys = (await owner.list()).keys
  const managed = keys.find(key => key.managed)!
  const manual = keys.find(key => !key.managed)!
  await assert.rejects(owner.revoke(managed.key_id), { status: 403 })
  await assert.rejects(owner.rotate(manual.key_id), { status: 403 })
  assert.deepEqual(await owner.rotate(managed.key_id), { rotated: true })
  assert.equal((await owner.list()).keys.some(key => key.managed), false)
  owner.ensure()
  const next = (await owner.list()).keys.find(key => key.managed)!
  assert.notEqual(next.key_id, managed.key_id)
  await assert.rejects(owner.rotate(managed.key_id), { status: 404 })
  assert.deepEqual(await owner.revoke(manual.key_id), { revoked: true })
})

test('invalid or forbidden writes do not consume fail-once and failed writes do not partially commit', async () => {
  const owner = new PreviewDeveloper({ read: 'sample', write: 'fail-once' })
  owner.ensure()
  const before = await owner.list()
  await assert.rejects(owner.create({ name: 3 }), { status: 400 })
  await assert.rejects(owner.revoke(before.keys.find(key => key.managed)!.key_id), { status: 403 })
  await assert.rejects(owner.revoke('other-instance'), { status: 404 })
  await assert.rejects(owner.create({ name: '模拟失败重试' }), { status: 503 })
  assert.deepEqual(await owner.list(), before)
  await owner.create({ name: '模拟失败重试' })
  assert.equal((await owner.list()).keys.length, before.keys.length + 1)
})

test('failed reads remain failed without blocking synchronous summary ensure', async () => {
  const owner = new PreviewDeveloper({ read: 'failed', write: 'normal' })
  assert.doesNotThrow(() => owner.ensure())
  await assert.rejects(owner.list(), { status: 503 })
  await assert.rejects(owner.list(), { status: 503 })
})

test('delayed reads settle after the declared delay and abort or disposal settle with 410', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewDeveloper({ read: 'delayed', write: 'normal' })
  let settled = false
  const pending = owner.list().then(result => { settled = true; return result })
  context.mock.timers.tick(PREVIEW_DEVELOPER.delayMs - 1)
  await Promise.resolve()
  assert.equal(settled, false)
  context.mock.timers.tick(1)
  assert.equal((await pending).keys.length, 1)
  const controller = new AbortController()
  const aborted = assert.rejects(owner.list(controller.signal), { status: 410 })
  controller.abort()
  await aborted
  const disposed = assert.rejects(owner.list(), { status: 410 })
  owner.dispose()
  await disposed
})

test('pending writes reject concurrent writes and abort without changing the single ledger', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewDeveloper({ read: 'sample', write: 'delayed' })
  const manual = (await owner.list()).keys[0]
  const controller = new AbortController()
  const cancelled = assert.rejects(owner.create({ name: '模拟取消' }, controller.signal), { status: 410 })
  await assert.rejects(owner.revoke(manual.key_id), { status: 409 })
  await assert.rejects(owner.create({ name: '模拟重复' }), { status: 409 })
  controller.abort()
  await cancelled
  assert.equal((await owner.list()).keys.length, 1)
  const completed = owner.revoke(manual.key_id)
  context.mock.timers.tick(PREVIEW_DEVELOPER.delayMs)
  assert.deepEqual(await completed, { revoked: true })
  assert.deepEqual(await owner.list(), { keys: [] })
})

test('dispose fences pending mutation and all future operations, including already-aborted requests', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const owner = new PreviewDeveloper({ read: 'sample', write: 'delayed' })
  const closed = assert.rejects(owner.create({ name: '模拟关闭' }), { status: 410 })
  owner.dispose()
  owner.dispose()
  context.mock.timers.tick(PREVIEW_DEVELOPER.delayMs)
  await closed
  await assert.rejects(owner.list(), { status: 410 })
  await assert.rejects(owner.create({ name: '模拟关闭后' }), { status: 410 })
  await assert.rejects(owner.revoke('unknown'), { status: 410 })
  await assert.rejects(owner.rotate('unknown'), { status: 410 })
  assert.throws(() => owner.ensure(), { status: 410 })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(new PreviewDeveloper().create({ name: '' }, controller.signal), { status: 410 })
})

test('the explicit preview capacity is bounded, independent of real account quotas', async () => {
  const owner = new PreviewDeveloper({ read: 'empty', write: 'normal' })
  for (let index = 0; index < PREVIEW_DEVELOPER.maxKeys; index++) await owner.create({ name: `模拟-${index}` })
  await assert.rejects(owner.create({ name: '模拟超额' }), { status: 409 })
  assert.equal((await owner.list()).keys.length, PREVIEW_DEVELOPER.maxKeys)
})

test('request data and policy are captured without invoking same-shaped accessors', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const policy = { read: 'empty' as const, write: 'delayed' as 'delayed' | 'normal' }
  const owner = new PreviewDeveloper(policy)
  policy.write = 'normal'
  const fake = { get name(): string { throw new Error('credential-must-not-appear') } }
  await assert.rejects(owner.create(fake), { status: 400, message: PREVIEW_DEVELOPER.invalid })
  const input = { name: '模拟原始请求' }
  const pending = owner.create(input)
  input.name = 'mutated-after-submission'
  await assert.rejects(owner.create({ name: '' }), { status: 409 })
  context.mock.timers.tick(PREVIEW_DEVELOPER.delayMs)
  assert.equal((await pending).name, '模拟原始请求')
  const empty = owner.create({ name: '' })
  context.mock.timers.tick(PREVIEW_DEVELOPER.delayMs)
  assert.equal((await empty).name, '')
})
