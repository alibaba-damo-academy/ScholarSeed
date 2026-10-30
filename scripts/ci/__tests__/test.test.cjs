const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const QUARANTINE = require('../quarantine.json')
const DESKTOP_PACKAGE = require('../../../apps/desktop/package.json')
const { TEST_FILES, TEST_GLOBS, testFiles } = require('../../../apps/desktop/scripts/ci/test.cjs')
const { npmCommand, packageManagerCommand } = require('../../pre/toolchain.cjs')
const { judgeRun } = require('../verdict.cjs')
const { gitSource, expandTestGlob, planStages, stageBlockReason, summarizePlaywright, summarizeRunAll,
  summarizeAcceptance, summarizePytest, summarizeNodeTests, validateSkillHub, runStage, stageLaunch,
  planQuotas, scheduleStages, formatStageProgress, qualityResultPath,
  reviewedCodex, sourceStayedClean, reportsIntact, recordSkippedStage, recordBlockedStage,
  nodeOmissionPattern, validateNodeOmissions, validatePlaywrightOmissions, skipEvidence } = require('../test.cjs')

function globFixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-glob-'))
  context.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    assert.equal(fs.existsSync(directory), false)
  })
  for (const filename of [
    'root.test.ts', 'src/state.test.ts', 'src/deep/logic.test.ts',
    'preview/preview.test.ts', 'preview/nested/ignored.test.ts',
    'e2e/fixtures/native.test.ts', 'e2e/fixtures/nested/ignored.test.ts',
    'tmp/duplicate.test.ts', 'node_modules/ignored.test.ts', 'src/node_modules/ignored.test.ts'
  ]) {
    const target = path.join(directory, filename)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target,
      `const { test } = require('node:test'); test(${JSON.stringify(filename)}, () => {});\n`)
  }
  return directory
}

test('coverage globs preserve shallow roots and explicitly declared recursive scopes', (context) => {
  const directory = globFixture(context)
  assert.deepEqual(expandTestGlob('*.test.ts', directory), ['root.test.ts'])
  assert.deepEqual(expandTestGlob('src/**/*.test.ts', directory),
    ['src/deep/logic.test.ts', 'src/state.test.ts'])
  assert.deepEqual(expandTestGlob('preview/*.test.ts', directory), ['preview/preview.test.ts'])
  assert.deepEqual(expandTestGlob('e2e/fixtures/*.test.ts', directory), ['e2e/fixtures/native.test.ts'])
  assert.throws(() => expandTestGlob('**/*.test.ts', directory), /unsupported test glob/)
  assert.throws(() => expandTestGlob('__proto__', directory), /unsupported test glob/)
})

test('coverage glob expansion matches the actual Node runner without collecting temporary copies', (context) => {
  const directory = globFixture(context)
  const patterns = Object.keys(TEST_GLOBS)
  const expected = ['e2e/fixtures/native.test.ts', 'preview/preview.test.ts', 'root.test.ts',
    'src/deep/logic.test.ts', 'src/state.test.ts']
  const expanded = [...new Set(patterns.flatMap(pattern => expandTestGlob(pattern, directory)))].sort()
  assert.deepEqual(expanded, expected)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath,
    ['--experimental-transform-types', '--test', '--test-reporter=tap', ...patterns],
    { cwd: directory, env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const executed = [...result.stdout.matchAll(/^ok \d+ - (.+)$/gm)].map(match => match[1]).sort()
  assert.deepEqual(executed, expected)
})

test('default coverage plans retain preview and fixture contracts but exclude temporary copies', () => {
  const expected = ['*.test.ts', 'src/**/*.test.ts', 'preview/*.test.ts', 'e2e/fixtures/*.test.ts']
  assert.deepEqual(Object.keys(TEST_GLOBS), expected)
  assert.equal(DESKTOP_PACKAGE.scripts.test, 'node scripts/ci/test.cjs')
  assert.equal(DESKTOP_PACKAGE.scripts['test:coverage'], 'node scripts/ci/test.cjs --coverage')
  for (const platform of ['darwin', 'win32']) {
    const stage = planStages(platform, {}, { profile: 'offline', quarantine: true })
      .find(item => item.id === 'desktop-unit')
    assert.ok(stage.args.includes('preview/browser.test.ts'))
    assert.ok(stage.args.includes('e2e/fixtures/runtime.test.ts'))
    assert.equal(stage.args.some(argument => argument.startsWith('tmp/')), false)
  }
})

test('every platform CI coverage plan consumes the complete Desktop-owned test manifest', () => {
  const expected = testFiles()
  for (const platform of ['darwin', 'win32']) {
    for (const quarantine of [false, true]) {
      const stage = planStages(platform, {}, { profile: 'offline', quarantine, quota: 3 })
        .find(item => item.id === 'desktop-unit')
      const files = stage.args.slice(4).filter(argument => !argument.startsWith('--'))
      assert.deepEqual(files, expected)
      assert.equal(stage.ignoreLifecycle, true)
    }
  }
})

test('public projection retains its original collection and adds the tooling consumer regression', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const profile of ['full', 'offline']) {
      const stage = planStages(platform, {}, { profile }).find(item => item.id === 'python-public-projection')
      assert.equal(stage.reportKind, 'pytest')
      assert.deepEqual(stage.args.slice(-2), [
        'scripts/cd/public/__tests__/test_sync.py',
        'scripts/cd/public/__tests__/test_tooling.py'
      ])
    }
  }
})

test('every quarantined Playwright file registers the shared beforeEach hook', () => {
  validatePlaywrightOmissions()
})

test('debug contracts run once in default tests and both platform CI coverage plans', () => {
  const filename = '../../scripts/dev/__tests__/desktop.test.cjs'
  assert.equal(TEST_FILES.filter(token => token === filename).length, 1)
  const target = path.resolve(sourceDirectory, '../dev/__tests__/desktop.test.cjs')
  for (const platform of ['darwin', 'win32']) {
    for (const quarantine of [false, true]) {
      const owners = planStages(platform, {}, { profile: 'offline', quarantine })
        .filter(stage => stage.kind === 'node' && stage.args.some(argument => path.resolve(stage.cwd, argument) === target))
      assert.deepEqual(owners.map(stage => stage.id), ['desktop-unit'])
    }
  }
})

test('E2E fixture contracts have one covered execution and one quarantine owner', () => {
  const files = ['e2e/fixtures/installer.test.ts', 'e2e/fixtures/runtime.test.ts']
  const title = 'a mountable empty DMG fails during installed-app selection'
  for (const platform of ['darwin', 'win32']) {
    const stages = planStages(platform, {}, { profile: 'offline', quarantine: true })
    for (const file of files) {
      const target = path.resolve(sourceDirectory, '../../apps/desktop', file)
      const owners = stages.filter(stage => stage.kind === 'node' &&
        stage.args.some(argument => path.resolve(stage.cwd, argument) === target))
      assert.deepEqual(owners.map(stage => stage.id), ['desktop-unit'])
      assert.ok(owners[0].args[0].endsWith(path.join('c8', 'bin', 'c8.js')))
    }
    assert.equal(new RegExp(nodeOmissionPattern('desktop-unit')).test(title), true)
    assert.equal(new RegExp(nodeOmissionPattern('desktop-extra-node')).test(title), false)
  }
  assert.deepEqual(QUARANTINE.nodeCases.filter(item => item.file === files[0] && item.title === title)
    .map(item => item.stage || 'desktop-unit'), ['desktop-unit'])
})

test('platform skip classification follows the canonical fixture stage only', () => {
  const output = [
    '﹣ a mountable empty DMG fails during installed-app selection (0.1ms) # SKIP',
    'ℹ tests 1', 'ℹ pass 0', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0'
  ].join('\n')
  assert.equal(summarizeNodeTests(output, 'desktop-unit', 'win32', 'x64')[0].status, 'passed')
  assert.equal(summarizeNodeTests(output, 'desktop-extra-node', 'win32', 'x64')[0].status, 'failed')
  assert.equal(summarizeNodeTests(output, 'desktop-unit', 'darwin', 'arm64')[0].status, 'failed')
  assert.equal(summarizeNodeTests(output.replace('mountable empty DMG', 'different native fixture'),
    'desktop-unit', 'win32', 'x64')[0].status, 'failed')
})

test('quarantine hooks require their runtime policy import', () => {
  const hook = 'test.beforeEach(({}, testInfo) => { skipQuarantined(testInfo) })'
  for (const declaration of ['',
    "import type { skipQuarantined } from './fixtures/quarantine'",
    "import { other as skipQuarantined } from './fixtures/quarantine'",
    "import { skipQuarantined } from './fixtures/other'"]) {
    assert.throws(() => validatePlaywrightOmissions(() => `${declaration}\n${hook}`), /lacks policy import/)
  }
  validatePlaywrightOmissions(() => `import { skipQuarantined } from './fixtures/quarantine'\n${hook}`)
})

