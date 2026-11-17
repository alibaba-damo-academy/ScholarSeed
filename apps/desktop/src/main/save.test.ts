import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm, readdir, link, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { prepareSaveCopy, saveFileCopy, savePathCopy } from './save.ts'

test('authorized JPEG copies preserve their suffix and original encoded bytes without rejected writes', async () => {
  const original = Buffer.from(
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD53ooor8vP9HD/2Q==',
    'base64'
  )
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-jpeg-copy-')))
  const source = join(root, 'original.jpeg')
  const destination = join(root, 'copy.jpeg')
  await writeFile(source, original)
  try {
    const result = await savePathCopy(
      { sourcePath: source, suggestedName: 'original.jpeg' },
      async (name) => {
        assert.equal(name, 'original.jpeg')
        return destination
      },
      (path) => (path === source ? source : null)
    )
    assert.equal(result.ok, true)
    assert.deepEqual((await readFile(destination)).subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]))
    assert.deepEqual(await readFile(destination), original)
    assert.deepEqual(await readFile(source), original)
    const rejected = await savePathCopy(
      { sourcePath: source, suggestedName: 'original.jpeg' },
      async () => assert.fail('unauthorized source must not open the destination picker'),
      () => null
    )
    assert.equal(rejected.ok, false)
    assert.deepEqual(await readFile(destination), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('path copy needs authorization, preserves originals and leaves nothing on cancel or alias', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'attachment-save-')))
  const source = join(root, 'source.bin')
  const target = join(root, 'target.bin')
  const alias = join(root, 'alias.bin')
  await writeFile(source, new Uint8Array([0, 4, 255]))
  await link(source, alias)
  const request = { sourcePath: source, suggestedName: 'copy.bin' }
  try {
    let picks = 0
    const rejected = await savePathCopy(
      request,
      async () => {
        picks++
        return target
      },
      () => null
    )
    assert.equal(rejected.ok, false)
    assert.equal(picks, 0)
    assert.equal(
      (
        await savePathCopy(
          request,
          async () => null,
          () => source
        )
      ).canceled,
      true
    )
    assert.equal(
      (
        await savePathCopy(
          request,
          async () => alias,
          () => source
        )
      ).ok,
      false
    )
    assert.deepEqual((await readdir(root)).sort(), ['alias.bin', 'source.bin'])
    assert.equal(
      (
        await savePathCopy(
          request,
          async () => target,
          () => source
        )
      ).ok,
      true
    )
    assert.deepEqual(await readFile(target), await readFile(source))
    await writeFile(target, 'replace me')
    assert.equal(
      (
        await savePathCopy(
          request,
          async () => target,
          () => source
        )
      ).ok,
      true
    )
    assert.deepEqual(await readFile(target), await readFile(source))
    assert.deepEqual((await readdir(root)).sort(), ['alias.bin', 'source.bin', 'target.bin'])
    assert.equal(
      (
        await savePathCopy(
          request,
          async () => target,
          () => null
        )
      ).ok,
      false
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
    async () => {
      writes += 1
    }
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
    async (_path, bytes) => {
      written = Array.from(bytes)
    }
  )
  assert.deepEqual(success, { ok: true, path: '/tmp/result.bin' })
  assert.deepEqual(written, [4, 5, 6])

  const failure = await saveFileCopy(
    payload,
    async () => '/tmp/result.bin',
    async () => {
      throw new Error('disk full')
    }
  )
  assert.deepEqual(failure, { ok: false, error: 'disk full' })
})
