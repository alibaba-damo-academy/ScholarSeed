const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { isolatedCIEnvironment, prepareModelHome, cleanupModelHome } = require('../ci/model.cjs')
const { planStages, summarizePlaywright } = require('../ci/test.cjs')
const { judgeRun } = require('../ci/verdict.cjs')

const ROOT = path.resolve(__dirname, '../..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const PLAYWRIGHT = path.join(DESKTOP, 'node_modules', 'playwright', 'cli.js')
const OPS = path.join(ROOT, 'scripts', 'ops-cli.cjs')
const TIMEOUT_MS = 3_600_000
const PACKAGE_PROJECT = 'package'
const PACKAGE_SPEC_FILE = 'package.spec.ts'
const PACKAGE_MAIN_FLOW_TITLE = 'installed package creates a project and document, completes a real model turn, and restarts'
const FAILURE_CODES = {
  pretest: 'quality_failed',
  build: 'build_failed',
  artifact: 'artifact_invalid',
  model: 'model_prerequisites_failed',
  packagedE2E: 'packaged_e2e_failed'
}

function sha256(filename) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filename, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let length
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function validateBuildResult(build, platform, arch, commit) {
  if (build?.status !== 'passed') throw new Error('build status is not passed')
  if (build.source?.commit !== commit) throw new Error('build commit mismatch')
  if (build.release?.platform !== platform) throw new Error('build platform mismatch')
  if (build.release?.arch !== arch) throw new Error('build architecture mismatch')
  const extension = platform === 'darwin' ? 'dmg' : 'exe'
  const artifact = build.artifacts?.[extension]
  if (!artifact || typeof artifact.path !== 'string' || !path.isAbsolute(artifact.path) ||
      path.extname(artifact.path).toLowerCase() !== `.${extension}` || !fs.existsSync(artifact.path) ||
      !fs.statSync(artifact.path).isFile()) {
    throw new Error('installer artifact is missing or invalid')
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || sha256(artifact.path) !== artifact.sha256) {
    throw new Error('installer SHA-256 mismatch')
  }
  return artifact
}

function validateQualityResult(quality, platform, commit) {
  if (quality?.schemaVersion !== 1) throw new Error('ci:test quality schema is invalid')
  if (quality.verdict !== 'pass' || quality.profile !== 'full' || quality.sourceClean !== true ||
      quality.platform !== platform || quality.commit !== commit) {
    throw new Error('ci:test did not pass for this platform and commit')
  }
  if (quality.reportsIntact !== true) throw new Error('ci:test report evidence is invalid')
  if (!Array.isArray(quality.failures) || quality.failures.length) {
    throw new Error('ci:test quality has missing or nonempty failures')
  }
  const required = ['ci-prerequisites', ...(platform === 'darwin' ? ['ci-skillhub-prerequisites'] : []),
    ...planStages(platform).map(stage => stage.id)]
  if (!Array.isArray(quality.stages) || quality.stages.length !== required.length ||
      quality.stages.some((stage, index) => stage?.id !== required[index])) {
    throw new Error('ci:test quality stage plan is incomplete')
  }
  for (const stage of quality.stages) {
    if (typeof stage.report !== 'string' || !path.isAbsolute(stage.report) ||
        !fs.statSync(stage.report, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`ci:test quality report is missing for ${stage.id}`)
    }
  }
  const expected = quality.stages.flatMap(stage => Array.isArray(stage.cases)
    ? stage.cases.map(item => item?.id) : [])
  if (judgeRun({ platform, commit, profile: quality.profile, sourceClean: quality.sourceClean,
    reportsIntact: quality.reportsIntact, plannedStages: required,
    expected, stages: quality.stages }).verdict !== 'pass') {
    throw new Error('ci:test quality stage evidence is invalid')
  }
}

function judgePackagedE2E(exitCode, output, platform) {
  let report
  try {
    report = JSON.parse(output)
  } catch {
    throw new Error('installed application E2E report is not JSON')
  }
  const cases = summarizePlaywright(report, platform)
  const pending = [...report.suites]
  let mainFlowCount = 0
  while (pending.length) {
    const suite = pending.pop()
    pending.push(...(suite.suites || []))
    for (const spec of suite.specs || []) {
      if (spec.file === PACKAGE_SPEC_FILE && spec.title === PACKAGE_MAIN_FLOW_TITLE) {
        mainFlowCount += (spec.tests || []).filter(entry => entry.projectName === PACKAGE_PROJECT).length
      }
    }
  }
  return { cases, passed: exitCode === 0 && mainFlowCount === 1 && cases.length > 0 &&
    cases.every(item => item.id.startsWith(`${PACKAGE_PROJECT}:`) &&
      item.status === 'passed' && item.retries === 0) }
}

function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, filename)
}

