const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const workspace = require('../../../package.json')
const { validateManifest, selectionFor, validateCollection, validateCaseReport, validateNodeReport, smokeVerdict, resultPath, formatSmokeSummary, main } = require('../smoke.cjs')
const { validateQualityResult } = require('../../cd/package.cjs')

const ENTRY = { id: 'core', owner: 'Serve', reason: 'persistence recovery', markers: ['smoke-core'],
  layer: 'data', resources: ['sqlite'], inputExpected: 'literal isolated rows', cleanup: 'close then remove',
  invariants: ['reopen retains committed rows'],
  requiredCases: ['Case.test_one'], expectedCases: ['Case.test_one'], expectedCount: 1, runner: { kind: 'run-all', suite: 'contract_core' } }

function manifest() {
  return { schemaVersion: 1, profile: 'smoke', platforms: ['darwin'], requiredCoreIds: ['core'], requiredUnitIds: ['unit'],
    entries: [structuredClone(ENTRY), { ...structuredClone(ENTRY), id: 'unit', markers: ['smoke-unit'],
      runner: { kind: 'run-all', suite: 'contract_unit' } }] }
}

function report() {
  return { schemaVersion: 1, suite: 'contract_core', planned: ['Case.test_one'],
    cases: [{ id: 'Case.test_one', status: 'passed', retries: 0 }], errors: [], exitStatus: 0 }
}

test('smoke manifest rejects missing required markers and duplicate identities', () => {
  assert.equal(validateManifest(manifest()).entries.length, 2)
  const legacy = manifest()
  legacy.profile = 'quick'
  assert.throws(() => validateManifest(legacy), /invalid smoke manifest/)
  const legacyMarker = manifest()
  legacyMarker.entries[0].markers = ['quick-core']
  assert.throws(() => validateManifest(legacyMarker), /invalid smoke marker/)
  const missing = manifest()
  missing.entries[0].markers = []
  assert.throws(() => validateManifest(missing), /markers/)
  const duplicate = manifest()
  duplicate.entries[1].runner.suite = duplicate.entries[0].runner.suite
  assert.throws(() => validateManifest(duplicate), /duplicate runner/)
  const duplicateCases = manifest()
  duplicateCases.entries[0].requiredCases.push('Case.test_one')
  assert.throws(() => validateManifest(duplicateCases), /duplicate required/)
  for (const field of ['layer', 'resources', 'inputExpected', 'cleanup', 'invariants']) {
    const invalid = manifest()
    delete invalid.entries[0][field]
    assert.throws(() => validateManifest(invalid), /smoke layer|data contract|invariants/)
  }
})

test('smoke manifest requires explicit core and unit coverage', () => {
  for (const field of ['requiredCoreIds', 'requiredUnitIds']) {
    const missing = manifest()
    missing[field] = []
    assert.throws(() => validateManifest(missing), /invalid/)
  }
  const wrong = manifest()
  wrong.entries[0].markers = ['smoke-unit']
  assert.throws(() => validateManifest(wrong), /missing required smoke-core/)
  const removed = manifest()
  removed.entries.shift()
  assert.throws(() => validateManifest(removed), /missing required smoke-core/)
})

test('smoke selection follows authoritative registry without omission', () => {
  assert.deepEqual(selectionFor(manifest(), ['contract_other', 'contract_unit', 'contract_core']), {
    suites: ['contract_unit', 'contract_core'], registry: ['contract_other', 'contract_unit', 'contract_core']
  })
  assert.throws(() => selectionFor(manifest(), ['contract_core']), /not in runner registry/)
  assert.throws(() => selectionFor(manifest(), ['contract_core', 'contract_core']), /duplicate/)
})

test('smoke case observations reject missing duplicate skipped retried and truncated evidence', () => {
  assert.deepEqual(validateCaseReport(report(), ENTRY), [{ id: 'core:Case.test_one', status: 'passed', retries: 0 }])
  for (const mutation of [value => { value.cases = [] }, value => { value.cases.push(value.cases[0]) },
    value => { value.cases[0].status = 'skipped' }, value => { value.cases[0].retries = 1 },
    value => { delete value.exitStatus }, value => { value.exitStatus = 1 }]) {
    const invalid = report()
    mutation(invalid)
    assert.throws(() => validateCaseReport(invalid, ENTRY))
  }
})

