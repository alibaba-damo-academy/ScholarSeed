import assert from 'node:assert/strict'
import test from 'node:test'
import { CsvProcessor, CsvQueue } from './protocol.ts'

test('worker owner rejects stale identity and mutations without expected version', () => {
  const owner = new CsvProcessor()
  assert.equal(
    owner.handle({
      command: 'open',
      requestId: 1,
      identity: 'a',
      bytes: new TextEncoder().encode('a,b\n'),
      revision: 'r1',
    }).ok,
    true
  )
  assert.equal(
    owner.handle({
      command: 'edit',
      requestId: 2,
      identity: 'a',
      patches: [{ row: 0, column: 0, value: 'x' }],
    }).error,
    'csv_version_required'
  )
  assert.equal(
    owner.handle({
      command: 'readWindow',
      requestId: 3,
      identity: 'old',
      window: { row: 0, column: 0, rows: 1, columns: 2 },
    }).error,
    'csv_identity_stale'
  )
  assert.equal(
    owner.handle({
      command: 'edit',
      requestId: 4,
      identity: 'a',
      expectedVersion: 0,
      patches: [{ row: 0, column: 0, value: 'x' }],
    }).version,
    1
  )
  assert.equal(
    owner.handle({
      command: 'edit',
      requestId: 5,
      identity: 'a',
      expectedVersion: 0,
      patches: [{ row: 0, column: 0, value: 'y' }],
    }).error,
    'csv_version_conflict'
  )
})

test('failed replacement open preserves previous document; close rejects subsequent access', () => {
  const owner = new CsvProcessor()
  owner.handle({
    command: 'open',
    requestId: 1,
    identity: 'a',
    bytes: new TextEncoder().encode('a,b\n'),
    revision: 'r1',
  })
  assert.equal(
    owner.handle({
      command: 'open',
      requestId: 2,
      identity: 'b',
      bytes: Uint8Array.of(0xff),
      revision: 'r2',
    }).ok,
    false
  )
  assert.equal(owner.handle({ command: 'state', requestId: 3, identity: 'a' }).ok, true)
  assert.equal(owner.handle({ command: 'close', requestId: 4, identity: 'a' }).ok, true)
  assert.equal(
    owner.handle({ command: 'state', requestId: 5, identity: 'a' }).error,
    'csv_identity_stale'
  )
})

test('rapid edits, paste, undo and serialize use their queued acknowledged version', async () => {
  const owner = new CsvProcessor(),
    versions: Array<number | undefined> = []
  const queue = new CsvQueue('a', async (request) => {
    versions.push(request.expectedVersion)
    await Promise.resolve()
    return owner.handle(request)
  })
  await queue.request({
    command: 'open',
    bytes: new TextEncoder().encode('a,b\nc,d\n'),
    revision: 'r1',
  })
  const first = queue.request({ command: 'edit', patches: [{ row: 0, column: 0, value: 'x' }] })
  const second = queue.request({ command: 'edit', patches: [{ row: 0, column: 0, value: 'y' }] })
  const saved = queue.request({ command: 'serialize' })
  const later = queue.request({ command: 'edit', patches: [{ row: 1, column: 1, value: 'z' }] })
  await Promise.all([first, second, later])
  const snapshot = (await saved).value as { version: number; bytes: Uint8Array }
  assert.equal(snapshot.version, 2)
  assert.equal(new TextDecoder().decode(snapshot.bytes), 'y,b\nc,d\n')
  assert.deepEqual(versions, [undefined, 0, 1, 2, 2])
  const ack = await queue.request({ command: 'acknowledgeSaved', version: 2, revision: 'saved-r2' })
  assert.equal((ack.value as { dirty: boolean }).dirty, true)
  await queue.request({ command: 'undo' })
  const state = await queue.request({ command: 'state' })
  assert.equal((state.value as { dirty: boolean }).dirty, false)
  queue.dispose()
  await assert.rejects(queue.request({ command: 'state' }), /csv_client_closed/)
})

test('worker owns TSV paste and copy, preserving FIFO versions and one undo transaction', async () => {
  const owner = new CsvProcessor(),
    queue = new CsvQueue('clipboard', async (request) => owner.handle(request))
  await queue.request({
    command: 'open',
    bytes: new TextEncoder().encode('a,b\nc,d\n'),
    revision: 'r0',
  })
  const paste = queue.request({ command: 'paste', row: 0, column: 0, text: '"x\ny"\t001\nz\t1e3' })
  const copy = queue.request({ command: 'copy', range: { top: 0, left: 0, bottom: 1, right: 1 } })
  const saved = queue.request({ command: 'serialize' })
  await paste
  assert.equal(
    (await copy).value && ((await copy).value as { text: string }).text,
    '"x\ny"\t001\nz\t1e3'
  )
  assert.equal(((await saved).value as { version: number }).version, 1)
  await queue.request({ command: 'undo' })
  const snapshot = (await queue.request({ command: 'serialize' })).value as { bytes: Uint8Array }
  assert.equal(new TextDecoder().decode(snapshot.bytes), 'a,b\nc,d\n')
})