test('every skip evidence carries its reason and a recovery condition', () => {
  const entries = skipEvidence([{ id: 'example', cases: [
    { id: 'model', status: 'skipped', reason: 'real_model_config' },
    { id: 'debt', status: 'skipped', reason: 'known_debt' },
    { id: 'specific', status: 'skipped', reason: 'specific', restoreCondition: 'original gate passes' },
    { id: 'passed', status: 'passed' }
  ] }])
  assert.equal(entries.length, 3)
  assert.ok(entries.every(item => item.stage === 'example' && item.reason && item.restoreCondition))
  assert.match(entries[0].restoreCondition, /模型/)
  assert.equal(entries[2].restoreCondition, 'original gate passes')
})

test('intrinsic Node skips preserve exact platform or dependency evidence', () => {
  for (const policy of QUARANTINE.nodeSkips) {
    const output = `﹣ ${policy.title} (1ms) # ${policy.reason}\nℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n`
    const cases = summarizeNodeTests(output, policy.stage, policy.platform, 'arm64', true)
    assert.equal(cases[0].status, 'passed')
    assert.equal(cases[1].title, policy.title)
    assert.equal(cases[1].reason, policy.reason)
    assert.equal(cases[1].restoreCondition, policy.restoreCondition)
    if (policy.quarantine) assert.equal(summarizeNodeTests(output, policy.stage, policy.platform, 'arm64')[0].status, 'failed')
    assert.equal(summarizeNodeTests(output.replace(`# ${policy.reason}`, '# unlisted reason'), policy.stage, policy.platform, 'arm64', true)[0].status, 'failed')
  }
})

test('pytest quarantine keeps exact collected identity and recovery evidence', () => {
  const policy = QUARANTINE.pytest[0]
  const payload = { schemaVersion: 1, exitStatus: 0, planned: [policy.id],
    cases: [{ id: policy.id, status: 'skipped', retries: 0,
      skipReason: `Skipped: ${policy.reason}` }] }
  const result = summarizePytest(payload, policy.stage, 0, 'darwin', true)[0]
  assert.equal(result.reason, policy.reason)
  assert.equal(result.restoreCondition, policy.restoreCondition)
  assert.equal(summarizePytest(payload, policy.stage, 0, 'darwin', false)[0].reason, undefined)
  const altered = { ...payload, cases: [{ ...payload.cases[0], skipReason: 'Skipped: other' }] }
  assert.equal(summarizePytest(altered, policy.stage, 0, 'darwin', true)[0].reason, undefined)
})

test('Node quarantine stays scoped to the declared stage', () => {
  const title = 'main startup tolerates damaged preferences but reconciliation cannot acknowledge them'
  const stage = planStages('darwin', {}, { profile: 'offline', quarantine: true })
    .find(item => item.id === 'desktop-i18n-test')
  assert.equal(stage.kind, 'node')
  assert.equal(stage.cwd.endsWith('apps/desktop'), true)
  assert.ok(new RegExp(nodeOmissionPattern(stage.id)).test(title))
  assert.ok(!new RegExp(nodeOmissionPattern()).test(title))
  assert.ok(stage.args.includes(`--test-skip-pattern=${nodeOmissionPattern(stage.id)}`))
})

test('Node quarantine validates real declarations and uses exact anchored titles only', () => {
  validateNodeOmissions()
  const pattern = new RegExp(nodeOmissionPattern())
  for (const item of QUARANTINE.nodeCases.filter(item => !item.stage || item.stage === 'desktop-unit')) {
    assert.equal(pattern.test(item.title), true)
    assert.equal(pattern.test(`${item.title} extra`), false)
  }
  assert.equal(pattern.test('unlisted case'), false)
  const unit = planStages('darwin', {}, { profile: 'offline', quarantine: true })
    .find(stage => stage.id === 'desktop-unit')
  assert.equal(unit.kind, 'node')
  assert.ok(unit.args.indexOf(`--test-skip-pattern=${nodeOmissionPattern()}`) < unit.args.indexOf('scripts/cd/__tests__/build.test.cjs'))
  const strict = planStages('darwin', {}, { profile: 'offline', quarantine: false })
  assert.ok(!strict.find(stage => stage.id === 'desktop-unit').args.some(arg => arg.startsWith('--test-skip-pattern=')))
})

test('Playwright quarantine matches exact identity and reason and is disabled in strict mode', () => {
  const item = QUARANTINE.playwright[0]
  const report = { suites: [{ specs: [{ file: item.file, title: item.title, id: 'blocked',
    tests: [{ projectName: item.project, status: 'skipped', expectedStatus: 'passed', results: [],
      annotations: [{ type: 'skip', description: item.reason }] }] }] }],
    stats: { expected: 0, skipped: 1, unexpected: 0, flaky: 0 }, errors: [] }
  const cases = summarizePlaywright(report, 'darwin', 'offline', false, true)
  assert.equal(cases[0].status, 'skipped')
  assert.equal(cases[0].reason, item.reason)
  assert.equal(cases[0].restoreCondition, item.restoreCondition || QUARANTINE.restoreCondition)
  assert.equal(summarizePlaywright(report, 'darwin', 'offline')[0].status, 'failed')
  assert.equal(summarizePlaywright(report, 'darwin', 'full', false, true)[0].status, 'failed')
  report.suites[0].specs[0].title = 'unlisted'
  assert.equal(summarizePlaywright(report, 'darwin', 'offline', false, true)[0].status, 'failed')
})

test('selected Python suites require an independent registry and exact planned selection', () => {
  const selection = { registry: ['first', 'second', 'third'], suites: ['second'] }
  const payload = { schemaVersion: 1, planned: ['second'], omitted: ['first', 'third'],
    results: [{ suite: 'second', exitCode: 0, timedOut: false, status: 'passed' }], verdict: 'pass' }
  assert.deepEqual(summarizeRunAll(payload, 'full', false, selection),
    [{ id: 'python-run-all:second', status: 'passed', retries: 0 }])
  for (const invalid of [
    { ...selection, suites: [] },
    { ...selection, suites: ['second', 'second'] },
    { ...selection, suites: ['unknown'] },
    { ...selection, registry: ['second', 'second'] },
    { ...selection, suites: ['first', 'second'] }
  ]) assert.throws(() => summarizeRunAll(payload, 'full', false, invalid))
  assert.throws(() => summarizeRunAll({ ...payload, omitted: ['first'] }, 'full', false, selection))
  assert.throws(() => summarizeRunAll(payload, 'full', true, selection))
  assert.throws(() => summarizeRunAll(payload, 'full', false))
})

test('complete CI plans never apply smoke selection', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const profile of ['offline', 'full']) {
      const stages = planStages(platform, {}, { profile, quarantine: profile === 'offline' })
      assert.ok(stages.every(stage => stage.selection === undefined))
      assert.ok(stages.find(stage => stage.id === 'desktop-extra-node').args.includes('scripts/ci/__tests__/smoke.test.cjs'))
      assert.ok(stages.find(stage => stage.id === 'desktop-extra-node').args.includes('scripts/cd/__tests__/distribution.test.cjs'))
      const projection = stages.filter(stage => stage.id === 'python-public-projection')
      assert.equal(projection.length, 1)
      assert.equal(projection[0].kind, 'python')
      assert.equal(projection[0].reportKind, 'pytest')
      assert.deepEqual(projection[0].args, ['-m', 'pytest', '-q', '-o',
        'python_files=test_*.py contract_*.py e2e_*.py', 'scripts/cd/public/__tests__/test_sync.py',
        'scripts/cd/public/__tests__/test_tooling.py'])
      assert.equal(projection[0].quarantine, undefined)
    }
  }
})

test('Python quarantine reports preserve omissions without masking executed failures', () => {
  const payload = { schemaVersion: 1, planned: ['healthy'],
    omitted: [...QUARANTINE.suites.map(item => item.id), 'integration_serve'],
    results: [{ suite: 'healthy', exitCode: 0, timedOut: false, status: 'passed' }], verdict: 'pass' }
  const cases = summarizeRunAll(payload, 'offline', true)
  assert.equal(cases.filter(item => item.status === 'skipped').length, QUARANTINE.suites.length)
  assert.throws(() => summarizeRunAll(payload, 'offline', false))
  assert.throws(() => summarizeRunAll({ ...payload, omitted: [...payload.omitted, 'other'] }, 'offline', true))
  const failed = { ...payload, results: [{ suite: 'healthy', exitCode: 1,
    timedOut: false, status: 'failed' }], verdict: 'fail' }
  assert.equal(summarizeRunAll(failed, 'offline', true)[0].status, 'failed')
})