test('smoke observations reject cleanup errors and incorrect collection', () => {
  const collection = { schemaVersion: 1, kind: 'collection', suite: ENTRY.runner.suite,
    planned: ['Case.test_one', 'Case.test_added'], errors: [], exitStatus: 0 }
  const discovered = { ...ENTRY, expectedCases: validateCollection(collection, ENTRY) }
  assert.deepEqual(discovered.expectedCases, collection.planned)
  assert.throws(() => validateCaseReport(collection, discovered), /invalid case observations/)
  assert.throws(() => validateCaseReport(report(), discovered), /collection mismatch/)
  const complete = { ...report(), planned: collection.planned,
    cases: collection.planned.map(id => ({ id, status: 'passed', retries: 0 })) }
  assert.equal(validateCaseReport(complete, discovered).length, 2)
  for (const mutate of [value => { value.planned = ['Case.test_added'] },
    value => { value.planned.push('Case.test_one') }, value => { value.planned = [] },
    value => { value.errors.push('import failed') }, value => { value.exitStatus = 1 },
    value => { delete value.kind }]) {
    const invalid = structuredClone(collection)
    mutate(invalid)
    assert.throws(() => validateCollection(invalid, ENTRY))
  }

  const cleanup = report()
  cleanup.errors.push('cleanup failed')
  assert.throws(() => validateCaseReport(cleanup, ENTRY), /invalid case observations/)
  const wrong = report()
  wrong.planned = ['Case.test_other']
  assert.throws(() => validateCaseReport(wrong, ENTRY), /collection mismatch/)
  const duplicate = report()
  duplicate.planned.push('Case.test_one')
  assert.throws(() => validateCaseReport(duplicate, ENTRY), /duplicate/)
})

test('smoke Node observations match declared titles and reject skips', () => {
  const entry = { id: 'projection', expectedCases: ['projection rule'] }
  const observed = { observations: { available: true, frameworkSuccess: true,
    records: [{ kind: 'test', titlePath: ['projection rule'], status: 'passed', occurrence: 1 }] } }
  assert.deepEqual(validateNodeReport(observed, entry), [{ id: 'projection:projection rule', status: 'passed', retries: 0 }])
  for (const mutation of [value => { value.observations.records[0].status = 'skipped' },
    value => { value.observations.records[0].occurrence = 2 },
    value => { value.observations.records[0].titlePath = ['unexpected'] },
    value => { value.observations.frameworkSuccess = false },
    value => { value.observations.records = [] }]) {
    const invalid = structuredClone(observed)
    mutation(invalid)
    assert.throws(() => validateNodeReport(invalid, entry))
  }
})

test('smoke verdict accepts stable dirty source and rejects changed evidence', () => {
  const snapshot = { schemaVersion: 1, valid: true, commit: 'a'.repeat(40), head: 'refs/heads/test',
    indexFingerprint: 'b'.repeat(64), fingerprint: 'c'.repeat(64), clean: true, files: 1 }
  const run = { platform: 'darwin', commit: 'a'.repeat(40), profile: 'smoke', sourceClean: true,
    sourceUnchanged: true, sourceAtStart: snapshot, sourceAtEnd: snapshot,
    reportsIntact: true, expected: ['case'], plannedStages: ['stage'],
    stages: [{ id: 'stage', platform: 'darwin', commit: 'a'.repeat(40), exitCode: 0,
      timedOut: false, report: '/evidence/report.json', cases: [{ id: 'case', status: 'passed', retries: 0 }] }] }
  assert.equal(smokeVerdict(run).verdict, 'pass')
  const dirty = { ...run, sourceClean: false, sourceAtStart: { ...snapshot, clean: false }, sourceAtEnd: { ...snapshot, clean: false } }
  assert.equal(smokeVerdict(dirty).verdict, 'pass')
  assert.equal(dirty.sourceClean, false)
  assert.equal(smokeVerdict({ ...dirty, sourceUnchanged: false }).verdict, 'fail')
  assert.equal(smokeVerdict({ ...dirty, sourceAtEnd: { ...dirty.sourceAtEnd, fingerprint: 'd'.repeat(64) } }).verdict, 'fail')
  assert.equal(smokeVerdict({ ...dirty, sourceAtEnd: undefined }).verdict, 'fail')
  assert.equal(smokeVerdict({ ...dirty, sourceClean: true }).verdict, 'fail')
  assert.equal(smokeVerdict({ ...dirty, profile: 'full' }).verdict, 'fail')
  assert.equal(require('../verdict.cjs').judgeRun({ ...dirty, profile: 'offline' }).verdict, 'fail')
  const failed = structuredClone(dirty)
  failed.stages[0].exitCode = 7
  assert.equal(smokeVerdict(failed).verdict, 'fail')
  const skipped = structuredClone(run)
  skipped.stages[0].cases[0].status = 'skipped'
  assert.equal(smokeVerdict(skipped).verdict, 'fail')
  assert.throws(() => validateQualityResult({ ...run, schemaVersion: 1, verdict: 'pass', failures: [] },
    'darwin', 'a'.repeat(40)), /did not pass/)
})

