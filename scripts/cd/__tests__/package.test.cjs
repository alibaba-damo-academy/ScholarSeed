const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { validateBuildResult, validateQualityResult, judgePackagedE2E } = require('../package.cjs')
const { planStages } = require('../../ci/test.cjs')
const { checkNpm } = require('../../pre/toolchain.cjs')

const COMMIT = 'a'.repeat(40)

function packageFixture(directory) {
  const root = path.resolve(sourceDirectory, '../..')
  fs.cpSync(path.join(root, 'scripts'), path.join(directory, 'scripts'), { recursive: true })
  fs.cpSync(path.join(root, 'apps/desktop/runtime'), path.join(directory, 'apps/desktop/runtime'), { recursive: true })
  fs.cpSync(path.join(root, 'apps/desktop/scripts'), path.join(directory, 'apps/desktop/scripts'), { recursive: true })
  for (const name of ['package.json', '.node-version', 'pyproject.toml', 'apps/desktop/package.json', 'apps/desktop/.node-version']) {
    fs.copyFileSync(path.join(root, name), path.join(directory, name))
  }
  for (const stage of planStages(process.platform)) {
    for (const argument of stage.args) {
      const filename = path.resolve(stage.cwd, argument)
      if (!filename.startsWith(path.join(root, 'apps/desktop') + path.sep) ||
          !/\.test\.(ts|mjs|cjs)$/.test(filename) || !fs.existsSync(filename)) continue
      const target = path.join(directory, path.relative(root, filename))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(filename, target)
    }
  }
  const modules = path.join(directory, 'apps/desktop/node_modules')
  fs.mkdirSync(modules, { recursive: true })
  if (!fs.existsSync(path.join(modules, 'typescript'))) {
    fs.symlinkSync(fs.realpathSync(path.join(root, 'apps/desktop/node_modules/typescript')),
      path.join(modules, 'typescript'), 'junction')
  }
  const git = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ' + git.stdout.trim() + '\n')
  fs.writeFileSync(path.join(directory, 'scripts/ops-cli.cjs'), `
    const { spawnSync } = require('node:child_process')
    const args = process.argv.slice(2)
    const legacy = args[0] === 'ci' ? ['run', 'ci:test', '--', ...args.slice(2)]
      : args[0] === 'cd' ? ['run', 'package', '--', ...args.slice(3)] : null
    if (!legacy) throw new Error('Unregistered fixture command')
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...legacy], {
      cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: false
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  `)
  return path.join(directory, 'scripts/cd/package.cjs')
}


function passingQuality(directory, commit) {
  const ids = ['ci-prerequisites', ...(process.platform === 'darwin' ? ['ci-skillhub-prerequisites'] : []),
    ...planStages(process.platform).map(stage => stage.id)]
  const stages = ids.map(id => {
    const report = path.join(directory, `${id}.json`)
    fs.writeFileSync(report, '{}')
    return { id, platform: process.platform, commit, exitCode: 0, timedOut: false,
      report, cases: [{ id: `${id}:case`, status: 'passed', retries: 0 }] }
  })
  return { schemaVersion: 1, platform: process.platform, commit, profile: 'full',
    sourceClean: true, reportsIntact: true,
    verdict: 'pass', failures: [], stages }
}

