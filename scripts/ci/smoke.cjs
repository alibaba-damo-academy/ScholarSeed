const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { atomicJSON, reportSha256, reportsIntact,
  runStage, recordBlockedStage, qualityResultPath, formatStageProgress } = require('./test.cjs')
const { judgeRun } = require('./verdict.cjs')
const { checkNode } = require('../pre/toolchain.cjs')
const { sourceSnapshot, sourceUnchanged } = require('../shared/source.cjs')

const ROOT = path.resolve(__dirname, '../..')
const PROFILE = 'smoke'
const MARKERS = ['smoke-unit', 'smoke-core']
const LAYERS = ['logic', 'render', 'data', 'native', 'product']
const SCHEMA_VERSION = 1
const DEFAULT_JOBS = 8
const MAX_JOBS = 12

function smokeJobs(environment = process.env) {
  const raw = environment.CI_SMOKE_JOBS ?? String(DEFAULT_JOBS)
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > MAX_JOBS) {
    throw new Error(`CI_SMOKE_JOBS must be an integer between 1 and ${MAX_JOBS}`)
  }
  return Number(raw)
}
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const RESULT_DIRECTORY = 'ci-smoke'
const RUN_DIRECTORY_PREFIX = 'ci-smoke-'
const CASE_DIRECTORY = 'cases'
const PREREQUISITES = 'smoke-prerequisites'
const LOCK_FILE = 'running.lock'
const REGISTRY_TIMEOUT_MS = 30_000
const REGISTRY_MAX_BUFFER = 1024 * 1024
const FAILURE_CATEGORIES = { environment: 'environment_missing', assertion: 'assertion_failure',
  timeout: 'timeout', runner: 'runner_error', cleanup: 'cleanup_failure' }

function requireList(value, label) {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim()) ||
      new Set(value).size !== value.length) throw new Error(`invalid or duplicate ${label}`)
  return value
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== SCHEMA_VERSION || manifest.profile !== PROFILE ||
      !Array.isArray(manifest.entries) || !manifest.entries.length) throw new Error('invalid smoke manifest')
  requireList(manifest.platforms, 'platforms')
  const ids = new Set()
  const identities = new Set()
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error('invalid or duplicate smoke entry')
    }
    ids.add(entry.id)
    requireList(entry.markers, 'markers')
    if (entry.markers.some(marker => !MARKERS.includes(marker))) throw new Error('invalid smoke marker')
    if (typeof entry.owner !== 'string' || !entry.owner.trim() || typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`missing owner or reason: ${entry.id}`)
    }
    if (!LAYERS.includes(entry.layer) || !Array.isArray(entry.resources) ||
        entry.resources.some(resource => typeof resource !== 'string' || !resource.trim()) ||
        ['inputExpected', 'cleanup'].some(field => typeof entry[field] !== 'string' || !entry[field].trim())) {
      throw new Error(`missing smoke layer or data contract: ${entry.id}`)
    }
    requireList(entry.invariants, 'invariants')
    const runner = entry.runner
    let identity
    if (runner?.kind === 'run-all' && typeof runner.suite === 'string' && /^[a-zA-Z_][\w.]*$/.test(runner.suite)) {
      requireList(entry.requiredCases, 'required cases')
      identity = `run-all:${runner.suite}`
    } else if (runner?.kind === 'node') {
      requireList(entry.expectedCases, 'expected cases')
      if (entry.expectedCount !== entry.expectedCases.length) throw new Error(`case count mismatch: ${entry.id}`)
      requireList(runner.files, 'Node files')
      for (const file of runner.files) {
        if (path.isAbsolute(file) || file.includes('\\') || file.split('/').includes('..') || !file.endsWith('.test.cjs') && !file.endsWith('.test.ts')) {
          throw new Error(`invalid Node test file: ${file}`)
        }
        const fileIdentity = `node:${file}`
        if (identities.has(fileIdentity)) throw new Error('duplicate runner identity')
        identities.add(fileIdentity)
      }
      identity = `node-entry:${entry.id}`
    } else throw new Error(`unsupported runner: ${entry.id}`)
    if (identities.has(identity)) throw new Error('duplicate runner identity')
    identities.add(identity)
  }
  for (const [field, marker] of [['requiredCoreIds', 'smoke-core'], ['requiredUnitIds', 'smoke-unit']]) {
    for (const id of requireList(manifest[field], field)) {
      if (!manifest.entries.some(entry => entry.id === id && entry.markers.includes(marker))) {
        throw new Error(`missing required ${marker}: ${id}`)
      }
    }
  }
  return manifest
}

