const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { parseNodeEvents, nodeReporterArgs } = require('../events.cjs')
const { runStage, reportsIntact, stageLaunch, planStages } = require('../test.cjs')
const { judgeRun } = require('../verdict.cjs')

const COMMIT = 'a'.repeat(40)
const C8 = path.resolve(sourceDirectory, '../../apps/desktop/node_modules/c8/bin/c8.js')

function fixture(context) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-events-')))
  context.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    assert.equal(fs.existsSync(directory), false)
  })
  return directory
}

test('reporter launch preserves both platform plans', () => {
  for (const platform of ['darwin', 'win32']) {
    const stage = planStages(platform, {}, { profile: 'offline', quarantine: true })
      .find(item => item.id === 'desktop-unit')
    const original = [...stage.args]
    const launch = stageLaunch(stage, path.resolve('tmp/node-plan'))
    assert.deepEqual(stage.args, original)
    assert.equal(launch.args.filter(argument => argument === '--test-reporter=spec').length, 1)
  }
})

test('real Node statuses retain suite, skip, todo, deadline cancellation and failure records', context => {
  const directory = fixture(context)
  fs.writeFileSync(path.join(directory, 'sample.test.cjs'),
    'const { test, describe } = require("node:test");' +
    'describe("suite", () => { test("pass", () => {}); });' +
    'test("skip", { skip: "diagnostic skip" }, () => {});' +
    'test("todo", { todo: "diagnostic todo" }, () => { throw Error("expected fixture"); });' +
    'test("deadline", { timeout: 20 }, async () => {' +
    ' await new Promise(resolve => setTimeout(resolve, 100)); });' +
    'test("fail", () => { throw Error("diagnostic failure"); });\n')
  const stage = { id: 'sample', kind: 'node', cwd: directory,
    args: ['--test', 'sample.test.cjs'], reportKind: 'node-summary' }
  const result = runStage(stage, directory, 'darwin', COMMIT)
  assert.notEqual(result.exitCode, 0)
  const launch = stageLaunch(stage, directory)
  const observations = parseNodeEvents(fs.readFileSync(launch.nodeEvents, 'utf8'), 'sample')
  assert.equal(observations.frameworkSuccess, false)
  assert.deepEqual(observations.counts,
    { tests: 5, passed: 1, failed: 1, cancelled: 1, skipped: 1, todo: 1, suites: 1, topLevel: 5 })
  assert.equal(observations.records.filter(record => record.kind === 'suite').length, 1)
  assert.equal(observations.records.find(record => record.status === 'cancelled').failureType,
    'testTimeoutFailure')
})

test('real C8 coverage failure is not hidden by passing Node observations', context => {
  const directory = fixture(context)
  fs.writeFileSync(path.join(directory, 'module.cjs'), 'exports.used = () => 1; exports.unused = () => 2;\n')
  fs.writeFileSync(path.join(directory, 'sample.test.cjs'),
    'const test = require("node:test"); const assert = require("node:assert/strict");' +
    'test("used", () => assert.equal(require("./module.cjs").used(), 1));\n')
  const stage = { id: 'sample', kind: 'node', cwd: directory, reportKind: 'node-summary',
    args: [C8, '--temp-directory=./v8', '--reports-dir=./coverage', '--reporter=json-summary',
      '--include=module.cjs', '--check-coverage', '--functions=100', process.execPath,
      '--test', 'sample.test.cjs'] }
  const result = runStage(stage, directory, 'darwin', COMMIT)
  assert.notEqual(result.exitCode, 0)
  assert.ok(result.report, result.reportError)
  const payload = JSON.parse(fs.readFileSync(result.report, 'utf8'))
  assert.equal(payload.observations.counts.passed, 1)
  assert.equal(payload.observations.records[0].titlePath[0], 'used')
  assert.equal(payload.observations.frameworkSuccess, true)
  assert.equal(judgeRun({ platform: 'darwin', commit: COMMIT, sourceClean: true, reportsIntact: true,
    expected: result.cases.map(item => item.id), stages: [result] }).verdict, 'fail')
  assert.equal(reportsIntact([result], directory), true)
  payload.observations.records[0].status = 'failed'
  fs.writeFileSync(result.report, JSON.stringify(payload))
  assert.equal(reportsIntact([result], directory), false)
})

