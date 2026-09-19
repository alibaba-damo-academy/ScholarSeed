import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareSaveCopy, saveFileCopy } from './save.ts'

test('keeps exact bytes and strips path traversal from the suggested name', () => {
  const bytes = new Uint8Array([0, 1, 2, 255])
  const prepared = prepareSaveCopy({ suggestedName: '../../result.bin', bytes })
  assert.ok(prepared)
  assert.equal(prepared.suggestedName, 'result.bin')
  assert.deepEqual(Array.from(prepared.bytes), Array.from(bytes))
})

test('rejects non-binary save payloads before a native dialog can write', () => {
  assert.equal(prepareSaveCopy({ suggestedName: 'result.md', bytes: 'not bytes' }), null)
  assert.equal(prepareSaveCopy(null), null)
})

test('cancellation never invokes the writer', async () => {
  let writes = 0
  const result = await saveFileCopy(
    { suggestedName: 'result.md', bytes: new Uint8Array([1]) },
    async () => null,
    async () => { writes += 1 }
  )
  assert.deepEqual(result, { ok: false, canceled: true })
  assert.equal(writes, 0)
})

test('writes exact bytes only after selection and reports writer failure', async () => {
  let written: number[] = []
  const payload = { suggestedName: 'result.bin', bytes: new Uint8Array([4, 5, 6]) }
  const success = await saveFileCopy(
    payload,
    async () => '/tmp/result.bin',
    async (_path, bytes) => { written = Array.from(bytes) }
  )
  assert.deepEqual(success, { ok: true, path: '/tmp/result.bin' })
  assert.deepEqual(written, [4, 5, 6])

  const failure = await saveFileCopy(
    payload,
    async () => '/tmp/result.bin',
    async () => { throw new Error('disk full') }
  )
  assert.deepEqual(failure, { ok: false, error: 'disk full' })
})