function selectionFor(manifest, registry) {
  requireList(registry, 'runner registry')
  const selected = manifest.entries.filter(entry => entry.runner.kind === 'run-all').map(entry => entry.runner.suite)
  if (!selected.length || selected.some(suite => !registry.includes(suite))) throw new Error('smoke suite not in runner registry')
  return { suites: registry.filter(suite => selected.includes(suite)), registry }
}

function validateCollection(report, entry) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.kind !== 'collection' ||
      report.suite !== entry.runner.suite || report.exitStatus !== 0 ||
      !Array.isArray(report.errors) || report.errors.length) {
    throw new Error(`invalid smoke collection: ${entry.id}`)
  }
  const planned = requireList(report.planned, 'collected cases')
  const missing = entry.requiredCases.filter(id => !planned.includes(id))
  if (missing.length) throw new Error(`missing required smoke cases: ${entry.id}: ${missing.join(', ')}`)
  return [...planned]
}

function validateCaseReport(report, entry) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report.suite !== entry.runner.suite || report.exitStatus !== 0 ||
      !Array.isArray(report.errors) || report.errors.length || !Array.isArray(report.cases)) {
    throw new Error(`invalid case observations: ${entry.id}`)
  }
  const planned = requireList(report.planned, 'actual collected cases')
  if (planned.length !== entry.expectedCases.length || planned.some(id => !entry.expectedCases.includes(id))) {
    throw new Error(`smoke collection mismatch: ${entry.id}`)
  }
  const seen = new Set()
  if (report.cases.length !== planned.length) throw new Error(`incomplete case observations: ${entry.id}`)
  for (const item of report.cases) {
    if (!item || !planned.includes(item.id) || seen.has(item.id) || item.status !== 'passed' || item.retries !== 0) {
      throw new Error(`unsuccessful or duplicate case observations: ${entry.id}`)
    }
    seen.add(item.id)
  }
  return report.cases.map(item => ({ ...item, id: `${entry.id}:${item.id}` }))
}

function validateNodeReport(report, entry) {
  const observations = report?.observations
  if (observations?.available !== true || observations.frameworkSuccess !== true || !Array.isArray(observations.records)) {
    throw new Error(`missing Node observations: ${entry.id}`)
  }
  const records = observations.records.filter(item => item.kind !== 'suite')
  const titles = records.map(item => item.titlePath.join(' > '))
  if (records.length !== entry.expectedCases.length || new Set(titles).size !== titles.length ||
      records.some((item, index) => !entry.expectedCases.includes(titles[index]) || item.status !== 'passed' || item.occurrence !== 1)) {
    throw new Error(`smoke Node collection or result mismatch: ${entry.id}`)
  }
  return records.map((item, index) => ({ id: `${entry.id}:${titles[index]}`, status: item.status, retries: 0 }))
}

function smokeVerdict(run) {
  const verdict = judgeRun({ ...run, profile: undefined })
  const validSource = sourceUnchanged(run.sourceAtStart, run.sourceAtStart) && sourceUnchanged(run.sourceAtEnd, run.sourceAtEnd) &&
    run.commit === run.sourceAtStart.commit && run.sourceClean === (run.sourceAtStart.clean && run.sourceAtEnd.clean)
  const unchanged = validSource && run.sourceUnchanged === true && sourceUnchanged(run.sourceAtStart, run.sourceAtEnd)
  if (run.profile !== PROFILE) verdict.failures.push({ reason: 'invalid_smoke_profile', stage: null, caseId: null })
  if (!validSource) verdict.failures.push({ reason: 'source_evidence_invalid', stage: null, caseId: null })
  else if (!unchanged) verdict.failures.push({ reason: 'source_changed', stage: null, caseId: null })
  if (unchanged && run.profile === PROFILE) verdict.failures = verdict.failures.filter(item => item.reason !== 'dirty_source')
  for (const stage of run.stages) {
    if (stage.status === 'skipped' || stage.cases.some(item => item.status !== 'passed' || item.retries !== 0)) {
      verdict.failures.push({ reason: 'smoke_requires_all_passed', stage: stage.id, caseId: null })
    }
  }
  verdict.verdict = verdict.failures.length ? 'fail' : 'pass'
  return verdict
}

