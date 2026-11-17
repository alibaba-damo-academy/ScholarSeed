const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const { Worker } = require('node:worker_threads')
const {
  acquireSlot,
  collectSlot,
  observeRegistry,
  withRegistryObserver,
} = require('./registry.cjs')

const LOCK_HOLD_MS = 250
const LOCK_WAIT_FLOOR_MS = 100
const DATABASE_TIMEOUT_MS = 5000

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-timing-'))
  const filename = path.join(root, 'registry.sqlite')
  const database = new DatabaseSync(filename, { timeout: DATABASE_TIMEOUT_MS })
  database.exec(
    'CREATE TABLE slots (name TEXT PRIMARY KEY, slot INTEGER UNIQUE); CREATE TABLE slot_references (name TEXT, kind TEXT)'
  )
  context.after(() => {
    database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { database, filename }
}

test('coordination observations split begin, work, commit and rollback without names or SQL', (context) => {
  const { database } = fixture(context)
  const events = []
  const stop = observeRegistry((event) => events.push(event))
  context.after(stop)
  assert.equal(
    acquireSlot(
      database,
      'private-path-name',
      () => 17,
      () => {}
    ),
    17
  )
  assert.equal(
    collectSlot(
      database,
      'private-path-name',
      () => 23,
      () => {}
    ),
    true
  )
  assert.equal(events.length, 2)
  for (const event of events) {
    assert.equal(event.result, 'committed')
    for (const key of ['beginMs', 'operationMs', 'commitMs', 'rollbackMs'])
      assert.ok(event[key] >= 0)
    assert.ok(event.timestampMs > 0)
  }
  assert.ok(!JSON.stringify(events).includes('private-path-name'))
  assert.ok(!JSON.stringify(events).includes('SELECT'))
})

test('an admission failure rolls back and observations cannot change the original failure', (context) => {
  const { database } = fixture(context)
  const events = []
  const stop = observeRegistry((event) => events.push(event))
  const throwing = observeRegistry(() => {
    throw new Error('observer failure')
  })
  context.after(stop)
  context.after(throwing)
  const denied = new Error('private-admission-detail')
  assert.throws(
    () =>
      acquireSlot(
        database,
        'private-slot',
        () => {
          throw denied
        },
        () => {}
      ),
    (error) => error === denied
  )
  assert.equal(database.isTransaction, false)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM slots').get().count, 0)
  assert.equal(events[0].result, 'rolled-back')
  assert.equal(events[0].failedPhase, 'operation')
  assert.ok(!JSON.stringify(events).includes('private-admission-detail'))
})

test('a failed begin never rolls back a transaction owned by the caller', (context) => {
  const { database } = fixture(context)
  database.exec('BEGIN IMMEDIATE')
  assert.throws(() =>
    acquireSlot(
      database,
      'not-admitted',
      () => 17,
      () => {}
    )
  )
  assert.equal(database.isTransaction, true)
  database.exec('ROLLBACK')
})

test('concurrent asynchronous jobs retain their own registry observations', async (context) => {
  const { database } = fixture(context)
  const records = [[], []]
  await Promise.all(
    records.map((events, index) =>
      withRegistryObserver(
        (event) => events.push(event),
        async () => {
          await new Promise((resolve) => setImmediate(resolve))
          acquireSlot(
            database,
            `isolated-${index}`,
            () => index,
            () => {}
          )
        }
      )
    )
  )
  assert.deepEqual(
    records.map((events) => events.length),
    [1, 1]
  )
})

test('real SQLite writer contention appears in begin rather than commit', async (context) => {
  const { database, filename } = fixture(context)
  const events = []
  const stop = observeRegistry((event) => events.push(event))
  context.after(stop)
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads')
    const { DatabaseSync } = require('node:sqlite')
    const database = new DatabaseSync(workerData.filename)
    database.exec('BEGIN IMMEDIATE')
    parentPort.postMessage('held')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs)
    database.exec('COMMIT')
    database.close()
  `,
    { eval: true, workerData: { filename, holdMs: LOCK_HOLD_MS } }
  )
  const exited = once(worker, 'exit')
  await once(worker, 'message')
  acquireSlot(
    database,
    'contended-slot',
    () => 17,
    () => {}
  )
  await exited
  assert.ok(events[0].beginMs >= LOCK_WAIT_FLOOR_MS, JSON.stringify(events[0]))
  assert.ok(events[0].commitMs < events[0].beginMs, JSON.stringify(events[0]))
})
