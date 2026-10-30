import assert from 'node:assert/strict'
import test from 'node:test'
import { ComponentTimer, ComponentDiagnostics } from './timing.ts'

test('startup exposes in-flight phase before completion and correlates retries', () => {
  const logs: string[] = []
  const timer = new ComponentTimer({ kind: 'runtime', version: '1' }, 'startup', (value) =>
    logs.push(value)
  )
  timer.start('helper')
  const events = () => logs.map((line) => JSON.parse(line.slice('[component-timing] '.length)))
  assert.deepEqual(
    events().map((event) => event.event),
    ['started', 'phase-started']
  )
  assert.equal(events()[1].phase, 'helper')
  timer.finish(true)
  assert.deepEqual(
    events().map((event) => event.event),
    ['started', 'phase-started', 'phase-finished', 'finished']
  )
  assert.equal(events()[2].status, 'failed')
  assert.equal(events()[3].last_phase, 'helper')
  assert.equal(new Set(events().map((event) => event.attempt)).size, 1)
  const previousAttempt = events()[0].attempt
  new ComponentTimer({ kind: 'runtime', version: '1' }, 'startup', (value) =>
    logs.push(value)
  ).finish(false)
  assert.notEqual(events().at(-1).attempt, previousAttempt)
})

test('timing closes failed phases once and logging cannot affect preparation', () => {
  const logs: string[] = []
  const timer = new ComponentTimer({ kind: 'python', version: '1-r1' }, 'prepare', (value) =>
    logs.push(value)
  )
  const end = timer.start('sync')
  timer.finish(true)
  end()
  timer.finish(false)
  assert.equal(logs.length, 1)
  const event = JSON.parse(logs[0].slice('[component-timing] '.length))
  assert.equal(event.status, 'failed')
  assert.equal(event.last_phase, 'sync')
  assert.equal(event.metrics.sync.calls, 1)
  assert.ok(event.elapsed_ms >= event.metrics.sync.elapsed_ms)
  assert.doesNotThrow(() =>
    new ComponentTimer({ kind: 'office', version: '1' }, 'reuse', () => {
      throw new Error('sink')
    }).finish(false)
  )
})

test('worker timing batches survive pipe chunking with bounded individual lines', () => {
  const logs: string[] = []
  const sink = new ComponentDiagnostics(256, (line) => logs.push(line))
  const lines = Array.from({ length: 100 }, (_, i) =>
    JSON.stringify({ kind: `component${i}`, metric: '中文' })
  )
  const bytes = Buffer.from(lines.join('\n') + '\n' + 'x'.repeat(400) + '\nlast')
  // Split within UTF-8 and line boundaries, including a chunk larger than limit.
  const split = bytes.indexOf(Buffer.from('中文')) + 1
  sink.push(bytes.subarray(0, split))
  sink.push(bytes.subarray(split))
  sink.finish()
  assert.deepEqual(
    logs.slice(0, 100),
    lines.map((line) => `[runtime] ${line}\n`)
  )
  assert.match(logs[100], /oversized/)
  assert.equal(logs[101], '[runtime] last\n')
})
