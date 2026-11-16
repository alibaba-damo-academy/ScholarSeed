import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftBuffer } from './drafts.ts'

test('draft writes remain ordered independently of mounted views', async () => {
  const buffer = new DraftBuffer({ state: {}, revision: 0 })
  const writes: number[] = []
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const write = async (state: Record<string, unknown>, revision: number) => {
    writes.push(revision)
    if (!revision) await waiting
    return { state, revision: revision + 1 }
  }
  const recover = async () => ({ state: {}, revision: 0 })
  const unsubscribe = buffer.subscribe(() => undefined)
  const first = buffer.save({ name: 'first' }, write, recover)
  unsubscribe()
  const second = buffer.save({ name: 'second' }, write, recover)
  assert.deepEqual(buffer.state, { name: 'second' })
  release()
  await Promise.all([first, second])
  assert.deepEqual(writes, [0, 1])
  assert.deepEqual(buffer.state, { name: 'second' })
  assert.equal(buffer.revision, 2)
  buffer.rebase({ state: { name: 'stale' }, revision: 1 })
  assert.equal(buffer.revision, 2)
  assert.deepEqual(buffer.state, { name: 'second' })
})

test('lost replies are reconciled against the real saved state without a second write', async () => {
  const buffer = new DraftBuffer({ state: {}, revision: 0 })
  let writes = 0
  await buffer.save({ name: 'saved' }, async () => { writes += 1; throw new Error('connection_lost') },
    async () => ({ state: { name: 'saved' }, revision: 1 }))
  assert.equal(writes, 1)
  assert.equal(buffer.revision, 1)
  assert.equal(buffer.failed, false)
})

test('failed saves preserve the latest local input and expose failure until a real receipt', async () => {
  const buffer = new DraftBuffer({ state: {}, revision: 0 })
  await assert.rejects(buffer.save({ name: 'unsaved' }, async () => { throw new Error('offline') },
    async () => { throw new Error('offline') }), /offline/)
  assert.deepEqual(buffer.state, { name: 'unsaved' })
  assert.equal(buffer.failed, true)
  buffer.rebase({ state: {}, revision: 0 })
  assert.deepEqual(buffer.state, { name: 'unsaved' })
  await buffer.save(buffer.state, async state => ({ state, revision: 1 }), async () => ({ state: {}, revision: 0 }))
  assert.equal(buffer.failed, false)
  assert.equal(buffer.revision, 1)
})

test('an authoritative terminal snapshot discards only an uncommitted local overlay', async () => {
  const buffer = new DraftBuffer({ state: {}, revision: 0 })
  await assert.rejects(buffer.save({ name: 'local' }, async () => { throw new Error('offline') },
    async () => { throw new Error('offline') }))
  buffer.rebase({ state: { name: 'accepted elsewhere' }, revision: 1 }, true)
  assert.deepEqual(buffer.state, { name: 'accepted elsewhere' })
  assert.equal(buffer.failed, false)
})