test('temporary quarantine preserves runtime and i18n tests and only excludes named blockers', () => {
  for (const platform of ['darwin', 'win32']) {
    const stages = planStages(platform, {}, { profile: 'offline', quarantine: true })
    assert.equal(stages.find(stage => stage.id === 'desktop-standards').skipReason,
      'known_desktop_standards_debt')
    assert.equal(stages.find(stage => stage.id === 'desktop-i18n-check').skipReason,
      'known_i18n_scanner_and_copy_debt')
    assert.ok(stages.find(stage => stage.id === 'desktop-i18n-test'))
    assert.equal(stages.find(stage => stage.id === 'desktop-pretest').kind, 'node')
  }
  const strict = planStages('darwin', {}, { profile: 'offline', quarantine: false })
  assert.equal(strict.find(stage => stage.id === 'desktop-pretest').kind, 'npm')
  assert.ok(!strict.find(stage => stage.id === 'python-run-all').args.includes('--exclude-suite'))
  const relaxed = planStages('darwin', {}, { profile: 'offline', quarantine: true })
  const exclusions = QUARANTINE.suites.flatMap(item => ['--exclude-suite', item.id])
  assert.deepEqual(relaxed.find(stage => stage.id === 'python-run-all').args.slice(-exclusions.length), exclusions)
})

