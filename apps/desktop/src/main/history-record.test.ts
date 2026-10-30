import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  HISTORY_OBJECTS_SQL,
  HISTORY_SCHEMA_SQL,
  HISTORY_ROWS_SQL,
  inspectHistorySchema,
  inspectHistoryRequest,
} from './history-record.ts'

test('history owner accepts its persisted schema and identifies missing indexes', () => {
  const database = new DatabaseSync(':memory:')
  try {
    assert.equal(inspectHistorySchema([]).needsWrite, true)
    database.exec(HISTORY_SCHEMA_SQL)
    assert.equal(
      inspectHistorySchema(database.prepare(HISTORY_OBJECTS_SQL).all()).needsWrite,
      false
    )
    database.exec('DROP INDEX browser_visits_time')
    assert.equal(inspectHistorySchema(database.prepare(HISTORY_OBJECTS_SQL).all()).needsWrite, true)
    database.exec('ALTER TABLE browser_visits ADD COLUMN future TEXT')
    assert.throws(
      () => inspectHistorySchema(database.prepare(HISTORY_OBJECTS_SQL).all()),
      /schema_invalid/
    )
  } finally {
    database.close()
  }
})

test('history inspection rejects incompatible rows and unknown protocol fields', () => {
  const database = new DatabaseSync(':memory:')
  const request = (value: unknown) => ({
    version: 1,
    owner: 'browser-history',
    mode: 'rows',
    value,
  })
  try {
    database.exec(HISTORY_SCHEMA_SQL)
    database
      .prepare('INSERT INTO browser_visits VALUES (?, ?, ?, ?, ?)')
      .run('visit', 'https://example.org/a', 'https://example.org', 'Page', 10)
    const rows = database.prepare(HISTORY_ROWS_SQL).all()
    assert.deepEqual(inspectHistoryRequest(request(rows)), { version: 1, count: 1 })
    for (const mutation of [
      { origin: 'https://other.org' },
      { visitedAt: '10' },
      { id: null },
      { url: 'invalid' },
    ]) {
      assert.throws(() => inspectHistoryRequest(request([{ ...rows[0], ...mutation }])))
    }
    assert.throws(() => inspectHistoryRequest({ ...request(rows), path: '/tmp/history' }))
    database.exec('CREATE TABLE unrelated (value TEXT)')
    assert.throws(
      () => inspectHistorySchema(database.prepare(HISTORY_OBJECTS_SQL).all()),
      /schema_invalid/
    )
  } finally {
    database.close()
  }
})