test('smoke report paths stay separate from full CI', () => {
  const destination = resultPath(path.resolve('/workspace'))
  const quality = { verdict: 'fail', failures: [{ reason: 'case_not_passed' }],
    expected: ['pass', 'fail', 'skip', 'missing'], stages: [{ cases: [
      { id: 'pass', status: 'passed' }, { id: 'fail', status: 'failed' }, { id: 'skip', status: 'skipped' }
    ] }] }
  const formatted = formatSmokeSummary(quality, { destination, exitCode: 1, durationMs: 1234 })
  assert.match(formatted, /失败 \(FAIL\)/)
  assert.match(formatted, /通过 1.*失败 1.*跳过 1/)
  assert.match(formatted, /缺失 1/)
  assert.match(formatted, /1\.234s/)
  assert.ok(formatted.includes(destination))
  assert.match(formatSmokeSummary(null, { destination, exitCode: 1, durationMs: 0 }), /数量未知/)
  const observations = structuredClone(quality)
  observations.stages[0].displayCases = observations.stages[0].cases
  observations.stages[0].cases = []
  assert.match(formatSmokeSummary(observations, { destination, exitCode: 1, durationMs: 0 }), /通过 1.*失败 1.*跳过 1/)
  const { resolveCommand } = require('../../shared/commands.cjs')
  assert.equal(workspace.scripts.ops, 'node scripts/ops-cli.cjs')
  assert.equal(Object.hasOwn(workspace.scripts, 'ci:smoke'), false)
  assert.deepEqual(resolveCommand(['ci']).steps, [{ kind: 'node', file: 'scripts/ci/smoke.cjs', args: [] }])
  assert.deepEqual(resolveCommand(['ci', 'test', 'smoke']).steps, resolveCommand(['ci']).steps)
  assert.equal(workspace.scripts['ci:test:quick'], undefined)
  const root = path.resolve('/workspace')
  assert.equal(resultPath(root), path.join(root, 'tmp', 'ci-smoke', 'quality.json'))
  assert.notEqual(resultPath(root), path.join(root, 'tmp', 'ci-test', 'quality.json'))
  assert.notEqual(resultPath(root), path.join(root, 'tmp', 'ci-test-quick', 'quality.json'))
  function lifecycle(failures = {}) {
    let summary = { profile: 'smoke', verdict: 'pass', failures: [] }
    let released = false
    const operations = []
    const logs = []
    const output = []
    const filesystem = Object.fromEntries(['mkdirSync', 'openSync', 'writeFileSync', 'closeSync', 'unlinkSync', 'readFileSync']
      .map(operation => [operation, () => {
        operations.push(operation)
        if (failures[operation]) throw new Error(failures[operation])
        if (operation === 'unlinkSync') released = true
        return operation === 'readFileSync' ? JSON.stringify(summary) : 1
      }]))
    const options = { filesystem, destination: resultPath(root), log: message => { logs.push(message) },
      output: message => { output.push(message) },
      writeJSON: (destination, value) => {
        assert.equal(released, false, 'summary must never publish after the lock is released')
        assert.equal(destination, resultPath(root))
        summary = value
      },
      execute: () => { if (failures.execute) throw new Error(failures.execute); summary = {
        verdict: 'pass', failures: [], expected: ['case'], stages: [{ cases: [{ id: 'case', status: 'passed' }] }]
      }; return 0 } }
    return { options, operations, logs, output, summary: () => summary }
  }
  const success = lifecycle()
  assert.equal(main([], success.options), 0)
  assert.equal(success.operations.at(-1), 'unlinkSync')
  assert.ok(success.operations.lastIndexOf('readFileSync') < success.operations.indexOf('unlinkSync'))
  assert.match(success.logs.at(-1), /通过 \(PASS\)/)
  assert.match(success.logs.at(-1), /通过 1.*失败 0.*跳过 0/)
  assert.equal(JSON.parse(success.output.at(-1)).exitCode, 0)
  const startup = lifecycle({ execute: 'startup failure' })
  assert.throws(() => main([], startup.options), /startup failure/)
  assert.equal(startup.summary().verdict, 'fail')
  assert.equal(startup.summary().status, 'runner_error')
  assert.match(startup.logs.at(-1), /失败 \(FAIL\)/)
  const partial = lifecycle({ writeFileSync: 'partial initialization' })
  assert.throws(() => main([], partial.options), /partial initialization/)
  assert.ok(partial.operations.includes('unlinkSync'))
  const locked = lifecycle({ openSync: 'already locked' })
  assert.throws(() => main([], locked.options), /locked by another run/)
  assert.equal(locked.summary().verdict, 'pass')
  assert.ok(!locked.operations.includes('unlinkSync'))
  assert.ok(!locked.operations.includes('readFileSync'), 'never read another run summary')
  assert.match(locked.logs.at(-1), /失败 \(FAIL\)/)
  assert.match(locked.logs.at(-1), /数量未知/)
  const cleanup = lifecycle({ execute: 'original error', closeSync: 'close failure', unlinkSync: 'unlink failure' })
  assert.throws(() => main([], cleanup.options), /runner or cleanup failed/)
  assert.equal(cleanup.summary().verdict, 'fail')
  assert.equal(cleanup.summary().failures[0].reason, 'original error')
  assert.deepEqual(cleanup.summary().cleanupErrors, ['close failure', 'unlink failure'])
  const cleanupAfterPass = lifecycle({ unlinkSync: 'unlink failure' })
  assert.throws(() => main([], cleanupAfterPass.options), /runner or cleanup failed/)
  assert.equal(cleanupAfterPass.summary().verdict, 'fail')
  assert.match(cleanupAfterPass.logs.at(-1), /失败 \(FAIL\)/)
  assert.ok(!cleanupAfterPass.logs.some(message => message.includes('通过 (PASS)')))
  assert.equal(JSON.parse(cleanupAfterPass.output.at(-1)).exitCode, 1)
  const closeAfterPass = lifecycle({ closeSync: 'close failure' })
  assert.throws(() => main([], closeAfterPass.options), /runner or cleanup failed/)
  assert.equal(closeAfterPass.summary().verdict, 'fail')
  assert.ok(closeAfterPass.operations.includes('unlinkSync'))
})


test('smoke concurrency changes capacity without changing selection or gates', () => {
  const { smokeJobs } = require('../smoke.cjs')
  for (const jobs of [1, 4, 8, 12]) {
    assert.equal(smokeJobs({ CI_SMOKE_JOBS: String(jobs) }), jobs)
  }
  for (const raw of ['', '0', '-1', '13', '4.5', '4junk']) {
    assert.throws(() => smokeJobs({ CI_SMOKE_JOBS: raw }), /CI_SMOKE_JOBS/)
  }
})


test('smoke summary explains report rejection even when observed cases passed', () => {
  const quality = { verdict: 'fail', failures: [{ reason: 'missing_result' }],
    stages: [{ id: 'python-run-all', observationError: 'smoke collection mismatch: runner-lifecycle',
      displayCases: [{ id: 'case', status: 'passed' }], cases: [] }] }
  const output = formatSmokeSummary(quality, { destination: 'quality.json', exitCode: 1, durationMs: 1 })
  assert.match(output, /通过 1.*失败 0/)
  assert.match(output, /python-run-all observationError: smoke collection mismatch: runner-lifecycle/)
})