test('raw reports remain bound to the final quality verdict', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-evidence-'))
  try {
    const stage = { id: 'evidence', kind: 'node', cwd: directory,
      args: ['-e', 'process.stdout.write("evidence")'] }
    const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
    assert.equal(reportsIntact([result], directory), true)
    fs.writeFileSync(result.report, 'changed')
    assert.equal(reportsIntact([result], directory), false)
    fs.rmSync(result.report)
    assert.equal(reportsIntact([result], directory), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('blocked stage writes intact evidence without pretending cases executed or passed', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-blocked-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const commit = 'a'.repeat(40)
  const reason = { code: 'dependency_failed', stage: 'desktop-build' }
  const stage = recordBlockedStage({ id: 'desktop-e2e' }, directory, 'darwin', commit, reason)
  assert.equal(stage.status, 'blocked')
  assert.equal(stage.exitCode, null)
  assert.equal(stage.durationMs, undefined)
  assert.deepEqual(stage.cases, [])
  assert.equal(reportsIntact([stage], directory), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(stage.report, 'utf8')), {
    status: 'blocked', reason, stage: 'desktop-e2e'
  })
  const verdict = judgeRun({ platform: 'darwin', commit, sourceClean: true, reportsIntact: true,
    expected: ['never-executed'], plannedStages: ['desktop-e2e'], stages: [stage] })
  assert.equal(verdict.verdict, 'fail')
  assert.ok(verdict.failures.some(item => item.reason === 'command_failed'))
  assert.ok(!verdict.failures.some(item => item.reason === 'missing_report'))
  fs.writeFileSync(stage.report, 'changed')
  assert.equal(reportsIntact([stage], directory), false)
  fs.rmSync(stage.report)
  assert.equal(reportsIntact([stage], directory), false)
})

test('external stage skip writes an auditable raw report with the exact reason', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-skip-'))
  try {
    const stage = recordSkippedStage({ id: 'python-acceptance-all',
      skipReason: 'real_model_config' }, directory, 'darwin', 'a'.repeat(40))
    assert.equal(stage.status, 'skipped')
    assert.equal(stage.exitCode, null)
    assert.equal(stage.cases[0].status, 'skipped')
    assert.equal(stage.cases[0].reason, 'real_model_config')
    assert.equal(reportsIntact([stage], directory), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(stage.report, 'utf8')), {
      status: 'skipped', reason: 'real_model_config', stage: 'python-acceptance-all'
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CI selects an existing reviewed Codex executable instead of host PATH', () => {
  const executable = reviewedCodex((command, args, options) => {
    assert.equal(command, process.execPath)
    assert.equal(args.at(-1), 'codex')
    assert.equal(options.encoding, 'utf8')
    return { status: 0, stdout: `${process.execPath}\n`, stderr: '' }
  })
  assert.equal(executable, process.execPath)
  assert.throws(() => reviewedCodex(() => ({ status: 0, stdout: '/missing/codex', stderr: '' })),
    /reviewed Codex unavailable/)
})

test('quality source identity distinguishes committed code from local edits', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-source-'))
  const git = args => spawnSync('git', args, { cwd: directory, encoding: 'utf8' })
  try {
    assert.equal(git(['init', '-q']).status, 0)
    const file = path.join(directory, 'source.txt')
    fs.writeFileSync(file, 'committed')
    assert.equal(git(['add', 'source.txt']).status, 0)
    assert.equal(git(['-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid',
      'commit', '-qm', 'initial']).status, 0)
    const clean = gitSource(directory)
    assert.match(clean.commit, /^[a-f0-9]{40}$/)
    assert.equal(clean.clean, true)
    assert.equal(sourceStayedClean(clean, gitSource(directory)), true)
    fs.writeFileSync(file, 'changed')
    assert.deepEqual(gitSource(directory), { commit: clean.commit, clean: false })
    assert.equal(sourceStayedClean(clean, gitSource(directory)), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('quality summary uses a fixed default location and preserves explicit overrides', () => {
  const root = path.resolve('checkout')
  assert.equal(qualityResultPath([], root), path.join(root, 'tmp', 'ci-test', 'quality.json'))
  assert.equal(qualityResultPath(['--strict'], root), qualityResultPath([], root))
  assert.equal(qualityResultPath(['--result', 'custom.json'], root), path.resolve('custom.json'))
  assert.throws(() => qualityResultPath(['--result'], root), /requires a path/)
})

test('direct invocation writes a failed prerequisite report instead of losing the verdict', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-entry-'))
  try {
    const resultPath = path.join(directory, 'quality.json')
    fs.writeFileSync(resultPath, JSON.stringify({ stale: true }))
    const env = { ...process.env, SCHOLARSEED_ACTION_MODEL: '' }
    delete env.npm_execpath
    const result = spawnSync(process.execPath, [path.join(sourceDirectory, 'test.cjs'), '--result', resultPath],
      { cwd: directory, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    assert.equal(report.verdict, 'fail')
    assert.equal(report.stages[0].id, 'ci-prerequisites')
    assert.equal(report.stages[0].exitCode, 1)
    const prerequisite = JSON.parse(fs.readFileSync(report.stages[0].report, 'utf8'))
    assert.match(prerequisite.reason, process.platform === 'linux'
      ? /unsupported platform/ : /pnpm ops ci test --profile quality/)
    assert.equal(prerequisite.models, null)
    assert.equal(prerequisite.officeCorpusVersion, null)
    if (process.platform === 'linux') {
      assert.equal(report.stages.length, 1)
    } else {
      assert.deepEqual(report.stages.find(stage => stage.id === 'desktop-pretest').reason,
        { code: 'npm_invocation_missing' })
      const blocked = report.stages.filter(stage => stage.status === 'blocked')
      assert.ok(blocked.length > 0)
      assert.equal(reportsIntact(blocked, report.runDirectory), true)
      const lines = result.stderr.trim().split('\n')
      assert.ok(lines.length > 0)
      for (const line of lines) {
        assert.match(line, /^\[ci:test\] \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /)
      }
      assert.ok(lines.some(line => line.endsWith('desktop-pretest exit=blocked')))
      assert.ok(lines.some(line => line.endsWith('python-integration-serve skipped=real_model_config')))
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('native stage plan covers macOS Python and both supported Desktop platforms', () => {
  const mac = planStages('darwin')
  const windows = planStages('win32')
  assert.ok(mac.some(stage => stage.id === 'desktop-e2e'))
  assert.ok(windows.some(stage => stage.id === 'desktop-e2e'))
  assert.ok(mac.some(stage => stage.id === 'python-run-all'))
  assert.equal(mac.find(stage => stage.id === 'python-run-all').env.PYTHONPATH,
    path.resolve(sourceDirectory, '../..'))
  assert.ok(mac.some(stage => stage.id === 'python-serve-independent'))
  assert.ok(mac.some(stage => stage.id === 'python-root-independent'))
  assert.ok(mac.some(stage => stage.id === 'python-precise-independent'))
  assert.ok(mac.some(stage => stage.id === 'python-literature-independent'))
  assert.ok(mac.find(stage => stage.id === 'python-precise-independent').env.PYTHONPATH.includes(
    'precise-literature-search'))
  assert.ok(mac.find(stage => stage.id === 'python-precise-independent').env.PYTHONPATH.includes(
    'modules/search'))
  assert.ok(mac.some(stage => stage.id === 'python-skillhub'))
  assert.equal(mac.find(stage => stage.id === 'python-skillhub').dependsOn,
    'ci-skillhub-prerequisites')
  assert.ok(mac.some(stage => stage.id === 'desktop-bun'))
  assert.ok(mac.some(stage => stage.id === 'desktop-extra-node'))
  assert.equal(mac.find(stage => stage.id === 'desktop-pretest').env.SCHOLARSEED_NATIVE_MATRIX, '1')
  assert.equal(windows.find(stage => stage.id === 'desktop-pretest').env?.SCHOLARSEED_NATIVE_MATRIX,
    undefined)
  assert.ok(mac.find(stage => stage.id === 'desktop-unit').args.includes(
    'e2e/fixtures/runtime.test.ts'))
  assert.ok(!windows.some(stage => stage.id === 'python-run-all'))
  assert.throws(() => planStages('linux'), /unsupported platform/)
})

test('each native plan prepares and verifies source skills before their consumers', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const profile of ['offline', 'full']) {
      const stages = planStages(platform, process.env, { profile })
      assert.deepEqual(stages.slice(0, 2).map(stage => stage.id),
        ['skills-source-build', 'skills-source-verify'])
      assert.deepEqual(stages[0].args, ['-m', 'service.cli.prebundle', '--build'])
      assert.deepEqual(stages[1].args, ['-m', 'service.cli.prebundle', '--verify-source'])
      assert.equal(stages[1].dependsOn, 'skills-source-build')
      const build = stages.find(stage => stage.id === 'desktop-build')
      assert.equal(build.dependsOn, 'skills-source-verify')
      assert.equal(build.ignoreLifecycle, undefined)
      assert.deepEqual(build.args, ['--prefix', 'apps/desktop', 'run', 'build'])
      assert.equal(stages.find(stage => stage.id === 'desktop-e2e').ignoreLifecycle, undefined)
      assert.equal(stages.filter(stage => stage.args?.includes('--build')).length, 1)
      if (platform === 'darwin') {
        assert.equal(stages.find(stage => stage.id === 'python-run-all').dependsOn,
          'skills-source-verify')
      }
      assert.deepEqual(stageBlockReason(stages[1], null,
        [{ id: 'skills-source-build', exitCode: 1 }]),
        { code: 'dependency_failed', stage: 'skills-source-build' })
    }
  }
})

test('CI lifecycle suppression preserves build main and propagates its failure', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-build-lifecycle-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const saved = process.env.npm_execpath
  const savedUserAgent = process.env.npm_config_user_agent
  process.env.npm_execpath = npmCommand({ ...process.env, npm_execpath: 'npm' }).path
  process.env.npm_config_user_agent = 'npm/'
  context.after(() => { if (savedUserAgent === undefined) delete process.env.npm_config_user_agent; else process.env.npm_config_user_agent = savedUserAgent })
  context.after(() => { if (saved === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = saved })
  const prebuild = 'node -e "require(\'fs\').writeFileSync(\'prebuild-ran\',\'yes\')"'
  const build = 'node -e "require(\'fs\').writeFileSync(\'build-ran\',\'yes\');process.exit(Number(process.env.BUILD_EXIT||0))"'
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { prebuild, build } }))
  const stage = { id: 'fixture-build', kind: 'npm', cwd: directory,
    args: ['run', 'build'], ignoreLifecycle: true }
  assert.equal(runStage(stage, directory, 'darwin', 'a'.repeat(40)).exitCode, 0)
  assert.equal(fs.existsSync(path.join(directory, 'prebuild-ran')), false)
  assert.equal(fs.readFileSync(path.join(directory, 'build-ran'), 'utf8'), 'yes')
  assert.equal(runStage({ ...stage, env: { BUILD_EXIT: '7' } }, directory, 'darwin', 'a'.repeat(40)).exitCode, 7)
  assert.equal(runStage({ ...stage, ignoreLifecycle: false }, directory, 'darwin', 'a'.repeat(40)).exitCode, 0)
  assert.equal(fs.readFileSync(path.join(directory, 'prebuild-ran'), 'utf8'), 'yes')
})

test('package-manager stages preserve the selected native or JavaScript launcher', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-manager-'))
  const saved = process.env.npm_execpath
  const manager = packageManagerCommand()
  process.env.npm_execpath = manager.path
  context.after(() => {
    if (saved === undefined) delete process.env.npm_execpath
    else process.env.npm_execpath = saved
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const stage = { id: 'manager-version', kind: 'npm', cwd: directory, args: ['--version'] }
  const launch = stageLaunch(stage, directory)
  assert.equal(launch.command, manager.executable)
  assert.deepEqual(launch.args, [...manager.args, '--version'])
  assert.equal(runStage(stage, directory, 'darwin', 'a'.repeat(40)).exitCode, 0)
})

test('offline plan skips only external stages while retaining every Desktop E2E project', () => {
  const stages = planStages('darwin', process.env, { profile: 'offline' })
  assert.ok(stages.find(stage => stage.id === 'python-run-all').args.includes('--fast'))
  assert.equal(stages.find(stage => stage.id === 'python-integration-serve').skipReason,
    'real_model_config')
  for (const id of ['python-acceptance-all', 'python-acceptance-p09']) {
    assert.equal(stages.find(stage => stage.id === id).skipReason, 'real_model_config')
  }
  assert.equal(stages.find(stage => stage.id === 'python-skillhub').skipReason, 'skillhub_config')
  const desktop = stages.find(stage => stage.id === 'desktop-e2e')
  assert.equal(desktop.requiresLivePrerequisites, false)
  assert.equal(desktop.profile, 'offline')
  for (const project of ['smoke', 'workbench', 'update', 'live']) {
    assert.ok(desktop.args.includes(`--project=${project}`))
  }
})

test('offline Playwright report records only allowlisted model skips', () => {
  const report = {
    suites: [{ specs: [{ file: 'startup.spec.ts', title:
      'DeepSeek flash reasoning declarations save and survive catalog reload', id: 'deepseek-case',
    tests: [{ projectName: 'smoke', status: 'skipped', expectedStatus: 'passed', results: [],
      annotations: [{ type: 'skip', description: 'Requires an existing DeepSeek connection' }] }] }] }],
    stats: { expected: 0, skipped: 1, unexpected: 0, flaky: 0 }, errors: []
  }
  assert.deepEqual(summarizePlaywright(report, 'darwin', 'offline'), [{
    id: 'smoke:deepseek-case', status: 'skipped', reason: 'real_model_config', retries: 0,
    restoreCondition: '准备有效的真实模型配置与凭据，使用 --with-external 执行对应原用例并通过',
    project: 'smoke', file: 'startup.spec.ts',
    title: 'DeepSeek flash reasoning declarations save and survive catalog reload'
  }])
  assert.equal(summarizePlaywright(report, 'darwin', 'full')[0].status, 'failed')
  assert.throws(() => summarizePlaywright(report, 'darwin', 'offline', true), /missing cases/)
  assert.equal(summarizePlaywright({ ...report, suites: [{ specs: [{ ...report.suites[0].specs[0],
    title: 'unlisted case' }] }] }, 'darwin', 'offline')[0].status, 'failed')
})

test('overlapping external and quarantine cases retain exact skip evidence', () => {
  const external = require('../external-cases.json')
  const entries = new Map()
  for (const entry of external.cases) entries.set(`${entry.project}:${entry.file}:${entry.title}`,
    { ...entry, reason: 'SCHOLARSEED_REAL_HOME is not set' })
  for (const entry of QUARANTINE.playwright) entries.set(`${entry.project}:${entry.file}:${entry.title}`, entry)
  const report = {
    suites: [{ specs: [...entries].map(([identity, entry]) => ({
      file: entry.file, title: entry.title, id: identity,
      tests: [{ projectName: entry.project, status: 'skipped', expectedStatus: 'passed', results: [],
        annotations: [{ type: 'skip', description: entry.reason }] }]
    })) }],
    stats: { expected: 0, skipped: entries.size, unexpected: 0, flaky: 0 }, errors: []
  }
  const cases = summarizePlaywright(report, 'darwin', 'offline', true, true)
  assert.equal(cases.length, entries.size)
  assert.ok(cases.every(entry => entry.status === 'skipped' && entry.reason && entry.restoreCondition))
  report.suites[0].specs.pop()
  report.stats.skipped -= 1
  assert.throws(() => summarizePlaywright(report, 'darwin', 'offline', true, true), /missing cases/)
})

test('mixed literature reader allows only its separate configured-model case to skip', () => {
  const title = 'literature PDF AI requests require configured models'
  const report = {
    suites: [{ specs: [{ file: 'workbench.spec.ts', title, id: 'literature-model',
      tests: [{ projectName: 'workbench', status: 'skipped', expectedStatus: 'passed', results: [],
        annotations: [{ type: 'skip', description: 'SCHOLARSEED_REAL_HOME is not set' }] }] }] }],
    stats: { expected: 0, skipped: 1, unexpected: 0, flaky: 0 }, errors: []
  }
  assert.equal(summarizePlaywright(report, 'darwin', 'offline')[0].status, 'skipped')
  const reader = { ...report, suites: [{ specs: [{ ...report.suites[0].specs[0],
    title: 'literature PDF opens annotations from the right rail and excludes the resource-only global control' }] }] }
  assert.equal(summarizePlaywright(reader, 'darwin', 'offline')[0].status, 'failed')
  assert.equal(summarizePlaywright(report, 'darwin', 'full')[0].status, 'failed')
})

test('missing live prerequisites do not block independent deterministic stages', () => {
  const stages = planStages('darwin')
  const missingModel = new Error('missing model credentials')
  assert.deepEqual(stageBlockReason(stages[0], new Error('missing npm'), [], false),
    { code: 'npm_invocation_missing' })
  assert.equal(stageBlockReason(stages.find(stage => stage.id === 'desktop-pretest'), missingModel, []), null)
  assert.equal(stageBlockReason(stages.find(stage => stage.id === 'desktop-unit'), missingModel, []), null)
  assert.equal(stageBlockReason(stages.find(stage => stage.id === 'desktop-build'), missingModel,
    [{ id: 'skills-source-verify', exitCode: 0 }]), null)
  assert.deepEqual(stageBlockReason(stages.find(stage => stage.id === 'desktop-e2e'), missingModel,
    [{ id: 'desktop-build', exitCode: 0 }]), { code: 'prerequisite_failed' })
  assert.deepEqual(stageBlockReason(stages.find(stage => stage.id === 'desktop-e2e'), null,
    [{ id: 'desktop-build', exitCode: 1 }]), { code: 'dependency_failed', stage: 'desktop-build' })
  assert.equal(stageBlockReason(stages.find(stage => stage.id === 'desktop-e2e'), null,
    [{ id: 'desktop-build', exitCode: 0 }]), null)
  assert.equal(stageBlockReason(stages.find(stage => stage.id === 'python-run-all'), missingModel,
    [{ id: 'skills-source-verify', exitCode: 0 }]), null)
  assert.deepEqual(stageBlockReason(stages.find(stage => stage.id === 'python-acceptance-all'), missingModel, []),
    { code: 'prerequisite_failed' })
  assert.deepEqual(stageBlockReason(stages.find(stage => stage.id === 'python-skillhub'), null,
    [{ id: 'ci-skillhub-prerequisites', exitCode: 1 }]),
  { code: 'dependency_failed', stage: 'ci-skillhub-prerequisites' })
})

test('Python stage receives only its declared import environment', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-python-env-'))
  try {
    const stage = { id: 'python-env-contract', kind: 'python', cwd: directory,
      args: ['-c', 'import os; print(os.environ.get("CI_TEST_SENTINEL", "missing"))'],
      env: { CI_TEST_SENTINEL: 'configured' } }
    const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
    assert.equal(result.exitCode, 0)
    assert.equal(fs.readFileSync(path.join(directory, 'python-env-contract.stdout.log'), 'utf8').trim(),
      'configured')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Python stages expose the installed product CLI directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-python-path-'))
  try {
    const stage = { id: 'python-path-contract', kind: 'python', cwd: directory,
      args: ['-c', 'import os; print(os.environ["PATH"].split(os.pathsep)[0])'] }
    const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
    assert.equal(result.exitCode, 0)
    assert.equal(fs.readFileSync(path.join(directory, 'python-path-contract.stdout.log'), 'utf8').trim(),
      path.join(path.resolve(sourceDirectory, '../..'), '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Python full-suite report retains every suite result, including failures', () => {
  const report = { schemaVersion: 1, planned: ['contract_first', 'contract_second'], omitted: [],
    results: [
      { suite: 'contract_first', exitCode: 0, timedOut: false, status: 'passed' },
      { suite: 'contract_second', exitCode: 1, timedOut: false, status: 'failed' }
    ], verdict: 'fail' }
  assert.deepEqual(summarizeRunAll(report), [
    { id: 'python-run-all:contract_first', status: 'passed', retries: 0 },
    { id: 'python-run-all:contract_second', status: 'failed', retries: 0 }
  ])
  assert.throws(() => summarizeRunAll({ ...report, results: report.results.slice(0, 1) }), /count/)
  assert.throws(() => summarizeRunAll({ ...report, planned: ['contract_first', 'contract_first'] }), /duplicate/)
  assert.throws(() => summarizeRunAll({ ...report, verdict: 'pass' }), /verdict/)
  assert.throws(() => summarizeRunAll({ ...report, omitted: ['another_suite'] }), /omitted/)
  assert.deepEqual(summarizeRunAll({ ...report, omitted: ['integration_serve'] }, 'offline'),
    summarizeRunAll(report))
  assert.throws(() => summarizeRunAll(report, 'offline'), /omitted/)
})

test('pytest JSON report keeps passed and skipped cases distinct', () => {
  const report = { schemaVersion: 1, exitStatus: 0,
    planned: ['tests.demo::test_pass', 'tests.demo::test_skip'], cases: [
      { id: 'tests.demo::test_pass', status: 'passed', retries: 0 },
      { id: 'tests.demo::test_skip', status: 'skipped', retries: 0 }
    ] }
  assert.deepEqual(summarizePytest(report, 'python-demo', 0), [
    { id: 'python-demo:tests.demo::test_pass', status: 'passed', retries: 0 },
    { id: 'python-demo:tests.demo::test_skip', status: 'skipped', retries: 0 }
  ])
  assert.throws(() => summarizePytest({ ...report, planned: ['tests.demo::test_pass'] },
    'python-demo', 0), /unexpected pytest result/)
})

test('pytest verdict excludes only declared foreign-platform Python skips', () => {
  const file = 'tests/integration/precise/test_filesystem.py'
  const foreign = `${file}::WindowsPathTests::test_native_windows_paths_and_canonical_identity`
  const report = { schemaVersion: 1, exitStatus: 0,
    planned: [`${file}::WindowsPathTests::test_drive_unc_and_existing_prefixes`, foreign],
    cases: [
      { id: `${file}::WindowsPathTests::test_drive_unc_and_existing_prefixes`,
        status: 'passed', retries: 0 },
      { id: foreign, status: 'skipped', retries: 0,
        skipReason: 'Skipped: requires native Windows path resolution' }
    ] }
  const cases = summarizePytest(report, 'python-precise-independent', 0, 'darwin')
  assert.equal(cases.length, 1)
  assert.equal(cases[0].status, 'passed')
  assert.equal(summarizePytest(report, 'python-precise-independent', 0, 'win32').length, 2)
  assert.equal(summarizePytest({ ...report, cases: [report.cases[0],
    { ...report.cases[1], skipReason: 'unexpected environment failure' }] },
  'python-precise-independent', 0, 'darwin').at(-1).status, 'skipped')
})

test('native Windows path-budget skips match exact IDs only on macOS', () => {
  const stage = 'python-precise-independent'
  const prefix = 'tests/integration/precise/test_filesystem.py::PaperDlLibraryPathTests::'
  const nativeIds = ['test_guard_passes_incident_shaped_run_directory',
    'test_guard_fails_deep_attempt_paths_with_named_state'].map(name => prefix + name)
  const passed = { id: prefix + 'test_library_root_is_short_by_construction', status: 'passed', retries: 0 }
  const skipped = nativeIds.map(id => ({ id, status: 'skipped', retries: 0,
    skipReason: 'Skipped: requires native Windows path budget' }))
  const report = cases => ({ schemaVersion: 1, exitStatus: 0,
    planned: cases.map(item => item.id), cases })
  assert.deepEqual(summarizePytest(report([passed, ...skipped]), stage, 0, 'darwin'),
    [{ id: `${stage}:${passed.id}`, status: 'passed', retries: 0 }])
  for (const platform of ['win32', 'linux']) {
    assert.equal(summarizePytest(report([passed, ...skipped]), stage, 0, platform).length, 3)
  }
  for (const unexpected of [
    { ...skipped[0], id: skipped[0].id + '_other' },
    { ...skipped[0], skipReason: 'unexpected environment failure' },
    { ...skipped[0], retries: 1 },
    { ...skipped[0], status: 'failed' }
  ]) {
    assert.equal(summarizePytest(report([passed, unexpected]), stage, 0, 'darwin').length, 2)
  }
  assert.equal(summarizePytest(report([passed, ...skipped]), 'python-demo', 0, 'darwin').length, 3)
})

test('pytest collection errors remain visible when no case was collected', () => {
  const report = { schemaVersion: 1, exitStatus: 2, planned: [], cases: [
    { id: 'collection:tests/test_environment.py', status: 'failed', retries: 0 }
  ] }
  assert.deepEqual(summarizePytest(report, 'python-collection', 2), [
    { id: 'python-collection:collection:tests/test_environment.py', status: 'failed', retries: 0 }
  ])
})

test('pytest stage reports an unexpected skip despite process exit zero', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pytest-stage-'))
  try {
    fs.writeFileSync(path.join(directory, 'test_sample.py'),
      'import pytest\n\ndef test_pass():\n    assert True\n\n' +
      '@pytest.mark.skip(reason="unexpected")\ndef test_skip():\n    assert True\n')
    const stage = { id: 'python-sample', kind: 'python', cwd: directory,
      args: ['-m', 'pytest', '-q', 'test_sample.py'], reportKind: 'pytest' }
    const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
    assert.equal(result.exitCode, 0)
    assert.equal(result.report, path.join(directory, 'python-sample.json'))
    assert.deepEqual(result.cases.map(item => item.status), ['passed', 'skipped'])
    assert.deepEqual(JSON.parse(fs.readFileSync(result.report, 'utf8')).cases.map(item => item.status),
      ['passed', 'skipped'])
    assert.equal(JSON.parse(fs.readFileSync(result.report, 'utf8')).cases[1].skipReason,
      'Skipped: unexpected')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('pytest stage records every unittest subtest', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pytest-subtests-'))
  try {
    fs.writeFileSync(path.join(directory, 'test_sample.py'),
      'import unittest\n\nclass Sample(unittest.TestCase):\n' +
      '    def test_subtests(self):\n' +
      '        with self.subTest(value=1):\n            self.assertTrue(True)\n' +
      '        with self.subTest(value=2):\n            self.assertTrue(True)\n')
    const stage = { id: 'python-subtests', kind: 'python', cwd: directory,
      args: ['-m', 'pytest', '-q', 'test_sample.py'], reportKind: 'pytest' }
    const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
    assert.equal(result.exitCode, 0)
    assert.equal(result.cases.length, 3)
    assert.ok(result.cases.every(item => item.status === 'passed'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Node summaries reject unexpected skips despite a passing process', () => {
  const output = ['✔ passing test (1ms)', '﹣ new skipped test (1ms) # SKIP',
    'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 1', 'ℹ fail 0', 'ℹ cancelled 0',
    'ℹ skipped 1', 'ℹ todo 0'].join('\n')
  assert.deepEqual(summarizeNodeTests(output, 'desktop-unit', 'darwin', 'arm64'), [
    { id: 'desktop-unit:node-run-1', status: 'failed', retries: 0 },
    { id: 'desktop-unit:node-run-1:skip-1:new skipped test', status: 'failed', retries: 0 }
  ])
})

test('Node summaries reject a skipped macOS native-matrix case', () => {
  const output = ['﹣ Intel macOS runtime probe tolerates Rosetta bootstrap latency (1ms) # SKIP',
    'ℹ tests 1', 'ℹ suites 0', 'ℹ pass 0', 'ℹ fail 0', 'ℹ cancelled 0',
    'ℹ skipped 1', 'ℹ todo 0', '✔ another test (1ms)', 'ℹ tests 1',
    'ℹ suites 0', 'ℹ pass 1', 'ℹ fail 0', 'ℹ cancelled 0',
    'ℹ skipped 0', 'ℹ todo 0'].join('\n')
  assert.deepEqual(summarizeNodeTests(output, 'desktop-pretest', 'darwin', 'arm64'), [
    { id: 'desktop-pretest:node-run-1', status: 'failed', retries: 0 },
    { id: 'desktop-pretest:node-run-1:skip-1:Intel macOS runtime probe tolerates Rosetta bootstrap latency',
      status: 'failed', retries: 0 },
    { id: 'desktop-pretest:node-run-2', status: 'passed', retries: 0 }
  ])
  assert.equal(summarizeNodeTests(output, 'desktop-pretest', 'darwin', 'x64')[0].status, 'failed')
  assert.throws(() => summarizeNodeTests(output.replace('ℹ skipped 1', 'ℹ skipped 0'),
    'desktop-pretest', 'darwin', 'arm64'), /count mismatch/)
})

test('Node summaries exempt only declared Windows-inapplicable native cases', () => {
  const skipped = [
    ['desktop-pretest', 'Intel macOS runtime probe tolerates Rosetta bootstrap latency'],
    ['desktop-pretest', 'Generated Skill launcher refuses managed execution without a valid bridge scope'],
    ['desktop-unit', 'readHdiutilInfoPlist sees a live mount and the sweep sequence re-attaches'],
    ['desktop-unit', 'a mountable empty DMG fails during installed-app selection']
  ]
  for (const [stageId, name] of skipped) {
    const output = [`﹣ ${name} (1ms) # SKIP`, 'ℹ tests 1', 'ℹ suites 0', 'ℹ pass 0',
      'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0'].join('\n')
    assert.equal(summarizeNodeTests(output, stageId, 'win32', 'x64')[0].status, 'passed')
    assert.equal(summarizeNodeTests(output, stageId, 'darwin', 'arm64')[0].status, 'failed')
  }
})

test('Node summaries allow only the declared Windows test on macOS', () => {
  const output = ['﹣ Windows updater command parses as PowerShell before signature verification (1ms) ' +
    '# requires the Windows PowerShell parser', 'ℹ tests 1', 'ℹ suites 0', 'ℹ pass 0',
    'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0'].join('\n')
  assert.equal(summarizeNodeTests(output, 'desktop-unit', 'darwin', 'arm64')[0].status, 'passed')
  assert.equal(summarizeNodeTests(output, 'desktop-unit', 'win32', 'x64')[0].status, 'failed')
  assert.equal(summarizeNodeTests(output.replace('requires the Windows PowerShell parser',
    'unexpected environment failure'), 'desktop-unit', 'darwin', 'arm64')[0].status, 'failed')
  assert.throws(() => summarizeNodeTests('', 'desktop-unit', 'darwin', 'arm64'),
    /missing Node test summary/)
})

test('Node summaries exempt the Windows NSIS handshake case only on macOS', () => {
  const name = 'Windows handshake writer isolates prior errors and reports file failures'
  const output = [`﹣ ${name} (1ms) # Requires Windows and NSISDIR pointing to the packaging NSIS toolchain`,
    'ℹ tests 1', 'ℹ suites 0', 'ℹ pass 0', 'ℹ fail 0', 'ℹ cancelled 0',
    'ℹ skipped 1', 'ℹ todo 0'].join('\n')
  assert.equal(summarizeNodeTests(output, 'desktop-unit', 'darwin', 'arm64')[0].status, 'passed')
  assert.equal(summarizeNodeTests(output, 'desktop-unit', 'win32', 'x64')[0].status, 'failed')
  assert.equal(summarizeNodeTests(output.replace('Requires Windows and NSISDIR pointing to the packaging NSIS toolchain',
    'unexpected environment failure'), 'desktop-unit', 'darwin', 'arm64')[0].status, 'failed')
})

test('Node stage records an unexpected skip despite process exit zero', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-node-summary-'))
  try {
    fs.writeFileSync(path.join(directory, 'sample.test.cjs'),
      'const test = require("node:test")\ntest("passed", () => {})\n' +
      'test("unexpected", { skip: true }, () => {})\n')
    const stage = { id: 'desktop-extra-node', kind: 'node', cwd: directory,
      args: ['--test', 'sample.test.cjs'], reportKind: 'node-summary' }
    const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
    assert.equal(result.exitCode, 0)
    assert.equal(result.report, path.join(directory, 'desktop-extra-node.json'),
      fs.readFileSync(path.join(directory, 'desktop-extra-node.stdout.log'), 'utf8'))
    assert.deepEqual(result.cases.map(item => item.status), ['failed', 'failed'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Node stage preserves its gate and records actual nested case observations', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-node-observations-'))
  context.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    assert.equal(fs.existsSync(directory), false)
  })
  const filename = path.join(directory, 'sample.test.cjs')
  fs.writeFileSync(filename,
    'const { test } = require("node:test"); test("outer", async context => {' +
    ' await context.test("leaf", () => {}); });\n')
  const stage = { id: 'desktop-extra-node', kind: 'node', cwd: directory,
    args: ['--test', filename], reportKind: 'node-summary' }
  const original = [...stage.args]
  const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.cases, [{ id: 'desktop-extra-node:node-run-1', status: 'passed', retries: 0 }])
  const payload = JSON.parse(fs.readFileSync(result.report, 'utf8'))
  assert.equal(payload.observations.available, true)
  assert.equal(payload.observations.counts.tests, 2)
  assert.equal(payload.observations.counts.passed, 2)
  assert.deepEqual(payload.observations.records.map(record => record.titlePath),
    [['outer', 'leaf'], ['outer']])
  assert.ok(payload.observations.records.every(record => record.declaredSource === fs.realpathSync(filename)))
  assert.deepEqual(stage.args, original)
})

test('stage launch leaves the declared plan unchanged across repeated launches', () => {
  const directory = path.resolve('tmp/ci-observation-launch')
  const stage = { id: 'python-run-all', kind: 'python', cwd: path.resolve('apps/serve'),
    args: ['-m', 'tests.run_all'], reportArg: true, reportKind: 'runall' }
  const original = [...stage.args]
  const first = stageLaunch(stage, directory)
  const second = stageLaunch(stage, directory)
  assert.deepEqual(stage.args, original)
  assert.deepEqual(first.args, [...original, '--report', path.join(directory, 'python-run-all.json')])
  assert.deepEqual(second.args, first.args)
})

test('Python acceptance requires nonempty and consistent structured results', () => {
  const passed = { verdict: 'PASS', results: [
    { name: 'a1.real turn', ok: true, evidence: 'real response' },
    { name: 'a2.serve', ok: true, evidence: 'real server' }
  ] }
  assert.deepEqual(summarizeAcceptance(`${JSON.stringify(passed)}\n`, 'acceptance-all'), [
    { id: 'python-acceptance-all:a1.real turn', status: 'passed', retries: 0 },
    { id: 'python-acceptance-all:a2.serve', status: 'passed', retries: 0 }
  ])
  assert.throws(() => summarizeAcceptance('human text only\n', 'acceptance-all'), /JSON/)
  assert.throws(() => summarizeAcceptance(JSON.stringify({ verdict: 'PASS', results: [] }),
    'acceptance-all'), /nonempty/)
  assert.throws(() => summarizeAcceptance(JSON.stringify({ ...passed, results: [
    passed.results[0], { name: 'a2.serve', ok: false, evidence: 'failed' }] }),
  'acceptance-all'), /verdict/)
  assert.throws(() => summarizeAcceptance(JSON.stringify({ ...passed, results: [
    passed.results[0], passed.results[0] ] }), 'acceptance-all'), /duplicate/)
})

test('p09 acceptance preserves blocked and failed surface verdicts', () => {
  const blocked = { verdict: 'BLOCKED', results: [{ name: 'cli', verdict: 'BLOCKED',
    reason: 'missing executable', command: [], artifacts: {} }] }
  assert.deepEqual(summarizeAcceptance(`log\n${JSON.stringify(blocked)}\n`, 'acceptance-p09'), [
    { id: 'python-acceptance-p09:cli', status: 'failed', retries: 0 }
  ])
  assert.throws(() => summarizeAcceptance(JSON.stringify({ ...blocked, verdict: 'PASS' }),
    'acceptance-p09'), /verdict/)
})

test('acceptance stage stores the raw final-line report and rejects missing JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-acceptance-'))
  try {
    const valid = JSON.stringify({ verdict: 'PASS', results: [
      { name: 'a1.real turn', ok: true, evidence: 'real response' }] })
    const stage = { id: 'python-acceptance-all', kind: 'node', cwd: directory,
      args: ['-e', `process.stdout.write(${JSON.stringify(`log\n${valid}\n`)})`],
      reportKind: 'acceptance-all' }
    const result = runStage(stage, directory, 'darwin', 'a'.repeat(40))
    assert.equal(result.exitCode, 0)
    assert.equal(result.report, path.join(directory, 'python-acceptance-all.json'))
    assert.deepEqual(result.cases, [
      { id: 'python-acceptance-all:a1.real turn', status: 'passed', retries: 0 }
    ])
    assert.equal(fs.readFileSync(result.report, 'utf8'), `log\n${valid}\n`)
    const missing = runStage({ ...stage, args: ['-e', 'process.stdout.write("log only\\n")'] },
      directory, 'darwin', 'a'.repeat(40))
    assert.equal(missing.exitCode, 0)
    assert.equal(missing.report, null)
    assert.deepEqual(missing.cases, [])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SkillHub approval requires real package and completed security checks', () => {
  const report = { migration_passed: true, build_approved: true,
    checks: { exact_namespace: true, read_token_publish_denied: '403',
      read_token_delete_denied: '403', read_token_management_denied: '403',
      file_501_rejected: '400' },
    skills: [{ name: 'fixture-skill', version: '1.0.0', fingerprint: 'hash',
      bytes_and_modes_identical: true, scans_passed: true }] }
  assert.equal(validateSkillHub(report), true)
  assert.equal(validateSkillHub({ ...report, skills: [] }), false)
  assert.equal(validateSkillHub({ ...report, checks: {} }), false)
  assert.equal(validateSkillHub({ ...report, skills: [
    { ...report.skills[0], scans_passed: false }] }), false)
  assert.equal(validateSkillHub({ migration_passed: true, build_approved: true }), false)
})

test('Playwright JSON marks skips, retries and failures non-passing', () => {
  const report = { suites: [{ specs: [{
    id: 'case-1', title: 'example', tests: [{ projectName: 'smoke', status: 'flaky', results: [{}, {}] }]
  }] }], errors: [], stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 1 } }
  const result = summarizePlaywright(report, 'darwin')
  assert.deepEqual(result, [{ id: 'smoke:case-1', status: 'failed', retries: 1 }])
})

test('Playwright JSON requires a real passing result and consistent counts', () => {
  const entry = { projectName: 'smoke', expectedStatus: 'passed', status: 'expected',
    results: [{ status: 'passed', errors: [] }] }
  const report = { suites: [{ specs: [{ id: 'case-3', tests: [entry] }] }], errors: [],
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 } }
  assert.equal(summarizePlaywright(report, 'darwin')[0].status, 'passed')
  assert.equal(summarizePlaywright({ ...report, suites: [{ specs: [{ id: 'case-3',
    tests: [{ ...entry, results: [] }] }] }] }, 'darwin')[0].status, 'failed')
  assert.equal(summarizePlaywright({ ...report, suites: [{ specs: [{ id: 'case-3',
    tests: [{ ...entry, expectedStatus: 'failed' }] }] }] }, 'darwin')[0].status, 'failed')
  assert.throws(() => summarizePlaywright({ ...report, stats: { ...report.stats, expected: 0 } },
    'darwin'), /count/)
})

test('Playwright global errors invalidate the structured report', () => {
  assert.throws(() => summarizePlaywright({ suites: [], errors: [{ message: 'startup failed' }],
    stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0 } }, 'darwin'), /global errors/)
})

test('Playwright JSON exempts only declared foreign-platform close cases', () => {
  const report = { suites: [{ specs: [{
    id: 'case-2', file: 'close.spec.ts', title: 'Windows 从统一弹窗退出应用',
    tests: [{ projectName: 'smoke', status: 'skipped', results: [],
      annotations: [{ type: 'skip', description: '必须在真实 Windows 运行' }] }]
  }] }], errors: [], stats: { expected: 0, skipped: 1, unexpected: 0, flaky: 0 } }
  assert.deepEqual(summarizePlaywright(report, 'darwin'), [])
  assert.deepEqual(summarizePlaywright(report, 'win32'), [
    { id: 'smoke:case-2', status: 'failed', retries: 0 }
  ])
  assert.deepEqual(summarizePlaywright({ ...report, suites: [{ specs: [
    { ...report.suites[0].specs[0], title: 'unrelated close case' }
  ] }] }, 'darwin'), [
    { id: 'smoke:case-2', status: 'failed', retries: 0 }
  ])
})

const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms))

test('stage progress includes an unambiguous timestamp and measured duration', () => {
  const timestamp = new Date('2026-10-21T02:09:00.123Z')
  assert.equal(formatStageProgress('python-run-all', 'starting', undefined, timestamp),
    '[ci:test] [2026-10-21T02:09:00.123Z] python-run-all starting\n')
  for (const status of ['exit=0', 'exit=1', 'exit=124']) {
    assert.equal(formatStageProgress('python-run-all', status, 600012, timestamp),
      `[ci:test] [2026-10-21T02:09:00.123Z] python-run-all ${status} duration=600.012s\n`)
  }
  for (const status of ['skipped=real_model_config', 'exit=blocked']) {
    assert.equal(formatStageProgress('example', status, undefined, timestamp),
      `[ci:test] [2026-10-21T02:09:00.123Z] example ${status}\n`)
  }
  assert.match(formatStageProgress('instant', 'exit=0', 0, timestamp), /duration=0\.000s\n$/)
})

test('scheduled stages log timed completion exactly once for every outcome', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-progress-'))
  try {
    const planned = [
      { id: 'success', kind: 'node', cwd: directory, args: ['-e', 'process.exit(0)'] },
      { id: 'failure', kind: 'node', cwd: directory, args: ['-e', 'process.exit(3)'] },
      { id: 'blocked', dependsOn: 'failure' },
      { id: 'skipped', skipReason: 'real_model_config' }
    ]
    const script = `
      const { scheduleStages } = require(${JSON.stringify(path.join(sourceDirectory, 'test.cjs'))})
      scheduleStages(${JSON.stringify({ planned, directory, platform: 'darwin', commit: 'a'.repeat(40),
        prerequisiteError: null, npmAvailable: true, parallel: false })})
        .then(records => process.stdout.write(JSON.stringify(records)))
    `
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const lines = result.stderr.trim().split('\n')
    assert.equal(lines.length, 6)
    for (const line of lines) {
      assert.match(line, /^\[ci:test\] \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /)
    }
    for (const [stage, exitCode] of [['success', 0], ['failure', 3]]) {
      assert.equal(lines.filter(line => line.endsWith(`${stage} starting`)).length, 1)
      assert.equal(lines.filter(line => new RegExp(`${stage} exit=${exitCode} duration=\\d+\\.\\d{3}s$`).test(line)).length, 1)
    }
    assert.equal(lines.filter(line => line.endsWith('blocked exit=blocked')).length, 1)
    assert.equal(lines.filter(line => line.endsWith('skipped skipped=real_model_config')).length, 1)
    const records = JSON.parse(result.stdout)
    assert.equal(records.length, planned.length)
    assert.equal(records.find(record => record.id === 'failure').exitCode, 3)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('stage quota planning keeps serial default at full cpus and shares budget when parallel', () => {
  const stages = [{ id: 'a' }, { id: 'b', dependsOn: 'a' }, { id: 'c', kind: 'playwright' }]
  assert.deepEqual([...planQuotas(stages, false, 11).entries()], [['a', 10]])
  const parallel = planQuotas(stages, true, 11)
  // 权重 10+10+6=26 按比例切 10 核预算，总量恒等预算且各至少 1
  assert.equal([...parallel.values()].reduce((acc, value) => acc + value, 0), 10)
  assert.equal(parallel.get('a'), 4)
  assert.equal(parallel.get('b'), 4)
  assert.equal(parallel.get('c'), 2)
})

test('planStages honors explicit per-stage quota over env defaults', () => {
  const stages = planStages('darwin', {}, { profile: 'full', quarantine: false, quota: 3 })
  const runAll = stages.find(stage => stage.id === 'python-run-all')
  assert.equal(runAll.args[runAll.args.indexOf('--jobs') + 1], '3')
  const unit = stages.find(stage => stage.id === 'desktop-unit')
  assert.ok(unit.args.includes('--test-concurrency=3'), 'explicit budget overrides default 4')
  assert.deepEqual(unit.args.filter(argument => argument.startsWith('--test-concurrency=')),
    ['--test-concurrency=3'])
  const testFiles = unit.args.filter(argument => /\.test\.(?:ts|cjs|mjs)$/.test(argument))
  assert.equal(testFiles.length, new Set(testFiles).size)
  assert.ok(!unit.args.includes('--test-force-exit'), 'forced exit can discard completed worker results')
  assert.ok(!unit.args.some(arg => arg.includes('*')), 'quoted globs are expanded to real files for spawn')
  const wide = planStages('darwin', {}, { profile: 'full', quota: 8 })
  assert.ok(wide.find(stage => stage.id === 'desktop-unit').args.includes('--test-concurrency=8'))
})

test('scheduler preserves dependency order and blocks dependents after failure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-sched-'))
  try {
    const planned = [
      { id: 'root-ok', kind: 'node', cwd: directory, args: ['-e', 'process.stdout.write("ok")'] },
      { id: 'child-blocked', kind: 'node', cwd: directory, dependsOn: 'root-fail',
        args: ['-e', 'process.stdout.write("never")'] },
      { id: 'skipped-one', skipReason: 'real_model_config' },
      { id: 'root-fail', kind: 'node', cwd: directory, args: ['-e', 'process.exit(3)'] },
      { id: 'dependent-ok', kind: 'node', cwd: directory, dependsOn: 'root-ok',
        args: ['-e', 'process.stdout.write("after")'] }
    ]
    const records = await scheduleStages({ planned, directory, platform: 'darwin',
      commit: 'a'.repeat(40), prerequisiteError: null, npmAvailable: true,
      parallel: false, quota: planQuotas(planned, false, 11) })
    const byId = new Map(records.map(record => [record.id, record]))
    assert.equal(byId.get('root-ok').exitCode, 0)
    assert.equal(byId.get('dependent-ok').exitCode, 0)
    assert.equal(byId.get('root-fail').exitCode, 3)
    assert.equal(byId.get('child-blocked').status, 'blocked')
    assert.deepEqual(byId.get('child-blocked').reason, { code: 'dependency_failed', stage: 'root-fail' })
    assert.equal(reportsIntact([byId.get('child-blocked')], directory), true)
    assert.equal(byId.get('skipped-one').status, 'skipped')
    for (const id of ['root-ok', 'dependent-ok', 'root-fail']) {
      assert.ok(Number.isInteger(byId.get(id).durationMs) && byId.get(id).durationMs >= 0, id)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('parallel scheduler overlaps independent branches and injects CI_STAGE_QUOTA', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-par-'))
  try {
    const timed = tag => ({ kind: 'node', cwd: directory,
      args: ['-e', `console.log(process.env.CI_STAGE_QUOTA);setTimeout(() => process.stdout.write('${tag}'), 300)`] })
    const planned = [{ id: 'p-a', ...timed('a') }, { id: 'p-b', ...timed('b') }]
    const startedAt = Date.now()
    // 默认配额（planQuotas parallel）按比例切分预算，两路都获批且并行重叠。
    const parallelBudget = os.cpus().length - 1 >= 10
    const records = await scheduleStages({ planned, directory, platform: 'darwin',
      commit: 'b'.repeat(40), prerequisiteError: null, npmAvailable: true,
      parallel: true })
    void startedAt
    assert.equal(records.length, 2)
    assert.equal(new Map(records.map(r => [r.id, r.exitCode])).get('p-a'), 0)
    const quotaA = fs.readFileSync(path.join(directory, 'p-a.stdout.log'), 'utf8').trim().split('\n')[0]
    if (parallelBudget) assert.ok(Number(quotaA) >= 5, `proportional share expected, got ${quotaA}`)
    else assert.equal(quotaA, String(Math.max(2, os.cpus().length - 1)))
    // 显式小配额（2+2）时两路并行重叠：以「总耗时 < 两子进程 durationMs 之和」为结构证据，
    // 不依赖墙钟绝对值，避免 spawn 抖动导致误报。
    const overlapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-par2-'))
    try {
      const overlapPlanned = [
        { id: 'q-a', kind: 'node', cwd: overlapDir, args: ['-e', 'console.log(process.env.CI_STAGE_QUOTA);setTimeout(() => process.stdout.write("a"), 300)'] },
        { id: 'q-b', kind: 'node', cwd: overlapDir, args: ['-e', 'console.log(process.env.CI_STAGE_QUOTA);setTimeout(() => process.stdout.write("b"), 300)'] }
      ]
      const overlapRecords = await scheduleStages({ planned: overlapPlanned, directory: overlapDir, platform: 'darwin',
        commit: 'd'.repeat(40), prerequisiteError: null, npmAvailable: true,
        parallel: true, quota: new Map([['q-a', 2], ['q-b', 2]]) })
      const durations = new Map(overlapRecords.map(r => [r.id, r.durationMs]))
      if (parallelBudget) {
        assert.ok(durations.get('q-a') + durations.get('q-b') >
          Math.max(...overlapRecords.map(r => r.durationMs)),
        `no overlap: durations ${[...durations.values()].join(',')}`)
      }
      const quotaB = fs.readFileSync(path.join(overlapDir, 'q-b.stdout.log'), 'utf8').trim().split('\n')[0]
      assert.equal(quotaB, '2')
    } finally {
      fs.rmSync(overlapDir, { recursive: true, force: true })
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('runStage and scheduled path produce the same evidence shape', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-test-shape-'))
  try {
    const stage = { id: 'shape', kind: 'node', cwd: directory,
      args: ['-e', 'process.stdout.write("same")'] }
    const syncRecord = runStage(stage, directory, 'darwin', 'c'.repeat(40))
    assert.equal(reportsIntact([syncRecord], directory), true)
    const [asyncRecord] = await scheduleStages({ planned: [stage], directory, platform: 'darwin',
      commit: 'c'.repeat(40), prerequisiteError: null, npmAvailable: true,
      parallel: false, quota: planQuotas([stage], false, 11) })
    for (const key of ['id', 'exitCode', 'cases']) {
      assert.deepEqual(asyncRecord[key], syncRecord[key], key)
    }
    assert.ok(syncRecord.report && asyncRecord.report)
    assert.equal(reportsIntact([asyncRecord], directory), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
