const assert = require('node:assert/strict')
const test = require('node:test')
const { judgeRun } = require('../verdict.cjs')
const QUARANTINE = require('../quarantine.json')

const COMMIT = 'a'.repeat(40)

test('intrinsic Node skips require exact platform, reason and quarantine scope', () => {
  for (const policy of QUARANTINE.nodeSkips) {
    const item = { id: `${policy.stage}:skip:${policy.title}`, title: policy.title,
      status: 'skipped', reason: policy.reason, retries: 0, omissionMethod: 'node-declared-skip' }
    const stage = { id: policy.stage, platform: policy.platform, commit: COMMIT,
      exitCode: 0, timedOut: false, report: 'raw/node.json', cases: [item] }
    const candidate = run({ profile: 'offline', quarantine: true, platform: policy.platform,
      expected: [item.id], stages: [stage] })
    assert.equal(judgeRun(candidate).verdict, 'pass')
    assert.equal(judgeRun({ ...candidate, stages: [{ ...stage, cases: [{ ...item, reason: 'unknown' }] }] }).verdict, 'fail')
    assert.equal(judgeRun({ ...candidate, platform: 'win32' }).verdict, 'fail')
    assert.equal(judgeRun({ ...candidate, quarantine: false }).verdict, policy.quarantine ? 'fail' : 'pass')
    assert.equal(judgeRun({ ...candidate, profile: 'full' }).verdict, policy.quarantine ? 'fail' : 'pass')
  }
})

test('pytest quarantine is exact and cannot pass strict or full verdicts', () => {
  const policy = QUARANTINE.pytest[0]
  const item = { id: `${policy.stage}:${policy.id}`, status: 'skipped', reason: policy.reason, retries: 0 }
  const stage = { id: policy.stage, platform: 'darwin', commit: COMMIT,
    exitCode: 0, timedOut: false, report: 'raw/pytest.json', cases: [item] }
  const candidate = run({ profile: 'offline', quarantine: true, expected: [item.id], stages: [stage] })
  assert.equal(judgeRun(candidate).verdict, 'pass')
  assert.equal(judgeRun({ ...candidate, quarantine: false }).verdict, 'fail')
  assert.equal(judgeRun({ ...candidate, profile: 'full' }).verdict, 'fail')
  assert.equal(judgeRun({ ...candidate, stages: [{ ...stage, cases: [{ ...item, reason: 'other' }] }] }).verdict, 'fail')
})

test('Node scheduler omissions require explicit quarantine and exact reviewed identity', () => {
  const caseResult = { id: 'desktop-unit:quarantine:src/renderer/src/store.test.ts:selectors return the home fallback and null scopes instead of undefined',
    status: 'skipped', reason: 'merged_store_selector_source_contract', retries: 0,
    file: 'src/renderer/src/store.test.ts', title: 'selectors return the home fallback and null scopes instead of undefined',
    omissionMethod: 'node-test-skip-pattern' }
  const stage = { id: 'desktop-unit', platform: 'darwin', commit: COMMIT,
    exitCode: 0, timedOut: false, report: 'raw/node.json', cases: [caseResult] }
  const candidate = run({ profile: 'offline', quarantine: true,
    expected: [caseResult.id], stages: [stage] })
  assert.equal(judgeRun(candidate).verdict, 'pass')
  assert.equal(judgeRun({ ...candidate, quarantine: false }).verdict, 'fail')
  assert.equal(judgeRun({ ...candidate, stages: [{ ...stage,
    cases: [{ ...caseResult, title: 'unlisted case' }] }] }).verdict, 'fail')
})

test('Node quarantine cannot be moved into a different stage', () => {
  const policy = QUARANTINE.nodeCases.find(item => item.stage === 'desktop-i18n-test')
  const item = { id: `${policy.stage}:quarantine:${policy.file}:${policy.title}`,
    status: 'skipped', reason: policy.reason, retries: 0, file: policy.file,
    title: policy.title, omissionMethod: 'node-test-skip-pattern' }
  const stage = { id: policy.stage, platform: 'darwin', commit: COMMIT,
    exitCode: 0, timedOut: false, report: 'raw/node.json', cases: [item] }
  const candidate = run({ profile: 'offline', quarantine: true, expected: [item.id], stages: [stage] })
  assert.equal(judgeRun(candidate).verdict, 'pass')
  assert.equal(judgeRun({ ...candidate, stages: [{ ...stage, id: 'desktop-unit' }] }).verdict, 'fail')
  assert.equal(judgeRun({ ...candidate, quarantine: false }).verdict, 'fail')
})

test('quarantine accepts only exact declared cases and never allows full or strict runs', () => {
  const caseResult = { id: 'python-run-all:contract_web_import', status: 'skipped',
    reason: 'known_web_import_causal_snapshot_gap', retries: 0 }
  const stage = { id: 'python-run-all', platform: 'darwin', commit: COMMIT,
    exitCode: 0, timedOut: false, report: 'raw/python.json', cases: [caseResult] }
  const candidate = run({ profile: 'offline', quarantine: true,
    expected: [caseResult.id], stages: [stage] })
  assert.equal(judgeRun(candidate).verdict, 'pass')
  assert.equal(judgeRun({ ...candidate, quarantine: false }).verdict, 'fail')
  assert.equal(judgeRun({ ...candidate, profile: 'full' }).verdict, 'fail')
  assert.equal(judgeRun({ ...candidate, stages: [{ ...stage, exitCode: 1 }] }).verdict, 'fail')
  assert.equal(judgeRun({ ...candidate, stages: [{ ...stage,
    cases: [{ ...caseResult, reason: 'arbitrary_skip' }] }] }).verdict, 'fail')
})