test('package requires a complete structured quality verdict before building', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-quality-verdict-'))
  try {
    const quality = passingQuality(directory, COMMIT)
    assert.doesNotThrow(() => validateQualityResult(quality, process.platform, COMMIT))
    assert.throws(() => validateQualityResult({ ...quality, stages: [] }, process.platform, COMMIT), /stage/)
    assert.throws(() => validateQualityResult({ ...quality, schemaVersion: 2 }, process.platform, COMMIT), /schema/)
    assert.throws(() => validateQualityResult({ ...quality, failures: [{ reason: 'failed' }] },
      process.platform, COMMIT), /failure/)
    assert.throws(() => validateQualityResult({ ...quality, reportsIntact: false },
      process.platform, COMMIT), /report evidence/)
    assert.throws(() => validateQualityResult({ ...quality,
      stages: quality.stages.map((stage, index) => index === 0 ? { ...stage, report: null } : stage) },
    process.platform, COMMIT), /report/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('desktop package wrapper forwards installer result paths through the npm CLI', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-wrapper-'))
  try {
    const npmCli = path.join(directory, 'npm-cli.js')
    const capture = path.join(directory, 'arguments.json')
    const resultPath = path.join(directory, 'result & spaces.json')
    const npmVersion = checkNpm().version
    assert.match(npmVersion, /^\d+\.\d+\.\d+$/)
    const packageEntry = packageFixture(directory)
    const desktop = path.join(directory, 'apps/desktop')
    const manifest = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
    manifest.dependencies = {}
    manifest.devDependencies = {}
    fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(manifest))
    const lock = JSON.stringify({ packages: { '': { dependencies: {}, devDependencies: {} } } })
    fs.writeFileSync(path.join(desktop, 'package-lock.json'), lock)
    const vite = path.join(desktop, 'node_modules/electron-vite/bin')
    fs.mkdirSync(vite, { recursive: true })
    fs.writeFileSync(path.join(vite, 'electron-vite.js'), '')
    const digest = crypto.createHash('sha256').update(lock).digest('hex')
    fs.writeFileSync(path.join(desktop, 'node_modules/.scholarseed-package-lock.sha256'),
      `${digest} node-v${process.versions.node} npm-v${npmVersion}`)
    fs.writeFileSync(npmCli, `if (process.argv[2] === '--version') {
      process.stdout.write(${JSON.stringify(npmVersion)})
    } else {
      require('node:fs').writeFileSync(process.env.CI_TEST_CAPTURE,
        JSON.stringify(process.argv.slice(2)))
    }`, { mode: 0o755 })
    const child = spawnSync(process.execPath,
      [path.join(path.dirname(packageEntry), '..', 'shared', 'desktop.cjs'), 'package', '--result', resultPath], {
        encoding: 'utf8', env: { ...process.env, npm_execpath: npmCli,
          npm_config_user_agent: `npm/${npmVersion}`, CI_TEST_CAPTURE: capture }
      })
    assert.equal(child.status, 0, child.stderr)
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')),
      ['run', 'package', '--', '--result', resultPath])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('binds the installer to platform, commit, arch, and exact SHA-256', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-test-'))
  try {
    const installer = path.join(directory, 'product.dmg')
    fs.writeFileSync(installer, 'installer bytes')
    const sha256 = crypto.createHash('sha256').update('installer bytes').digest('hex')
    const build = { status: 'passed', source: { commit: COMMIT },
      release: { platform: 'darwin', arch: 'arm64' }, artifacts: { dmg: { path: installer, sha256 } } }
    assert.equal(validateBuildResult(build, 'darwin', 'arm64', COMMIT).path, installer)
    assert.throws(() => validateBuildResult(build, 'win32', 'arm64', COMMIT), /platform/)
    assert.throws(() => validateBuildResult(build, 'darwin', 'x86_64', COMMIT), /architecture/)
    assert.throws(() => validateBuildResult(build, 'darwin', 'arm64', 'b'.repeat(40)), /commit/)
    fs.writeFileSync(installer, 'changed bytes')
    assert.throws(() => validateBuildResult(build, 'darwin', 'arm64', COMMIT), /SHA-256/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('installed-app verdict rejects missing, empty, failed and flaky Playwright evidence', () => {
  const mainFlowTitle = 'installed package creates a project and document, completes a real model turn, and restarts'
  const passedCase = { projectName: 'package', status: 'expected', expectedStatus: 'passed',
    annotations: [], results: [{ status: 'passed', errors: [] }] }
  const report = (entry, stats, title = mainFlowTitle) => JSON.stringify({ errors: [],
    suites: entry ? [{ specs: [{ id: 'package-case', title, file: 'package.spec.ts', tests: [entry] }] }] : [],
    stats: { expected: 0, skipped: 0, unexpected: 0, flaky: 0, ...stats } })
  assert.deepEqual(judgePackagedE2E(0, report(passedCase, { expected: 1 }), 'darwin'), {
    cases: [{ id: 'package:package-case', status: 'passed', retries: 0 }], passed: true
  })
  assert.equal(judgePackagedE2E(1, report(passedCase, { expected: 1 }), 'darwin').passed, false)
  assert.throws(() => judgePackagedE2E(0, '', 'darwin'), /JSON/)
  assert.deepEqual(judgePackagedE2E(0, report(null), 'darwin'), { cases: [], passed: false })
  assert.equal(judgePackagedE2E(0, report({ ...passedCase, projectName: 'smoke' },
    { expected: 1 }), 'darwin').passed, false)
  assert.equal(judgePackagedE2E(0, report(passedCase, { expected: 1 },
    'unrelated installed-app test'), 'darwin').passed, false)
  const failed = { ...passedCase, status: 'unexpected',
    results: [{ status: 'failed', errors: [{ message: 'assertion' }] }] }
  assert.equal(judgePackagedE2E(0, report(failed, { unexpected: 1 }), 'darwin').passed, false)
  const flaky = { ...passedCase, status: 'flaky',
    results: [{ status: 'failed', errors: [{ message: 'retry' }] },
      { status: 'passed', errors: [] }] }
  assert.equal(judgePackagedE2E(0, report(flaky, { flaky: 1 }), 'darwin').passed, false)
})

test('direct package invocation writes a failed prerequisite report', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-direct-'))
  try {
    const resultPath = path.join(directory, 'ci-package.json')
    const env = { ...process.env }
    delete env.npm_execpath
    const child = spawnSync(process.execPath,
      [packageFixture(directory), '--result', resultPath], { encoding: 'utf8', env })
    assert.equal(child.status, 1)
    const report = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    assert.equal(report.verdict, 'fail')
    assert.equal(report.failures[0].code, 'quality_failed')
    assert.deepEqual(report.stages.build.reason, { code: 'quality_failed' })
    assert.deepEqual(report.stages.packagedE2E.reason, { code: 'quality_failed' })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('failed or dirty source verdict prevents package invocation', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-cli-test-'))
  try {
    const fakeNpm = path.join(directory, 'npm.cjs')
    const marker = path.join(directory, 'package-called')
    fs.writeFileSync(fakeNpm, `
      const fs = require('node:fs')
      const { spawnSync } = require('node:child_process')
      const args = process.argv.slice(2)
      const result = args[args.indexOf('--result') + 1]
      if (args[1] === 'package') fs.writeFileSync(process.env.CI_TEST_MARKER, 'called')
      if (args[1] === 'ci:test') {
        const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
        fs.writeFileSync(result, JSON.stringify({ platform: process.platform, commit,
          verdict: process.env.CI_TEST_QUALITY_VERDICT,
          sourceClean: process.env.CI_TEST_SOURCE_CLEAN === 'true' }))
      }
    `)
    for (const [verdict, sourceClean] of [['fail', 'true'], ['pass', 'false']]) {
      const child = spawnSync(process.execPath, [packageFixture(directory)], {
        encoding: 'utf8', env: { ...process.env, npm_execpath: fakeNpm, CI_TEST_MARKER: marker,
          CI_TEST_QUALITY_VERDICT: verdict, CI_TEST_SOURCE_CLEAN: sourceClean }
      })
      assert.equal(child.status, 1)
      assert.equal(fs.existsSync(marker), false)
      const summary = JSON.parse(child.stdout.trim().split('\n').at(-1))
      const report = JSON.parse(fs.readFileSync(summary.result, 'utf8'))
      assert.equal(report.verdict, 'fail')
      assert.equal(report.stages.pretest.exitCode, 0)
      assert.equal(report.stages.pretest.timedOut, false)
      assert.ok(report.stages.pretest.durationMs >= 0)
      assert.equal(report.stages.build.status, 'blocked')
      assert.deepEqual(report.stages.build.reason, { code: 'quality_failed' })
      assert.deepEqual(report.stages.packagedE2E.reason, { code: 'quality_failed' })
      assert.equal(report.failures[0].code, 'quality_failed')
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('explicit package verdict path is honored on a failed quality gate', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-result-'))
  try {
    const resultPath = path.join(directory, 'ci-package.json')
    const fakeNpm = path.join(directory, 'npm.cjs')
    fs.writeFileSync(fakeNpm, `
      const fs = require('node:fs')
      const { spawnSync } = require('node:child_process')
      const args = process.argv.slice(2)
      const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      fs.writeFileSync(args[args.indexOf('--result') + 1], JSON.stringify({
        platform: process.platform, commit, verdict: 'fail', sourceClean: true }))
    `)
    const child = spawnSync(process.execPath,
      [packageFixture(directory), '--result', resultPath], {
        encoding: 'utf8', env: { ...process.env, npm_execpath: fakeNpm }
      })
    assert.equal(child.status, 1)
    const summary = JSON.parse(child.stdout.trim().split('\n').at(-1))
    assert.equal(summary.result, resultPath)
    assert.equal(JSON.parse(fs.readFileSync(resultPath, 'utf8')).verdict, 'fail')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('malformed quality JSON retains failed pretest evidence and blocks packaging', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-malformed-'))
  try {
    const fakeNpm = path.join(directory, 'npm.cjs')
    const marker = path.join(directory, 'package-called')
    fs.writeFileSync(fakeNpm, `
      const fs = require('node:fs')
      const args = process.argv.slice(2)
      if (args[1] === 'package') fs.writeFileSync(process.env.CI_TEST_MARKER, 'called')
      else fs.writeFileSync(args[args.indexOf('--result') + 1], '{invalid')
    `)
    const child = spawnSync(process.execPath, [packageFixture(directory)], {
      encoding: 'utf8', env: { ...process.env, npm_execpath: fakeNpm, CI_TEST_MARKER: marker }
    })
    assert.equal(child.status, 1)
    const summary = JSON.parse(child.stdout.trim().split('\n').at(-1))
    const report = JSON.parse(fs.readFileSync(summary.result, 'utf8'))
    assert.equal(report.verdict, 'fail')
    assert.equal(report.stages.pretest.exitCode, 0)
    assert.equal(report.stages.pretest.verdict, 'fail')
    assert.equal(report.stages.pretest.timedOut, false)
    assert.ok(report.stages.pretest.durationMs >= 0)
    assert.equal(report.stages.build.status, 'blocked')
    assert.deepEqual(report.stages.build.reason, { code: 'quality_failed' })
    assert.equal(fs.existsSync(marker), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('build and artifact failures have distinct structured package verdicts', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-build-'))
  try {
    const fakeNpm = path.join(directory, 'npm.cjs')
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory, encoding: 'utf8' }).stdout.trim()
    const qualityFixture = path.join(directory, 'quality-fixture.json')
    fs.writeFileSync(qualityFixture, JSON.stringify(passingQuality(directory, commit)))
    fs.writeFileSync(fakeNpm, `
      const fs = require('node:fs')
      const { spawnSync } = require('node:child_process')
      const args = process.argv.slice(2)
      const result = args[args.indexOf('--result') + 1]
      const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      if (args[1] === 'ci:test') {
        fs.copyFileSync(process.env.CI_TEST_QUALITY_FIXTURE, result)
      } else if (process.env.CI_TEST_BUILD_MODE === 'exit') {
        process.exitCode = 1
      } else {
        fs.writeFileSync(result, JSON.stringify({ status: 'passed', source: { commit },
          release: { platform: process.platform,
            arch: process.arch === 'x64' ? 'x86_64' : process.arch }, artifacts: {} }))
      }
    `)
    for (const [mode, code] of [['exit', 'build_failed'], ['artifact', 'artifact_invalid']]) {
      const child = spawnSync(process.execPath, [packageFixture(directory)], {
        encoding: 'utf8', env: { ...process.env, npm_execpath: fakeNpm, CI_TEST_BUILD_MODE: mode,
          CI_TEST_QUALITY_FIXTURE: qualityFixture }
      })
      assert.equal(child.status, 1)
      const summary = JSON.parse(child.stdout.trim().split('\n').at(-1))
      const report = JSON.parse(fs.readFileSync(summary.result, 'utf8'))
      assert.equal(report.verdict, 'fail')
      assert.equal(report.stages.pretest.verdict, 'pass')
      assert.deepEqual(report.stages.packagedE2E.reason, { code }, JSON.stringify(report.failures))
      assert.equal(report.failures[0].code, code)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('missing live model prerequisites block only installed-app execution after a valid artifact', {
  skip: !['darwin', 'win32'].includes(process.platform)
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-package-model-'))
  try {
    const fakeNpm = path.join(directory, 'npm.cjs')
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDirectory, encoding: 'utf8' }).stdout.trim()
    const qualityFixture = path.join(directory, 'quality-fixture.json')
    fs.writeFileSync(qualityFixture, JSON.stringify(passingQuality(directory, commit)))
    const installer = path.join(directory, process.platform === 'darwin' ? 'product.dmg' : 'product.exe')
    fs.writeFileSync(installer, 'synthetic installer for contract test')
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex')
    fs.writeFileSync(fakeNpm, `
      const fs = require('node:fs')
      const { spawnSync } = require('node:child_process')
      const args = process.argv.slice(2)
      const result = args[args.indexOf('--result') + 1]
      const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      if (args[1] === 'ci:test') {
        fs.copyFileSync(process.env.CI_TEST_QUALITY_FIXTURE, result)
      } else {
        const extension = process.platform === 'darwin' ? 'dmg' : 'exe'
        fs.writeFileSync(result, JSON.stringify({ status: 'passed', source: { commit },
          release: { platform: process.platform,
            arch: process.arch === 'x64' ? 'x86_64' : process.arch },
          artifacts: { [extension]: { path: process.env.CI_TEST_INSTALLER,
            sha256: process.env.CI_TEST_SHA256 } } }))
      }
    `)
    const child = spawnSync(process.execPath, [packageFixture(directory)], {
      encoding: 'utf8', env: { ...process.env, npm_execpath: fakeNpm, CI_TEST_INSTALLER: installer,
        CI_TEST_SHA256: sha256, CI_TEST_QUALITY_FIXTURE: qualityFixture, SCHOLARSEED_ACTION_MODEL: '' }
    })
    assert.equal(child.status, 1)
    const summary = JSON.parse(child.stdout.trim().split('\n').at(-1))
    const report = JSON.parse(fs.readFileSync(summary.result, 'utf8'))
    assert.equal(report.stages.build.exitCode, 0, JSON.stringify(report.failures))
    assert.equal(report.installer.sha256, sha256)
    assert.deepEqual(report.stages.packagedE2E.reason, { code: 'model_prerequisites_failed' })
    assert.equal(report.failures[0].code, 'model_prerequisites_failed')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
