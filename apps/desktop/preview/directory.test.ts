import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreviewDirectoryPicker, readPreviewStorageBootstrap } from './directory.ts'

const choices = [{ id: 'workspace', label: 'Virtual workspace', path: '/preview/virtual/one' }]

test('virtual picker settles only one accepted caller and cancels duplicate or dismissed requests', async () => {
  const picker = createPreviewDirectoryPicker()
  assert.equal(await picker.pick(choices), null)
  const observed: number[] = []
  const unsubscribe = picker.subscribe(value => { observed.push(value.length) })
  const first = picker.pick(choices)
  assert.equal(await picker.pick(choices), null)
  picker.finish('unknown')
  picker.finish('workspace')
  assert.equal(await first, choices[0].path)
  const cancelled = picker.pick(choices)
  picker.finish(null)
  assert.equal(await cancelled, null)
  assert.deepEqual(observed, [0, 1, 0, 1, 0])
  unsubscribe()
})

test('storage bootstrap rejects local paths, mutable home and malformed or duplicated candidates', () => {
  const bootstrap = { config: { home: '/preview/home', runtimeStore: '/preview/home/runtime', configured: false, canChangeDataHome: false, firstLaunchEligible: false }, choices }
  assert.deepEqual(readPreviewStorageBootstrap(bootstrap), bootstrap)
  for (const config of [{ ...bootstrap.config, home: '/Users/private' }, { ...bootstrap.config, canChangeDataHome: true }]) {
    assert.throws(() => readPreviewStorageBootstrap({ ...bootstrap, config }), /Invalid/)
  }
  for (const candidates of [[], [...choices, ...choices], [{ ...choices[0], path: '/tmp/real' }], [{ ...choices[0], path: '/preview/../real' }]]) {
    assert.throws(() => readPreviewStorageBootstrap({ ...bootstrap, choices: candidates }), /Invalid/)
  }
})

test('synchronous host cancellation still returns a settled promise rather than losing its receipt', async () => {
  const picker = createPreviewDirectoryPicker()
  const unsubscribe = picker.subscribe(value => { if (value.length) picker.finish(null) })
  const result = picker.pick(choices)
  assert.ok(result instanceof Promise)
  assert.equal(await result, null)
  unsubscribe()
})