function resultPath(root = ROOT) {
  return qualityResultPath(['--result', path.join(root, 'tmp', RESULT_DIRECTORY, 'quality.json')], root)
}

function formatSmokeSummary(quality, { destination, exitCode, durationMs }) {
  const passed = exitCode === 0
  const cases = quality?.stages?.flatMap(stage => stage.displayCases || stage.cases || [])
  const counts = cases ? `通过 ${cases.filter(item => item.status === 'passed').length} / ` +
    `失败 ${cases.filter(item => item.status === 'failed').length} / 跳过 ${cases.filter(item => item.status === 'skipped').length}`
    : '通过/失败/跳过数量未知（未取得用例结果）'
  const missing = cases && quality.expected ? quality.expected.filter(id => !cases.some(item => item.id === id)).length : null
  const unknown = cases?.filter(item => !['passed', 'failed', 'skipped'].includes(item.status)).length
  return `[ci:smoke] ${passed ? '通过 (PASS)' : '失败 (FAIL)'}\n` +
    `[ci:smoke] 已观测结果（含前置检查）：${counts}${missing ? ` / 缺失 ${missing}` : ''}${unknown ? ` / 未知状态 ${unknown}` : ''}\n` +
    `[ci:smoke] 总耗时：${(durationMs / 1000).toFixed(3)}s（含报告写入和锁清理）\n` +
    `[ci:smoke] 报告：${destination}\n` +
    (quality?.failures?.length ? `[ci:smoke] 判定失败原因：${[...new Set(quality.failures.map(item => item.reason))].join(', ')}\n` : '') +
    (quality?.stages || []).flatMap(stage => ['observationError', 'reportError'].filter(key => stage[key])
      .map(key => `[ci:failure] ${stage.id} ${key}: ${stage[key]}\n`)).join('') +
    (!quality ? '[ci:smoke] 本轮报告不可用；不要将该路径的历史报告视为本轮结果。\n' : '')
}

function plannedStages(manifest, selection, platform, directory, jobs = smokeJobs()) {
  if (!manifest.platforms.includes(platform)) throw new Error(`smoke run-all is not available on ${platform}`)
  // Smoke has its own exact suite selection on both native platforms; the full
  // CI planner's platform split must not silently remove this gate.
  const python = { id: 'python-run-all', kind: 'python', cwd: path.join(ROOT, 'apps', 'serve'),
    env: { PYTHONPATH: ROOT, CI_ISOLATED_CASE_JOBS: String(jobs) }, progress: true, reportArg: true, reportKind: 'runall', selection,
    args: ['-m', 'tests.run_all', '--jobs', String(jobs), '--case-report-dir', path.join(directory, CASE_DIRECTORY),
      ...selection.suites.flatMap(suite => ['--only-suite', suite])] }
  const node = manifest.entries.filter(entry => entry.runner.kind === 'node').map(entry => ({
    id: entry.id, kind: 'node', cwd: ROOT, reportKind: 'node-summary',
    args: ['--experimental-transform-types', '--test', '--test-concurrency=1', ...entry.runner.files]
  }))
  return [python, ...node]
}

