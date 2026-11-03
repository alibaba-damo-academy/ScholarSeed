const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const SOURCE = path.join(sourceDirectory, 'events.cjs')
const CODE = fs.readFileSync(SOURCE, 'utf8')
const C8 = '/fixture/c8.cjs'

function guarded(source = CODE) {
  const context = vm.createContext({ module: { exports: {} }, __filename: SOURCE, require: name => {
    if (name !== 'node:url') throw new ReferenceError(`require is not defined for ${name}`)
    return { pathToFileURL }
  } },
    { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(source, context, { filename: SOURCE })
  return context.module.exports
}

const subject = guarded()
const parseNodeEvents = (...args) => structuredClone(subject.parseNodeEvents(...args))
const nodeReporterArgs = (...args) => structuredClone(subject.nodeReporterArgs(...args))

function encoded(events) {
  return events.map(event => JSON.stringify(event)).join('\n') + '\n'
}

function transcript() {
  return [
    { type: 'ci:node-start', schemaVersion: 1, nodeVersion: 'v24.16.0' },
    { type: 'test:start', data: { name: 'outer', file: 'shared.cjs', line: 1, column: 1,
      nesting: 0, testId: 1 } },
    { type: 'test:start', data: { name: 'leaf', file: 'shared.cjs', line: 2, column: 1,
      nesting: 1, testId: 2 } },
    { type: 'test:pass', data: { name: 'leaf', file: 'shared.cjs', line: 2, column: 1,
      nesting: 1, testId: 2, details: { type: 'test', duration_ms: 2 } } },
    { type: 'test:pass', data: { name: 'outer', file: 'shared.cjs', line: 1, column: 1,
      nesting: 0, testId: 1, details: { type: 'test', duration_ms: 10 } } },
    { type: 'test:summary', data: { file: 'entry-a.cjs', success: true, duration_ms: 12,
      counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 1 } } },
    { type: 'test:summary', data: { success: true, duration_ms: 20,
      counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 1 } } },
    { type: 'ci:node-end' }
  ]
}

test('observations preserve nested names, declared sources and non-additive durations', () => {
  const result = parseNodeEvents(encoded(transcript()), 'sample')
  assert.equal(result.available, true)
  assert.equal(result.nodeVersion, 'v24.16.0')
  assert.equal(result.durationBasis, 'node-test-framework')
  assert.equal(result.sourceAttribution, 'declared-source-only')
  assert.deepEqual(result.records.map(record => record.titlePath), [['outer', 'leaf'], ['outer']])
  assert.deepEqual(result.records.map(record => record.durationMs), [2, 10])
  assert.equal(result.durationMs, 20)
  assert.equal(result.records[0].logicalKey, '["shared.cjs",2,1,["outer","leaf"]]')
  assert.equal(result.records[0].declaredSource, 'shared.cjs')
  assert.equal(result.fileSummaries[0].file, 'entry-a.cjs')
  assert.equal(Object.hasOwn(result.records[0], 'entryFile'), false)
})

test('worker-local ids and repeated helper declarations are not globally deduplicated', () => {
  const source = transcript()
  const events = [source[0], ...source.slice(1, 6), ...structuredClone(source.slice(1, 6)),
    { type: 'test:summary', data: { success: true, duration_ms: 30,
      counts: { tests: 4, passed: 4, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 2 } } },
    source.at(-1)]
  events[10].data.file = 'entry-b.cjs'
  const result = parseNodeEvents(encoded(events), 'sample')
  assert.equal(result.records.length, 4)
  assert.equal(new Set(result.records.map(record => record.id)).size, 4)
  assert.equal(result.records[0].logicalKey, result.records[2].logicalKey)
  assert.deepEqual(result.records.map(record => record.occurrence), [1, 1, 2, 2])
  assert.deepEqual(result.records.map(record => record.runtimeId), [2, 1, 2, 1])
})

test('incomplete, duplicated, mismatched and malformed observations fail closed', () => {
  const mutations = [
    events => events.slice(1),
    events => events.slice(0, -1),
    events => events.filter((_, index) => index !== 3),
    events => events.filter((_, index) => index !== 5),
    events => [...events.slice(0, 4), events[3], ...events.slice(4)],
    events => { events[3].data.testId = 9; return events },
    events => { events[3].data.details.duration_ms = -1; return events },
    events => { events[6].data.counts.passed = 1; return events },
    events => { events[5].data.counts.tests = 1; events[5].data.counts.passed = 1; return events },
    events => { events[6].data.counts.tests = 3; events[6].data.counts.passed = 3; return events },
    events => [...events.slice(0, -1), events[6], events.at(-1)],
    events => { events[0].schemaVersion = 2; return events },
    events => { events[2].data.nesting = 3; return events },
    events => { events[3].data.skip = {}; return events },
    events => { events[3].data.details.attempt = 2; return events },
    events => [...events.slice(0, -1), events[5], events.at(-1)]
  ]
  for (const mutate of mutations) assert.throws(() => parseNodeEvents(encoded(mutate(transcript())), 'sample'))
  assert.throws(() => parseNodeEvents(encoded(transcript()).trimEnd(), 'sample'), /incomplete/)
  assert.throws(() => parseNodeEvents('private diagnostic payload\n', 'sample'),
    { message: 'Node observations: malformed JSON event' })
})

test('reporter flags preserve original Node and C8 plans without duplicate reporters', () => {
  const destination = path.resolve('tmp/node events.jsonl')
  const args = [C8, process.execPath, '--test', '--test-concurrency=4', 'sample.test.cjs']
  const snapshot = [...args]
  const observed = nodeReporterArgs(args, destination)
  assert.deepEqual(args, snapshot)
  assert.deepEqual(observed.slice(0, 3), args.slice(0, 3))
  assert.deepEqual(observed.slice(-2), ['--test-concurrency=4', 'sample.test.cjs'])
  assert.ok(observed.includes(`--test-reporter-destination=${destination}`))
  assert.ok(observed.includes(`--test-reporter=${pathToFileURL(SOURCE).href}`))
  assert.throws(() => nodeReporterArgs(observed, destination), /already configures/)
  assert.equal(nodeReporterArgs(['script.cjs'], destination), null)

})

test('purity guard rejects import and deferred external dependencies', () => {
  assert.throws(() => guarded('require("node:fs");' + CODE), /require is not defined/)
  for (const violation of ['require("node:sqlite")', 'process.getBuiltinModule("node:fs")',
    'fetch("https://invalid.test")', 'setTimeout(() => {}, 1)']) {
    const mutated = guarded(CODE.replace('function parseNodeEvents(output, stageId) {',
      'function parseNodeEvents(output, stageId) {' + violation + ';'))
    assert.throws(() => mutated.parseNodeEvents(encoded(transcript()), 'sample'), /is not defined/)
  }
})