test('missing event transport rejects an otherwise passing real Node stage', context => {
  const directory = fixture(context)
  fs.writeFileSync(path.join(directory, 'sample.test.cjs'),
    'const test = require("node:test"); test("pass", () => {});\n')
  const preload = path.join(directory, 'remove.cjs')
  fs.writeFileSync(preload,
    'const fs = require("node:fs"); if (process.execArgv.includes("--test")) {' +
    ' process.on("exit", () => fs.unlinkSync(process.env.EVENT_FILE)); }\n')
  const stage = { id: 'sample', kind: 'node', cwd: directory,
    args: ['--require', preload, '--test', 'sample.test.cjs'], reportKind: 'node-summary',
    env: { EVENT_FILE: path.join(directory, 'sample.node.jsonl') } }
  const result = runStage(stage, directory, 'darwin', COMMIT)
  assert.equal(result.exitCode, 0)
  assert.equal(result.report, null)
  assert.match(result.reportError, /ENOENT/)
  assert.equal(judgeRun({ platform: 'darwin', commit: COMMIT, sourceClean: true, reportsIntact: false,
    expected: ['sample:node-run-1'], stages: [result] }).verdict, 'fail')
})

test('printed passing counts cannot replace a direct Node test invocation', context => {
  const directory = fixture(context)
  const output = 'ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n'
  const stage = { id: 'sample', kind: 'node', cwd: directory, reportKind: 'node-summary',
    args: ['-e', `process.stdout.write(${JSON.stringify(output)})`] }
  const result = runStage(stage, directory, 'darwin', COMMIT)
  assert.equal(result.exitCode, 0)
  assert.equal(result.report, null)
  assert.match(result.reportError, /direct --test/)
})

test('real imported declarations remain distinct and empty or broken files retain wrapper results', context => {
  const directory = fixture(context)
  fs.writeFileSync(path.join(directory, 'shared.cjs'),
    'require("node:test")("shared declaration", () => {});\n')
  for (const name of ['first', 'second']) {
    fs.writeFileSync(path.join(directory, `${name}.test.cjs`), 'require("./shared.cjs");\n')
  }
  fs.writeFileSync(path.join(directory, 'empty.test.cjs'), '')
  fs.writeFileSync(path.join(directory, 'broken.test.cjs'), 'throw Error("fixture import failure");\n')
  const stage = { id: 'sample', kind: 'node', cwd: directory, reportKind: 'node-summary',
    args: ['--test', 'first.test.cjs', 'empty.test.cjs', 'second.test.cjs', 'broken.test.cjs'] }
  const result = runStage(stage, directory, 'darwin', COMMIT)
  assert.notEqual(result.exitCode, 0)
  assert.ok(result.report, result.reportError)
  const observations = JSON.parse(fs.readFileSync(result.report, 'utf8')).observations
  assert.equal(observations.counts.tests, 4)
  assert.equal(observations.counts.passed, 3)
  assert.equal(observations.counts.failed, 1)
  const shared = observations.records.filter(record => record.titlePath[0] === 'shared declaration')
  assert.equal(shared.length, 2)
  assert.deepEqual(shared.map(record => record.occurrence), [1, 2])
  assert.equal(shared[0].logicalKey, shared[1].logicalKey)
})

test('natural exit drains a large tail of actual case results and the file summary', context => {
  const directory = fixture(context)
  fs.writeFileSync(path.join(directory, 'sample.test.cjs'),
    'const test = require("node:test");' +
    'for (let index = 0; index < 2000; index++) test(`case-${index}`, () => {});\n')
  const stage = { id: 'sample', kind: 'node', cwd: directory, reportKind: 'node-summary',
    args: ['--test', 'sample.test.cjs'] }
  const result = runStage(stage, directory, 'darwin', COMMIT)
  assert.equal(result.exitCode, 0)
  assert.ok(result.report, result.reportError)
  const payload = JSON.parse(fs.readFileSync(result.report, 'utf8'))
  assert.equal(payload.observations.counts.tests, 2000)
  assert.equal(payload.observations.counts.passed, 2000)
  assert.equal(payload.observations.records.length, 2000)
  assert.equal(payload.observations.fileSummaries.length, 1)
  assert.deepEqual(payload.observations.records.at(-1).titlePath, ['case-1999'])
})