function prerequisiteProbe(manifest, source, directory) {
  if (!manifest.platforms.includes(process.platform)) throw new Error(`smoke is not validated on platform: ${process.platform}`)
  if (!process.env.npm_execpath) throw new Error('invoke smoke through pnpm ops ci test smoke (or the configured package manager)')
  if (!sourceUnchanged(source, source)) throw new Error('ci:smoke requires valid source fingerprint evidence')
  const node = checkNode(ROOT)
  fs.accessSync(PYTHON, fs.constants.X_OK)
  const pythonVersion = spawnSync(PYTHON, ['--version'], { encoding: 'utf8',
    timeout: REGISTRY_TIMEOUT_MS, maxBuffer: REGISTRY_MAX_BUFFER })
  const python = (pythonVersion.stdout || pythonVersion.stderr || '').trim()
  if (pythonVersion.status !== 0 || !/^Python \d+\.\d+\.\d+$/.test(python)) {
    throw new Error(`smoke Python version prerequisite failed: ${pythonVersion.error || python}`)
  }
  const probe = spawnSync(PYTHON, ['-P', '-m', 'tests.run_all', '--list'], {
    cwd: path.join(ROOT, 'apps', 'serve'), encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: [path.join(ROOT, 'apps', 'serve'), ROOT].join(path.delimiter) },
    timeout: REGISTRY_TIMEOUT_MS, maxBuffer: REGISTRY_MAX_BUFFER
  })
  if (probe.status !== 0) throw new Error(`smoke runner registry prerequisite failed: ${probe.stderr || probe.error || probe.stdout}`)
  const registry = JSON.parse(probe.stdout)
  if (registry?.schemaVersion !== SCHEMA_VERSION) throw new Error('invalid runner registry schema')
  const selection = selectionFor(manifest, registry.suites)
  const collections = {}
  for (const entry of manifest.entries.filter(entry => entry.runner.kind === 'run-all')) {
    const target = path.join(directory, `collection-${entry.id}.json`)
    const collected = spawnSync(PYTHON, ['-P', '-m', 'tests.observations',
      '--module', `tests.${entry.runner.suite}`, '--collect-only', '--report', target,
      '--isolation-root', directory], {
      cwd: path.join(ROOT, 'apps', 'serve'), encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: [path.join(ROOT, 'apps', 'serve'), ROOT].join(path.delimiter) },
      timeout: REGISTRY_TIMEOUT_MS, maxBuffer: REGISTRY_MAX_BUFFER
    })
    if (collected.status !== 0) throw new Error(`smoke collection failed: ${entry.id}: ${collected.stderr || collected.error || collected.stdout}`)
    const report = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (report.isolation?.rootRemovedBeforeExit !== true) throw new Error(`smoke collection isolation cleanup failed: ${entry.id}`)
    entry.expectedCases = validateCollection(report, entry)
    collections[entry.id] = report
  }
  return { selection, collections, versions: { node, python } }
}

