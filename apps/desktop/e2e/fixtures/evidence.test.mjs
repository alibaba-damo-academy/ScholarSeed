import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import test from 'node:test'
import { captureOutput, createTimeline } from './evidence.mjs'

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'history-log-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('process logs drain both pipes and flush the last bytes before returning', async (t) => {
  const path = join(await directory(t), 'process.log')
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const evidence = new AbortController()
  const lines = []
  const flush = captureOutput([stdout, stderr], path, evidence, (line) => lines.push(line))
  const message = 'x'.repeat(256 * 1024)
  stdout.write(message + '\n')
  assert.ok(stdout.isPaused(), 'verbose output should pause at the file high-water mark')
  stderr.end('partial')
  stdout.end('tail\n')
  await Promise.all([finished(stdout), finished(stderr)])
  await flush()
  evidence.signal.throwIfAborted()
  assert.deepEqual(lines.sort(), [message, 'partial', 'tail'].sort())
  const raw = await readFile(path, 'utf8')
  assert.ok(raw.includes(message + '\n') && raw.includes('partial') && raw.includes('tail\n'))
  assert.equal(raw.length, message.length + '\npartialtail\n'.length)
})

test('timeline flushes a burst in observation order', async (t) => {
  const path = join(await directory(t), 'timeline.jsonl')
  const records = []
  const evidence = new AbortController()
  const timeline = createTimeline(path, records, evidence)
  for (let i = 0; i < 10_000; i++) timeline.emit('request', { index: i })
  await timeline.finish()
  evidence.signal.throwIfAborted()
  const rows = (await readFile(path, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(rows, records)
  assert.equal(rows.length, 10_000)
})

test('a broken file drains its source and preserves an earlier observer failure', async (t) => {
  const invalidFile = await directory(t)
  const evidence = new AbortController()
  const input = new PassThrough()
  const first = new Error('observer failed')
  const flush = captureOutput([input], invalidFile, evidence, () => {
    throw first
  })
  input.end('x'.repeat(256 * 1024) + '\n')
  await finished(input)
  await flush()
  assert.equal(evidence.signal.reason, first)

  const timelineEvidence = new AbortController()
  const records = []
  const timeline = createTimeline(invalidFile, records, timelineEvidence)
  for (let i = 0; i < 10_000; i++) timeline.emit('health')
  await timeline.finish()
  assert.ok(timelineEvidence.signal.aborted)
  assert.equal(records.length, 10_000)
})