function run(command, args, cwd, directory, id, env = process.env) {
  const started = Date.now()
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024 })
  const label = id.replace(/[^a-z0-9-]/gi, '-')
  fs.writeFileSync(path.join(directory, `${label}.stdout.log`), result.stdout || '')
  fs.writeFileSync(path.join(directory, `${label}.stderr.log`), result.stderr || String(result.error || ''))
  return { ...result, durationMs: Date.now() - started }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--result' || !argv[1])) {
    throw new Error('ci:package accepts only --result <path>')
  }
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('ci:package requires native macOS or Windows')
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`cannot resolve source commit: ${git.stderr}`)
  const commit = git.stdout.trim()
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  const directoryRoot = path.join(ROOT, 'tmp')
  fs.mkdirSync(directoryRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(directoryRoot, 'ci-package-'))
  const qualityPath = path.join(directory, 'quality.json')
  const buildPath = path.join(directory, 'release-result.json')
  const reportPath = argv.length ? path.resolve(argv[1]) : path.join(directory, 'ci-package.json')
  const report = { schemaVersion: 1, platform: process.platform, arch, commit, qualityPath,
    buildPath, stages: {}, verdict: 'fail', failures: [] }
  const ops = (args, id) => run(process.execPath, [OPS, ...args], ROOT, directory, id)
  let modelHome = null
  let phase = 'pretest'
  try {
    if (!process.env.npm_execpath) throw new Error('package acceptance requires the package-manager context established by pnpm ops')
    const tested = ops(['ci', 'test', '--profile', 'quality', '--with-external', '--result', qualityPath], 'quality')
    report.stages.pretest = { exitCode: tested.status ?? 1, timedOut: tested.error?.code === 'ETIMEDOUT',
      durationMs: tested.durationMs, signal: tested.signal || null,
      report: fs.existsSync(qualityPath) ? qualityPath : null, verdict: 'fail' }
    const quality = fs.existsSync(qualityPath) ? JSON.parse(fs.readFileSync(qualityPath, 'utf8')) : null
    report.stages.pretest.verdict = quality?.verdict || 'fail'
    if (tested.status !== 0) throw new Error('ci:test command failed')
    validateQualityResult(quality, process.platform, commit)

    phase = 'build'
    const built = ops(['cd', 'build', 'local', '--result', buildPath], 'build')
    report.stages.build = { exitCode: built.status ?? 1, timedOut: built.error?.code === 'ETIMEDOUT',
      durationMs: built.durationMs, signal: built.signal || null,
      result: fs.existsSync(buildPath) ? buildPath : null }
    if (built.status !== 0 || !fs.existsSync(buildPath)) throw new Error('package command failed or omitted result')
    phase = 'artifact'
    const artifact = validateBuildResult(JSON.parse(fs.readFileSync(buildPath, 'utf8')),
      process.platform, arch, commit)
    report.installer = { path: artifact.path, sha256: artifact.sha256, size: fs.statSync(artifact.path).size }

    phase = 'model'
    modelHome = prepareModelHome(directory)
    phase = 'packagedE2E'
    const e2e = run(process.execPath, [PLAYWRIGHT, 'test', `--project=${PACKAGE_PROJECT}`, '--reporter=json'],
      DESKTOP, directory, 'packaged-e2e', { ...isolatedCIEnvironment(), CI: '1',
        SCHOLARSEED_REAL_HOME: modelHome.home,
        SCHOLARSEED_CI_INSTALLER: artifact.path, SCHOLARSEED_CI_INSTALLER_SHA256: artifact.sha256 })
    const raw = path.join(directory, 'packaged-e2e.json')
    fs.writeFileSync(raw, e2e.stdout || '')
    report.stages.packagedE2E = { exitCode: e2e.status ?? 1, timedOut: e2e.error?.code === 'ETIMEDOUT',
      durationMs: e2e.durationMs, signal: e2e.signal || null, report: raw, cases: [] }
    const outcome = judgePackagedE2E(e2e.status, e2e.stdout, process.platform)
    report.stages.packagedE2E.cases = outcome.cases
    if (!outcome.passed) {
      throw new Error('installed application E2E did not pass')
    }
    report.verdict = 'pass'
  } catch (error) {
    const code = FAILURE_CODES[phase]
    if (!report.stages.pretest) report.stages.pretest = { status: 'failed', reason: { code } }
    if (!report.stages.build) report.stages.build = {
      status: phase === 'build' ? 'failed' : 'blocked', reason: { code }
    }
    if (!report.stages.packagedE2E) report.stages.packagedE2E = {
      status: phase === 'packagedE2E' ? 'failed' : 'blocked', reason: { code }
    }
    report.failures.push({ stage: phase, code, reason: error.message })
  } finally {
    try {
      atomicJSON(reportPath, report)
      process.stdout.write(`${JSON.stringify({ result: reportPath, platform: process.platform,
        commit, verdict: report.verdict })}\n`)
    } finally {
      cleanupModelHome(modelHome)
    }
  }
  return report.verdict === 'pass' ? 0 : 1
}

module.exports = { validateBuildResult, validateQualityResult, judgePackagedE2E, main }

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[ci:package] ${error.message}`)
    process.exitCode = 1
  }
}