function run(overrides = {}) {
  return {
    platform: 'darwin',
    commit: COMMIT,
    sourceClean: true,
    reportsIntact: true,
    expected: ['desktop:smoke:startup'],
    stages: [{
      id: 'desktop-e2e',
      platform: 'darwin',
      commit: COMMIT,
      exitCode: 0,
      timedOut: false,
      report: 'raw/playwright.json',
      cases: [{ id: 'desktop:smoke:startup', status: 'passed', retries: 0 }]
    }],
    ...overrides
  }
}

test('passes only a complete and matching structured result', () => {
  assert.deepEqual(judgeRun(run()), { verdict: 'pass', failures: [] })
})

test('rejects a checkout changed during test execution', () => {
  for (const sourceClean of [false, null, undefined]) {
    const result = judgeRun(run({ sourceClean }))
    assert.equal(result.verdict, 'fail')
    assert.ok(result.failures.some(item => item.reason === 'dirty_source'))
  }
})

test('rejects a missing, malformed, or empty raw report', () => {
  for (const report of [null, '', {}]) {
    const result = judgeRun(run({ stages: [{ ...run().stages[0], report }] }))
    assert.equal(result.verdict, 'fail')
    assert.ok(result.failures.some(item => item.reason === 'missing_report'))
  }
  assert.equal(judgeRun(run({ stages: [{ ...run().stages[0], cases: [] }] })).verdict, 'fail')
})

test('rejects report evidence missing or changed before the final verdict', () => {
  for (const reportsIntact of [false, null, undefined]) {
    const result = judgeRun(run({ reportsIntact }))
    assert.equal(result.verdict, 'fail')
    assert.ok(result.failures.some(item => item.reason === 'report_evidence_changed'))
  }
})

test('rejects unexpected skips and retry-to-pass cases', () => {
  for (const caseResult of [
    { id: 'desktop:smoke:startup', status: 'skipped', retries: 0 },
    { id: 'desktop:smoke:startup', status: 'passed', retries: 1 }
  ]) {
    assert.equal(judgeRun(run({ stages: [{ ...run().stages[0], cases: [caseResult] }] })).verdict, 'fail')
  }
})

test('offline verdict accepts only declared external prerequisite skips with raw evidence', () => {
  const skipped = {
    id: 'python-acceptance-all', platform: 'darwin', commit: COMMIT,
    status: 'skipped', reason: 'real_model_config', exitCode: null, timedOut: false,
    report: 'raw/python-acceptance-all.json',
    cases: [{ id: 'python-acceptance-all', status: 'skipped', reason: 'real_model_config', retries: 0 }]
  }
  const input = run({ profile: 'offline', expected: ['desktop:smoke:startup', skipped.id],
    stages: [...run().stages, skipped] })
  assert.equal(judgeRun(input).verdict, 'pass')
  for (const changed of [
    { profile: 'full' },
    { stages: [...run().stages, { ...skipped, reason: 'arbitrary' }] },
    { stages: [...run().stages, { ...skipped, report: null }] },
    { stages: [...run().stages, { ...skipped, cases: [] }] }
  ]) {
    assert.equal(judgeRun({ ...input, ...changed }).verdict, 'fail')
  }
})

test('offline verdict accepts only listed real-model Playwright cases', () => {
  const skipped = {
    id: 'smoke:deepseek-case', status: 'skipped', reason: 'real_model_config', retries: 0,
    project: 'smoke', file: 'startup.spec.ts',
    title: 'DeepSeek flash reasoning declarations save and survive catalog reload'
  }
  const base = run({ profile: 'offline', expected: [skipped.id], stages: [{
    ...run().stages[0], cases: [skipped]
  }] })
  assert.equal(judgeRun(base).verdict, 'pass')
  for (const changed of [
    { profile: 'full' },
    { stages: [{ ...base.stages[0], cases: [{ ...skipped, title: 'unlisted case' }] }] },
    { stages: [{ ...base.stages[0], cases: [{ ...skipped, reason: 'arbitrary' }] }] }
  ]) {
    assert.equal(judgeRun({ ...base, ...changed }).verdict, 'fail')
  }
})

test('rejects missing and duplicate expected cases', () => {
  assert.equal(judgeRun(run({ expected: ['desktop:smoke:startup', 'desktop:smoke:other'] })).verdict, 'fail')
  assert.equal(judgeRun(run({ stages: [{ ...run().stages[0], cases: [
    ...run().stages[0].cases, ...run().stages[0].cases
  ] }] })).verdict, 'fail')
})

test('rejects a missing or duplicate planned stage even when dynamic cases pass', () => {
  assert.equal(judgeRun(run({ plannedStages: ['desktop-e2e', 'python-acceptance-all'] })).verdict,
    'fail')
  assert.equal(judgeRun(run({ plannedStages: ['desktop-e2e', 'desktop-e2e'] })).verdict,
    'fail')
  assert.equal(judgeRun(run({ plannedStages: ['desktop-e2e'] })).verdict, 'pass')
})

test('rejects command failures, timeouts, and wrong platform or commit', () => {
  for (const stage of [
    { exitCode: 1 }, { timedOut: true }, { platform: 'win32' }, { commit: 'b'.repeat(40) }
  ]) {
    assert.equal(judgeRun(run({ stages: [{ ...run().stages[0], ...stage }] })).verdict, 'fail')
  }
})