function runSmoke(argv = process.argv.slice(2)) {
  const jobs = smokeJobs()
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  process.stderr.write(formatStageProgress(PREREQUISITES, 'starting'))
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true })
  const directory = fs.mkdtempSync(path.join(ROOT, 'tmp', RUN_DIRECTORY_PREFIX))
  let source
  try { source = sourceSnapshot(ROOT) } catch (error) { source = { valid: false, clean: false, commit: null, error: error.message } }
  const platform = process.platform
  const commit = source.commit
  const stages = []
  let manifest = null
  let planned = []
  let prerequisiteError = null
  let selection = null
  let versions = null
  let collections = null
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke.json'), 'utf8')))
    const prerequisite = prerequisiteProbe(manifest, source, directory)
    selection = prerequisite.selection
    versions = prerequisite.versions
    collections = prerequisite.collections
    planned = plannedStages(manifest, selection, platform, directory)
  } catch (error) {
    prerequisiteError = error
    process.stderr.write(`[ci:failure] ${PREREQUISITES}: ${error.stack || error.message}\n`)
  }
  const preparationFinished = Date.now()
  const preparationSelectionMs = preparationFinished - started
  const prerequisiteReport = path.join(directory, `${PREREQUISITES}.json`)
  atomicJSON(prerequisiteReport, { status: prerequisiteError ? 'failed' : 'passed', error: prerequisiteError?.message || null,
    versions, collections, failureCategory: prerequisiteError ? FAILURE_CATEGORIES.environment : null })
  stages.push({ id: PREREQUISITES, platform, commit, exitCode: prerequisiteError ? 1 : 0, timedOut: false,
    report: prerequisiteReport, reportSha256: reportSha256(prerequisiteReport), durationMs: preparationSelectionMs,
    failureCategory: prerequisiteError ? FAILURE_CATEGORIES.environment : null,
    cases: [{ id: PREREQUISITES, status: prerequisiteError ? 'failed' : 'passed', retries: 0 }] })
  process.stderr.write(formatStageProgress(PREREQUISITES, `exit=${prerequisiteError ? 1 : 0}`, preparationSelectionMs))
  const executionStarted = Date.now()
  const prerequisitePublicationMs = executionStarted - preparationFinished
  for (const stage of planned) {
    process.stderr.write(formatStageProgress(stage.id, 'starting'))
    let record
    let displayCases
    try {
      record = runStage(stage, directory, platform, commit)
      if (record.timedOut) record.failureCategory = FAILURE_CATEGORIES.timeout
      else if (record.exitCode !== 0) record.failureCategory = FAILURE_CATEGORIES.assertion
      if (record.report) {
        const raw = JSON.parse(fs.readFileSync(record.report, 'utf8'))
        if (stage.id === 'python-run-all') {
          displayCases = manifest.entries.filter(entry => entry.runner.kind === 'run-all').flatMap(entry =>
            (raw.results.find(item => item.suite === entry.runner.suite)?.observations?.cases || [])
              .map(item => ({ id: `${entry.id}:${item.id}`, status: item.status })))
          if (raw.results.some(row => row.timedOut)) record.failureCategory = FAILURE_CATEGORIES.timeout
          else if (raw.results.some(row => row.observations?.cases?.some(item =>
            item.failureCategory === FAILURE_CATEGORIES.cleanup))) record.failureCategory = FAILURE_CATEGORIES.cleanup
          else if (raw.results.some(row => row.observations?.errors?.length)) record.failureCategory = FAILURE_CATEGORIES.runner
          const cases = []
          for (const entry of manifest.entries.filter(item => item.runner.kind === 'run-all')) {
            const row = raw.results.find(item => item.suite === entry.runner.suite)
            cases.push(...validateCaseReport(row?.observations, entry))
          }
          record.cases = cases
        } else {
          displayCases = raw.observations?.records?.filter(item => item.kind !== 'suite').map(item => ({
            id: `${stage.id}:${item.titlePath.join(' > ')}`, status: item.status
          }))
          record.cases = validateNodeReport(raw, manifest.entries.find(entry => entry.id === stage.id))
        }
      }
    } catch (error) {
      record = record || recordBlockedStage(stage, directory, platform, commit, error.message)
      process.stderr.write(`[ci:failure] ${stage.id} report validation: ${error.stack || error.message}\n`)
      record.observationError = error.message
      record.failureCategory ||= FAILURE_CATEGORIES.runner
      record.exitCode = record.exitCode || 1
      record.cases = []
      if (displayCases) record.displayCases = displayCases
    }
    stages.push(record)
    process.stderr.write(formatStageProgress(stage.id, `exit=${record.exitCode}`, record.durationMs))
  }
  const executionFinished = Date.now()
  let sourceAtEnd
  try { sourceAtEnd = sourceSnapshot(ROOT) } catch (error) { sourceAtEnd = { valid: false, clean: false, commit: null, error: error.message } }
  const expected = [PREREQUISITES, ...(manifest?.entries || []).flatMap(entry => (entry.expectedCases || entry.requiredCases || []).map(id => `${entry.id}:${id}`))]
  const run = { platform, commit, profile: PROFILE, sourceClean: source.clean === true && sourceAtEnd.clean === true,
    sourceUnchanged: sourceUnchanged(source, sourceAtEnd), sourceAtStart: source, sourceAtEnd,
    reportsIntact: reportsIntact(stages, directory),
    plannedStages: [PREREQUISITES, ...planned.map(stage => stage.id)], expected, stages }
  const verdict = smokeVerdict(run)
  const snapshotAt = Date.now()
  const quality = { schemaVersion: SCHEMA_VERSION, ...run, profile: PROFILE, validationScope: PROFILE,
    sourceAtStart: source, sourceAtEnd, manifest, selection, runDirectory: directory,
    startedAt, finishedAt: new Date(snapshotAt).toISOString(), durationMs: snapshotAt - started,
    phaseDurations: { preparationSelectionMs, prerequisitePublicationMs,
      stageExecutionAndWaitMs: executionFinished - executionStarted,
      finalIntegrityAndJudgmentMs: snapshotAt - executionFinished },
    timingBoundary: { summaryDuration: 'run_start_to_final_report_snapshot',
      stageExecutionAndWait: 'includes_runner_wait_adapters_identity_checks_and_logs',
      finalPublicationAndLockLifecycle: 'external_wall_clock_only', cleanup: 'not_inferred_from_residual_time' },
    environment: { node: process.version, platform, arch: process.arch, cpus: os.cpus().length,
      memoryBytes: os.totalmem(), jobs, python: PYTHON, versions }, ...verdict }
  const destination = resultPath()
  atomicJSON(destination, quality)
  return verdict.verdict === 'pass' ? 0 : 1
}

function main(argv = process.argv.slice(2), { filesystem = fs, writeJSON = atomicJSON, execute = runSmoke,
  destination = resultPath(), log = message => process.stderr.write(message),
  output = message => process.stdout.write(message) } = {}) {
  const started = Date.now()
  const lock = path.join(path.dirname(destination), LOCK_FILE)
  let descriptor
  try {
    filesystem.mkdirSync(path.dirname(destination), { recursive: true })
    descriptor = filesystem.openSync(lock, 'wx')
  } catch (error) {
    log(formatSmokeSummary(null, { destination, exitCode: 1, durationMs: Date.now() - started }))
    throw new Error(`smoke summary is locked by another run; inspect ${lock}: ${error.message}`)
  }
  let primary = null
  let exitCode = 1
  const cleanupErrors = []
  let quality = null
  function snapshotSummary() {
    try { quality = JSON.parse(filesystem.readFileSync(destination, 'utf8')) } catch { quality = null }
  }
  function publishCleanupFailure() {
    let previous = {}
    try { previous = JSON.parse(filesystem.readFileSync(destination, 'utf8')) } catch (error) {
      previous = { failures: [...(primary ? [{ reason: primary.message }] : []), { reason: error.message }] }
    }
    const original = (previous.failures || []).filter(failure => failure.reason !== 'cleanup_failed')
    writeJSON(destination, { ...previous, schemaVersion: SCHEMA_VERSION, profile: PROFILE, validationScope: PROFILE,
      verdict: 'fail', failureCategory: FAILURE_CATEGORIES.cleanup, cleanupErrors: cleanupErrors.map(error => error.message),
      failures: [...original, ...cleanupErrors.map(error => ({ reason: 'cleanup_failed', error: error.message }))] })
  }
  try {
    filesystem.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
    writeJSON(destination, { schemaVersion: SCHEMA_VERSION, profile: PROFILE, validationScope: PROFILE,
      verdict: 'fail', status: 'running', failures: [{ reason: 'run_not_completed' }] })
    if (argv.length) throw new Error('ci:smoke does not accept scope or report overrides')
    exitCode = execute(argv)
  } catch (error) {
    primary = error
    writeJSON(destination, { schemaVersion: SCHEMA_VERSION, profile: PROFILE, validationScope: PROFILE,
      verdict: 'fail', status: FAILURE_CATEGORIES.runner, failures: [{ reason: error.message }] })
  } finally {
    try { filesystem.closeSync(descriptor) } catch (error) {
      cleanupErrors.push(error)
      try { publishCleanupFailure() } catch (publicationError) { cleanupErrors.push(publicationError) }
    }
    snapshotSummary()
    try { filesystem.unlinkSync(lock) } catch (error) {
      cleanupErrors.push(error)
      try { publishCleanupFailure() } catch (publicationError) { cleanupErrors.push(publicationError) }
      snapshotSummary()
    }
  }
  if (cleanupErrors.length) {
    primary = new AggregateError([...(primary ? [primary] : []), ...cleanupErrors], 'smoke runner or cleanup failed')
  }
  const finalExitCode = primary ? 1 : exitCode
  const durationMs = Date.now() - started
  log(formatStageProgress('smoke-total', `exit=${finalExitCode}`, durationMs))
  log(formatSmokeSummary(quality, { destination, exitCode: finalExitCode, durationMs }))
  output(`${JSON.stringify({ result: destination, verdict: finalExitCode === 0 ? 'pass' : 'fail', exitCode: finalExitCode, durationMs })}\n`)
  if (primary) throw primary
  return exitCode
}

module.exports = { smokeJobs, validateManifest, selectionFor, validateCollection, validateCaseReport, validateNodeReport, smokeVerdict, resultPath, formatSmokeSummary, plannedStages, main }

if (require.main === module) {
  try { process.exitCode = main() } catch (error) {
    console.error(`[ci:smoke] ${error.stack || error.message}`)
    process.exitCode = 1
  }
}
