const sourceDirectory = require('node:path').dirname(__dirname)
// Deterministic input contracts only; not Electron/DMG acceptance.
const { test } = require('node:test')
require('./velopack-sign.test.cjs')
require('./windows-sign.test.cjs')
require('./seal.test.cjs')
require('./payload.test.cjs')
require('./bytecode.test.cjs')
require('./velopack.test.cjs')
require('./handoff.test.cjs')
require('./branding.test.cjs')
require('./compiler.test.cjs')
require('./texlive.test.cjs')
require('./engine.test.cjs')
require('./enginecheck.test.cjs')
require('./vpk.test.cjs')
require('./setup.test.cjs')
require('./installation.test.cjs')
require('./registration.test.cjs')
require('./cache.test.cjs')
require('./compression.test.cjs')
require('./assembly.test.cjs')
require('./bundle.test.cjs')
require('./acceptance.test.cjs')
require('./dmg.test.cjs')
require('./execution.test.cjs')
require('./verification.test.cjs')
require('./browser.test.cjs')
require('./mutex.test.cjs')
require('./shipit.test.cjs')
require('./recovery.test.cjs')
require('./source.test.cjs')
require('./squirrel.test.cjs')
require('../../../native/shipit/artifact.test.cjs')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { runInNewContext } = require('node:vm')
const { createRequire } = require('node:module')
const ts = require('typescript')
const { TARGETS } = require('../../shared/target.cjs')
const { applicationLayout, assertBridgeApplication, prepareBridgeApplication } = require('../layout.cjs')
const { verifyInputs, verifyNotices, stageNotices } = require('../notices.cjs')
const PACKAGE = require('../../../package.json')

const {
  options,
  requireInstallerSmoke,
  acquireMutex,
  BUILD_TYPES,
  builderEvidence,
  buildNumberOf,
  buildRunDirectory,
  buildApplicationLayout,
  credentialFreeEnv,
  freezeFile,
  frozenProductConfiguration,
  installerArtifacts,
  localDmgbuild,
  writeBuilderConfiguration,
  payloadStatistics,
} = require('../build.cjs')
const { budget: smokeBudget } = require('../../../../../scripts/ci/smoke.json')
const { MAX_TOTAL_BUDGET_MS } = require('../../../../../scripts/ci/budget.cjs')
const {
  adHocOptions,
  preserveReviewedRuntime,
  shouldIgnore,
  countSignableFiles,
  trackSignProgress,
} = require('../sign.cjs')
const { isMachO, isBundle, isSignable, signableIgnore } = require('../macho.cjs')
const { credentials, waitForNotarization } = require('../notarize.cjs')
const {
  packageCheckEnvironment,
  packageCheckArguments,
  packageCheckLog,
  nativeStageRecords,
  componentTimingRecords,
  packageShutdownReceipt,
  packageShutdownLogDelta,
  artifactTemporaryRoot,
  createPackageCheckDirectory,
  preflightDirectories,
  protectWindowsVerificationDirectory,
  DARWIN_UNIX_SOCKET_PATH_BYTES,
  productPath,
  RUNTIME_PROBE_SCRIPT,
  unsignedPackageCheck,
  bestEffortRemoveTemporary,
} = require('../verify.cjs')
const { sha256, sha512, executableDigest } = require('../../shared/digest.cjs')
const { ownedExecutable } = require('../windows-sign.cjs')
const desktopPackage = require('../package.cjs')
const {
  developmentDisplayName,
  resolveGitIdentity,
  registerMacDevelopmentBundle,
  updateMacBundleName,
} = require('../../pre/identity.cjs')
const REPO_ROOT = path.join(sourceDirectory, '../../../..')

test('the macOS update bridge is an explicit directory layout and has separate build output', () => {
  const ordinary = options(['--platform', 'darwin', '--arch', 'arm64', '--stage', 'dir'])
  const bridge = options(['--platform', 'darwin', '--arch', 'arm64', '--stage', 'dir', '--macos-update-bridge'])
  assert.equal(ordinary.applicationLayout, 'asar')
  assert.equal(bridge.applicationLayout, 'directory')
  assert.notEqual(buildRunDirectory('release', ordinary), buildRunDirectory('release', bridge))
  assert.throws(
    () => options(['--platform', 'win32', '--arch', 'x86_64', '--macos-update-bridge']),
    /requires a macOS application or installer stage/
  )
  assert.throws(
    () => options(['--platform', 'darwin', '--arch', 'arm64', '--stage', 'backend', '--macos-update-bridge']),
    /requires a macOS application or installer stage/
  )
})

test('only the signed macOS 0.3.2 release installer defaults to the update bridge', () => {
  const releaseInstaller = {
    platform: 'darwin',
    type: 'release',
    stage: 'installer',
    version: '0.3.2',
    candidate: false,
  }
  assert.equal(buildApplicationLayout(releaseInstaller), 'directory')
  for (const otherBuild of [
    { platform: 'win32' },
    { type: 'preview' },
    { type: 'dev' },
    { stage: 'dir' },
    { stage: 'backend' },
    { version: '0.4.0' },
    { candidate: true },
  ]) {
    assert.equal(buildApplicationLayout({ ...releaseInstaller, ...otherBuild }), 'asar')
  }
})

test('macOS update bridge packaging removes only the fallback archive and refuses nested ASAR paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-update-bridge-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const application = path.join(root, 'ScholarSeed.app')
  const resources = path.join(application, 'Contents', 'Resources')
  const layout = applicationLayout(resources, 'directory')
  fs.mkdirSync(layout.nativeDirectory, { recursive: true })
  const fallback = path.join(resources, 'default_app.asar')
  fs.writeFileSync(fallback, 'Electron fallback')
  const module = path.join(layout.nativeDirectory, 'lease.node')
  fs.writeFileSync(module, 'frozen native module')

  prepareBridgeApplication(application)
  assert.equal(fs.existsSync(fallback), false)
  assert.equal(fs.readFileSync(module, 'utf8'), 'frozen native module')
  assert.doesNotThrow(() => assertBridgeApplication(application))
  fs.writeFileSync(path.join(layout.nativeDirectory, 'nested.ASAR'), 'unexpected archive')
  assert.throws(() => assertBridgeApplication(application), /nested\.ASAR/)
})

test('macOS update bridge keeps the normal frozen inputs and signing hook with a directory app', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-bridge-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const args = options(['--stage', 'dir', '--platform', 'darwin', '--arch', 'arm64', '--macos-update-bridge'])
  const filename = writeBuilderConfiguration({
    runDirectory: directory,
    resourceRoot: path.join(directory, 'resources'),
    output: path.join(directory, 'artifacts'),
    productName: 'ScholarSeed',
    applicationLayout: args.applicationLayout,
    closure: { protected: { generation: 'a'.repeat(64) } },
  }, args)
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
  assert.equal(config.asar, false)
  assert.equal(config.asarUnpack, undefined)
  assert.equal(config.appId, PACKAGE.build.appId)
  assert.equal(config.mac.hardenedRuntime, true)
  assert.match(config.afterPack, /[/\\]sign\.cjs$/)
  assert.match(config.afterAllArtifactBuild, /[/\\]verify\.cjs$/)
  assert.match(config.afterSign, /[/\\]notarize\.cjs$/)
})

test('installer smoke uses the same fixed command once on both platforms and ignores other build stages', () => {
  const invocations = []
  const launch = (executable, args, settings) => {
    invocations.push({ executable, args, settings })
    return { status: 0 }
  }
  const environment = { npm_execpath: 'npm', SCHOLARSEED_UPDATE_PAYLOAD_PRIVATE_KEY: 'not forwarded' }
  for (const target of Object.values(TARGETS)) {
    for (const stage of ['backend', 'dir']) {
      assert.equal(requireInstallerSmoke({ stage, target }, environment, { launch }), false)
    }
    assert.equal(requireInstallerSmoke({ stage: target.installer, target }, environment, { launch }), true)
  }
  assert.deepEqual(invocations, Object.values(TARGETS).map(() => ({
    executable: process.execPath,
    args: [path.join(REPO_ROOT, 'scripts', 'ci', 'smoke.cjs')],
    settings: { cwd: REPO_ROOT, env: { npm_execpath: 'npm' }, stdio: 'inherit', shell: false, windowsHide: true },
  })))
})

test('installer smoke fails closed on launch errors, failed children and over-budget success', context => {
  const build = { stage: 'dmg', target: { installer: 'dmg' } }
  for (const result of [{ status: 7 }, { status: null, signal: 'SIGTERM' }]) {
    assert.throws(() => requireInstallerSmoke(build, {}, { launch: () => result }), /smoke.*failed/i)
  }
  const error = new Error('spawn failed')
  assert.throws(() => requireInstallerSmoke(build, {}, { launch: () => ({ error }) }), { message: error.message })
  const limit = Math.min(smokeBudget.targetMs, MAX_TOTAL_BUDGET_MS)
  for (const duration of [limit - 1, limit, limit + 1]) {
    let elapsed = 0
    const controls = { clock: () => elapsed, launch: () => {
      elapsed = duration
      return { status: 0 }
    } }
    if (duration <= limit) assert.equal(requireInstallerSmoke(build, {}, controls), true)
    else assert.throws(() => requireInstallerSmoke(build, {}, controls), /wall-clock budget/)
  }
  const original = smokeBudget.targetMs
  context.after(() => { smokeBudget.targetMs = original })
  smokeBudget.targetMs = MAX_TOTAL_BUDGET_MS + 1
  let elapsed = 0
  assert.throws(() => requireInstallerSmoke(build, {}, { clock: () => elapsed, launch: () => {
    elapsed = smokeBudget.targetMs
    return { status: 0 }
  } }), /wall-clock budget/)
})

test('build failures remain nonzero after the builder asynchronous cleanup hook', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-exit-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const preload = path.join(root, 'cleanup.cjs')
  // Resolve through the actual dependency owners under both npm and pnpm layouts.
  const builder = createRequire(require.resolve('electron-builder'))
  const utilities = createRequire(builder.resolve('builder-util'))
  const temporary = createRequire(utilities.resolve('temp-file'))
  fs.writeFileSync(preload, `require(${JSON.stringify(temporary.resolve('async-exit-hook'))})(() => {})`)
  const result = spawnSync(process.execPath, ['--require', preload,
    path.join(sourceDirectory, 'build.cjs'), '--invalid-build-option'], { encoding: 'utf8' })
  assert.match(result.stderr, /\[package\] ERROR/)
  assert.equal(result.status, 1, result.stderr)
})

test('packaging targets preserve independent macOS and Windows artwork', () => {
  const desktopRoot = path.join(sourceDirectory, '../..')
  for (const [source, destination] of [['resources/tray.png', 'tray.png'], ['resources/tray.ico', 'tray.ico'], ['resources/tray-white.ico', 'tray-white.ico'], ['resources/windows.ico', 'windows-tray.ico']]) {
    assert.deepEqual(PACKAGE.build.extraResources.find((entry) => entry.to === destination), {
      from: source, to: destination,
    })
    assert.ok(fs.statSync(path.join(desktopRoot, source)).size > 0)
  }
  assert.notEqual(PACKAGE.build.mac.icon, PACKAGE.build.win.icon)
  assert.notEqual(PACKAGE.build.win.icon, 'resources/icon.png')
  for (const selected of Object.values(TARGETS)) {
    const config = selected.platform === 'darwin' ? PACKAGE.build.mac : PACKAGE.build.win
    assert.equal(selected.icon, config.icon)
    assert.ok(fs.statSync(path.join(desktopRoot, selected.icon)).size > 0)
  }
  assert.notDeepEqual(
    fs.readFileSync(path.join(desktopRoot, 'resources/icon.png')),
    fs.readFileSync(path.join(desktopRoot, PACKAGE.build.win.icon))
  )
})
test('literature review publication oracle exists in source', () => {
  const oraclePath = path.join(REPO_ROOT, 'skills/community/literature-review/scripts/smoke_publication.py')
  assert.ok(fs.statSync(oraclePath).size > 0)
})
test('macOS development protocol registration uses a stable checkout-specific bundle identity', () => {
  const calls = []
  const run = (...args) => calls.push(args)
  const plist = '/tmp/checkout/Electron.app/Contents/Info.plist'
  for (const platform of ['linux', 'win32']) {
    assert.equal(registerMacDevelopmentBundle(plist, platform, run), false)
  }
  assert.equal(calls.length, 0)
  registerMacDevelopmentBundle(plist, 'darwin', run)
  const firstId = calls[0][1][3]
  assert.match(firstId, /^com\.scholarseed\.desktop\.dev\.[a-f0-9]{16}$/)
  assert.deepEqual(JSON.parse(calls[1][1][3]), [{
    CFBundleURLName: PACKAGE.build.productName,
    CFBundleURLSchemes: ['scholarseed-notification'],
    CFBundleTypeRole: 'Editor',
  }])
  assert.deepEqual(calls[2][1], ['-f', '/tmp/checkout/Electron.app'])
  registerMacDevelopmentBundle(plist, 'darwin', run)
  assert.equal(calls[3][1][3], firstId)
  registerMacDevelopmentBundle('/tmp/other/Electron.app/Contents/Info.plist', 'darwin', run)
  assert.notEqual(calls[6][1][3], firstId)
})
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const WORKSPACE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'shared', 'workspace.cjs'), 'utf8')
const BUNDLE_BACKEND_SOURCE = fs.readFileSync(path.join(sourceDirectory, 'bundle.cjs'), 'utf8')
const PROBE_SOURCE = fs.readFileSync(path.join(sourceDirectory, '../shared/probe.cjs'), 'utf8')
test('backend bundling uses current runtime and product configuration owners', () => {
  assert.ok(BUNDLE_BACKEND_SOURCE.includes("'runtime', 'packages/runtime'"))
  // 产品模块清单的唯一载体已移入 scripts/shared/probe.cjs（bundle 构建期与 verify 包内验证共用），
  // bundle.cjs 必须真的执行这份探针。
  assert.ok(PROBE_SOURCE.includes('"scholarseed_runtime"'))
  assert.ok(BUNDLE_BACKEND_SOURCE.includes('RUNTIME_PROBE_SCRIPT'))
  assert.ok(!BUNDLE_BACKEND_SOURCE.includes('packages/damoagent'))
  assert.ok(!BUNDLE_BACKEND_SOURCE.includes('"damoagent"'))
})
const VERIFY_SOURCE = fs.readFileSync(path.join(sourceDirectory, 'verify.cjs'), 'utf8')
const BUILD_SOURCE = fs.readFileSync(path.join(sourceDirectory, 'build.cjs'), 'utf8')
const DESKTOP_BACKEND_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/main/backend.ts'),
  'utf8'
)
const STORAGE_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/main/storage.ts'),
  'utf8'
)
const UPDATER_SOURCE = fs
  .readFileSync(path.join(sourceDirectory, '../../src/main/updater.ts'), 'utf8')
  .replace(/\r\n/g, '\n')
const SUBPROCESS_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/main/subprocess.ts'),
  'utf8'
)
const CODESIGN_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/main/codesign.ts'),
  'utf8'
)
const NOTARIZATION_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/main/notarization.ts'),
  'utf8'
)
const NATIVE_NOTARIZATION_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../native/notarization.c'),
  'utf8'
)
const COMPONENTS_CJS_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../runtime/components.cjs'),
  'utf8'
)
const SHELL_SOURCE = fs
  .readFileSync(path.join(sourceDirectory, '../../src/main/index.ts'), 'utf8')
  .replace(/\r\n/g, '\n')
const UPDATE_FEATURE_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/renderer/src/features/updates/state.ts'),
  'utf8'
)
const PRELOAD_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/preload/index.ts'),
  'utf8'
)
const BRIDGE_TYPES_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/renderer/src/global.d.ts'),
  'utf8'
)
const BROWSER_BRIDGE_SOURCE = fs.readFileSync(
  path.join(sourceDirectory, '../../src/renderer/src/app/browser.ts'),
  'utf8'
)
const UPDATE_PANEL_SOURCE = fs
  .readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/components/business/UpdatePanel.tsx'
    ),
    'utf8'
  )
  .replace(/\r\n/g, '\n')
const ACCOUNT_PANEL_SOURCE = fs
  .readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/components/business/AccountPanel.tsx'
    ),
    'utf8'
  )
  .replace(/\r\n/g, '\n')
  .replace(/\r\n/g, '\n')
const PRODUCT_POLICY = JSON.parse(
  fs.readFileSync(path.join(sourceDirectory, '../../resources/product.json'))
)
const DEFAULT_RUNTIME_POLICY = PRODUCT_POLICY.runtimes[PRODUCT_POLICY.default_runtime]
const REVIEWED_BINARIES = {
  codex: {
    executable_sha256: 'a'.repeat(64),
    reported_version: '0.999.0',
    source: {
      package: '@openai/codex',
      distribution: 'verified-download',
      archive_sha256: 'b'.repeat(64),
      integrity: 'sha512-fixture',
    },
  },
}

function noticesFixture(context) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-notices-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const original = path.resolve(sourceDirectory, '../../../..')
  const desktop = path.join(repo, 'apps', 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  fs.copyFileSync(path.join(original, 'uv.lock'), path.join(repo, 'uv.lock'))
  fs.copyFileSync(
    path.join(original, 'apps', 'desktop', 'package-lock.json'),
    path.join(desktop, 'package-lock.json')
  )
  const notices = path.join(desktop, 'resources', 'notices')
  fs.cpSync(path.join(original, 'apps', 'desktop', 'resources', 'notices'), notices, {
    recursive: true,
  })
  return { repo, desktop, notices, resources: path.join(repo, 'staged') }
}

test('reviewed notices match locked Python and build dependencies and stage without network', (context) => {
  const fixture = noticesFixture(context)
  const expected = verifyInputs(fixture.repo)
  assert.deepEqual(stageNotices(fixture.repo, fixture.resources), expected)
  assert.deepEqual(verifyNotices(fixture.resources, expected), expected)
  assert.ok(expected.some((file) => file.path === 'README.md'))
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.notices, 'manifest.json')))
  const pillow = manifest.components.find((component) => component.name === 'pillow')
  assert.deepEqual(
    pillow.artifacts.map((artifact) => artifact.platform).sort(),
    Object.keys(TARGETS).sort()
  )
  for (const name of ['pypdf', 'pycparser']) {
    const component = manifest.components.find((item) => item.name === name)
    assert.equal(component.license, 'BSD-3-Clause')
    assert.equal(component.artifacts[0].platform, 'any')
    const license = fs.readFileSync(
      path.join(fixture.notices, component.artifacts[0].licenseFile),
      'utf8'
    )
    assert.match(license, /Redistribution and use in source and binary forms/)
    assert.match(license, /ANY EXPRESS OR IMPLIED WARRANTIES/)
  }
  assert.ok(
    PACKAGE.build.extraResources.some(
      (entry) => entry.from === 'resources/notices' && entry.to === 'notices'
    )
  )
})

test('notice input verification rejects Python version drift with CRLF lockfiles', (context) => {
  const fixture = noticesFixture(context)
  const filename = path.join(fixture.repo, 'uv.lock')
  const text = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
  fs.writeFileSync(filename, text.replaceAll('\n', '\r\n'))
  assert.doesNotThrow(() => verifyInputs(fixture.repo))
  fs.writeFileSync(
    filename,
    text
      .replace(/name = "certifi"\nversion = "[^"]+"/, 'name = "certifi"\nversion = "0.0.0"')
      .replaceAll('\n', '\r\n')
  )
  assert.throws(() => verifyInputs(fixture.repo), /notice version differs from lock: certifi/)
})

test('notice input verification rejects npm version and integrity drift', (context) => {
  const fixture = noticesFixture(context)
  const filename = path.join(fixture.desktop, 'package-lock.json')
  const lock = JSON.parse(fs.readFileSync(filename))
  const original = lock.packages['node_modules/lightningcss'].version
  lock.packages['node_modules/lightningcss'].version = '0.0.0'
  fs.writeFileSync(filename, JSON.stringify(lock))
  assert.throws(() => verifyInputs(fixture.repo), /notice version differs from lock: lightningcss/)
  lock.packages['node_modules/lightningcss'].version = original
  lock.packages['node_modules/lightningcss'].integrity = 'sha512-changed'
  fs.writeFileSync(filename, JSON.stringify(lock))
  assert.throws(() => verifyInputs(fixture.repo), /notice artifact differs from lock/)
})

test('notice input verification rejects missing license and source evidence', (context) => {
  const fixture = noticesFixture(context)
  const filename = path.join(fixture.notices, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(filename))
  const original = JSON.stringify(manifest)
  manifest.components[0].source.sha256 = ''
  fs.writeFileSync(filename, JSON.stringify(manifest))
  assert.throws(() => verifyInputs(fixture.repo), /notice requires versioned source evidence/)
  fs.writeFileSync(filename, original)
  fs.unlinkSync(path.join(fixture.notices, manifest.components[0].artifacts[0].licenseFile))
  assert.throws(() => verifyInputs(fixture.repo), /notice license missing or changed/)
})

test('notice artifact verification rejects missing, changed and extra files on either platform layout', (context) => {
  const fixture = noticesFixture(context)
  for (const resources of [
    path.join(fixture.repo, 'Application.app', 'Contents', 'Resources'),
    path.join(fixture.repo, 'windows-unpacked', 'resources'),
  ]) {
    const expected = stageNotices(fixture.repo, resources)
    const filename = path.join(resources, 'notices', 'README.md')
    const original = fs.readFileSync(filename)
    fs.writeFileSync(filename, 'changed')
    assert.throws(() => verifyNotices(resources, expected), /packaged notices differ/)
    fs.unlinkSync(filename)
    assert.throws(() => verifyNotices(resources, expected), /packaged notices differ/)
    fs.writeFileSync(filename, original)
    fs.writeFileSync(path.join(resources, 'notices', 'extra.txt'), 'unexpected')
    assert.throws(() => verifyNotices(resources, expected), /packaged notices differ/)
  }
  assert.throws(() => verifyNotices(fixture.resources), /missing frozen notices inventory/)
})

test('notice input verification requires the source guide and the liblzma correction', (context) => {
  const fixture = noticesFixture(context)
  const guide = path.join(fixture.notices, 'README.md')
  const original = fs.readFileSync(guide)
  fs.unlinkSync(guide)
  assert.throws(() => verifyInputs(fixture.repo), /notice document missing/)
  fs.writeFileSync(guide, original)
  fs.unlinkSync(path.join(fixture.notices, 'xz-0bsd.txt'))
  assert.throws(() => verifyInputs(fixture.repo), /notice supplement missing or changed/)
})

test('notice input verification rejects Python source and artifact hash drift', (context) => {
  const fixture = noticesFixture(context)
  const filename = path.join(fixture.notices, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(filename))
  const sourceHash = manifest.components[0].source.sha256
  manifest.components[0].source.sha256 = 'a'.repeat(64)
  fs.writeFileSync(filename, JSON.stringify(manifest))
  assert.throws(() => verifyInputs(fixture.repo), /notice source differs from lock/)
  manifest.components[0].source.sha256 = sourceHash
  manifest.components[0].artifacts[0].sha256 = 'a'.repeat(64)
  fs.writeFileSync(filename, JSON.stringify(manifest))
  assert.throws(() => verifyInputs(fixture.repo), /notice artifact differs from lock/)
})

test('product version identifiers are retained and no Skillhub baseline is required', () => {
  // 开源版技能源码随仓库开源: 不再需要 --previous/--initial 声明交付基线。
  const parsed = options([
    '--version',
    '0.1.1',
    '--platform',
    'darwin',
    '--arch',
    'arm64',
    '--stage',
    'dir',
  ])
  assert.equal(parsed.version, '0.1.1')
  assert.equal(parsed.stage, 'dir')
  assert.equal(options([]).stage, options([]).target.installer)
  assert.equal(options([]).type, 'dev')
  assert.match(options([]).version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(BUILD_TYPES.dev, { lane: 'local', channel: 'preview', signed: false })
  assert.deepEqual(BUILD_TYPES.preview, { lane: 'distribution', channel: 'preview', signed: true })
  assert.deepEqual(BUILD_TYPES.release, { lane: 'distribution', channel: 'release', signed: true })
})
test('the build stamp is a separate field, never folded into the version', () => {
  // 旧形态把构建时间塞进版本号；新规范下版本号必须是干净的三段式，
  // 否则服务端无法按 SemVer 排序，客户端也无法与 app.getVersion() 对上。
  assert.throws(() => options(['--version', 'v0.1_202608261200']), /x\.y\.z/)
  assert.throws(() => options(['--version', '0.1']), /x\.y\.z/)
  assert.throws(
    () => options(['--version', '0.1.1', '--build-number', '2026082612']),
    /build-number/
  )
  assert.equal(
    options(['--version', '0.1.1', '--build-number', '202608261200'])['build-number'],
    '202608261200'
  )
})
test('build number defaults to the Beijing stamp of the built commit', () => {
  assert.equal(buildNumberOf({ 'build-number': '202601010000' }, 'not-a-commit'), '202601010000')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).stdout.trim()
  const stamp = buildNumberOf({ 'build-number': '' }, head)
  assert.match(stamp, /^\d{12}$/)
  // Cross-check against an independent derivation: China has no DST, so Beijing
  // wall-clock is always the committer instant shifted by +8h.
  const epoch = Number(
    spawnSync('git', ['show', '-s', '--format=%ct', head], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).stdout.trim()
  )
  const expected = new Date((epoch + 8 * 3600) * 1000)
    .toISOString()
    .slice(0, 16)
    .replace(/[-T:]/g, '')
  assert.equal(stamp, expected)
})
test('result artifacts are keyed by the installer extension', () => {
  assert.deepEqual(installerArtifacts(null), {})
  assert.deepEqual(installerArtifacts({ path: '/out/scholarseed-0.1.1-darwin-arm64.dmg' }), {
    dmg: { path: '/out/scholarseed-0.1.1-darwin-arm64.dmg' },
  })
  assert.deepEqual(installerArtifacts({ path: 'C:/out/scholarseed-0.1.1-windows-amd64.exe' }), {
    exe: { path: 'C:/out/scholarseed-0.1.1-windows-amd64.exe' },
  })
})
test('packaging reads the Serve-owned default configuration', () => {
  assert.match(BUILD_SOURCE, /apps\/serve\/service\/settings\/default\.json/)
  assert.doesNotMatch(
    BUILD_SOURCE,
    /packages\/damoagent\/damoagent\/surface\/config\/default\.json/
  )
})
test('builds reject bypass flags and malformed identifiers', () => {
  assert.throws(() => options(['--no-preflight', 'yes']))
  assert.throws(() => options(['--version', '../wrong']))
  assert.throws(() => options(['--arch', 'x64']))
})
test('packaging lock replaces a stale owner and rejects a live owner', () => {
  const lock = path.join(sourceDirectory, '../../.package-lock')
  fs.rmSync(lock, { force: true })
  try {
    fs.writeFileSync(lock, '999999999')
    assert.equal(acquireMutex(), lock)
    fs.writeFileSync(lock, String(process.pid))
    assert.throws(() => acquireMutex(), /holds this worktree/)
  } finally {
    fs.rmSync(lock, { force: true })
  }
})
test('build output directory is stable per type, platform, and architecture', () => {
  const release = path.join('workspace', 'release')
  assert.equal(
    buildRunDirectory(release, { type: 'dev', platform: 'win32', arch: 'x86_64' }),
    path.join(release, 'dev-win32-x86_64')
  )
  assert.equal(
    buildRunDirectory(release, { type: 'release', platform: 'darwin', arch: 'arm64' }),
    path.join(release, 'release-darwin-arm64')
  )
})
test('Windows x64 uses Velopack and requires signing inputs unless explicitly candidate', () => {
  const base = [
    '--platform',
    'win32',
    '--arch',
    'x86_64',
    '--type',
    'preview',
    '--update-base-url',
    'https://updates.example.test',
  ]
  assert.throws(() => options(base), /windows-publisher|signing environment/i)
  const parsed = options([...base, '--candidate'])
  assert.equal(parsed.stage, 'velopack')
  assert.equal(parsed.target.triple, 'x86_64-pc-windows-msvc')
  assert.equal(parsed.target.archType, 'windows-amd64')
  assert.equal(parsed.signed, false)
  assert.equal(parsed.lane, 'distribution')
})
test('Windows signer changes only ScholarSeed-owned executables', () => {
  assert.equal(ownedExecutable('C:/app/ScholarSeed.exe'), true)
  assert.equal(ownedExecutable('C:/app/scholarseed-0.2.0-windows-amd64.exe'), true)
  assert.equal(ownedExecutable('C:/app/resources/backend/codex-runtime/bin/codex.exe'), false)
  assert.equal(ownedExecutable('C:/app/resources/backend/python/Scripts/scholarseed.exe'), false)
  assert.equal(ownedExecutable('C:/app/resources/backend/python/python.exe'), false)
  assert.equal(ownedExecutable('C:/app/resources/updater/update-owner.exe'), false)
})
test('Windows subprocess output is decoded by console code page, not blindly as UTF-8', () => {
  // bug 87042987 次生缺陷：中文 Windows 的 powershell.exe 按 GBK(936) 输出，无条件 toString('utf8')
  // 会把错误原文解成乱码。改为探测活动代码页（chcp.com 是原生 exe、不经 PowerShell，不受 CLM 影响）
  // 后用 TextDecoder 按对应标签解码；并收齐字节再整体解码，避免逐块 toString 截断跨块多字节字符。
  assert.match(SUBPROCESS_SOURCE, /chcp\.com/)
  assert.match(SUBPROCESS_SOURCE, /new TextDecoder\(/)
  assert.match(SUBPROCESS_SOURCE, /WINDOWS_CODE_PAGE_ENCODINGS/)
  assert.match(SUBPROCESS_SOURCE, /'936': 'gbk'/)
  assert.doesNotMatch(SUBPROCESS_SOURCE, /chunk\.toString\('utf8'\)/)
})
test('macOS install gate requires local Developer ID identity and offline ticket verification', () => {
  // 运行时安装门绝不再以 'spctl' 作在线评估硬门：企业管控网 TLS 拦截会让 syspolicyd 的在线公证
  // 查询失败 → Gatekeeper fail-closed 拒合法产物、每次重试必现。信任锚改为离线的同 Developer ID 身份。
  assert.doesNotMatch(UPDATER_SOURCE, /'spctl'/)
  // 离线身份锚由纯模块 codesign.ts 判定（可 node --test 直接跑），updater 只负责取 codesign -d 文本。
  assert.match(UPDATER_SOURCE, /parseCodesignIdentity/)
  assert.match(UPDATER_SOURCE, /classifyMacosTrust/)
  // 承重判据 TeamIdentifier 相等必须在纯模块里；ad-hoc 的 `not set` 一律拒。
  assert.match(CODESIGN_SOURCE, /teamIdentifier !== expected\.expectedTeamId/)
  assert.match(CODESIGN_SOURCE, /not set/)
  // 离线锚仍要求硬化运行时 + 安全时间戳 + Developer ID 链到达 Apple Root CA。
  assert.match(CODESIGN_SOURCE, /Apple Root CA/)
  assert.match(CODESIGN_SOURCE, /hardenedRuntime/)
  assert.match(UPDATER_SOURCE, /await verifyNotarization\(/)
  assert.match(UPDATER_SOURCE, /await verifyMountedNotarization\(appPath, log, installation, application\)/)
  assert.match(UPDATER_SOURCE, /native: nativeNotarization/)
  assert.doesNotMatch(UPDATER_SOURCE, /\['stapler', 'validate'/)
  assert.match(NOTARIZATION_SOURCE, /await check\.native!\.verifySignature\(check\.appPath\)/)
  assert.match(NOTARIZATION_SOURCE, /await check\.native!\.verify\(ticket, check\.hashes\)/)
  assert.match(NATIVE_NOTARIZATION_SOURCE, /kSecCSCheckAllArchitectures\s*\|\s*kSecCSCheckNestedCode\s*\|\s*kSecCSStrictValidate\s*\|\s*kSecCSNoNetworkAccess/)
  // Trust is refreshed on the exact read-only source; only the digest-bound ZIP
  // is handed to Squirrel. No writable app copy or client-side re-extraction.
  assert.match(UPDATER_SOURCE, /verifyMountedApplication\([\s\S]{0,80}source,/)
  assert.match(UPDATER_SOURCE, /PreparedArchive\.create\(/)
  assert.match(UPDATER_SOURCE, /receipt\.revalidate\(/)
  assert.doesNotMatch(UPDATER_SOURCE, /'stage application'|'inspect prepared archive'/)
  assert.doesNotMatch(UPDATER_SOURCE, /'DMG verification'/)

})
test('the updater never blocks the main process with a synchronous spawn', () => {
  // Electron 主进程与 macOS AppKit 主线程是同一个：任何 spawnSync 都会冻住事件循环，期间原生
  // 窗口控件（红绿灯）点不动。Windows 签名校验联网吊销卡住、macOS 安装链 ditto + codesign/spctl/
  // stapler 十几秒，都曾让客户端在安装期无响应（最小化/关闭失灵）。所有子进程一律走异步 runCommandAsync。
  assert.match(UPDATER_SOURCE, /runCommandAsync/)
  assert.doesNotMatch(UPDATER_SOURCE, /spawnSync\s*\(/)
  assert.doesNotMatch(SUBPROCESS_SOURCE, /spawnSync\s*\(/)
  assert.match(NATIVE_NOTARIZATION_SOURCE, /napi_create_async_work\(/)
  assert.match(NATIVE_NOTARIZATION_SOURCE, /napi_queue_async_work\(/)
  // 安全校验必须 await：漏掉会让安装先于签名校验完成（fail-open 安全洞），比卡住更糟。
  assert.match(
    NOTARIZATION_SOURCE,
    /await check\.native!\.verifySignature\(check\.appPath\)/
  )
  assert.match(
    UPDATER_SOURCE,
    /await verifyMountedApplication\(\s*source,\s*meta,\s*resolveDesktopConfig\(log\),\s*log,\s*installation,\s*'source'\s*\)/
  )
  // bug 87253073：外部命令挂起不允许把安装变成无限等待。超时/取消的强制层在唯一收口点
  // subprocess.ts —— 超时 SIGKILL 子进程并 reject，准备链每一步都声明上限。
  assert.match(SUBPROCESS_SOURCE, /timeoutMs/)
  assert.match(SUBPROCESS_SOURCE, /child\.kill\('SIGKILL'\)/)
  assert.match(UPDATER_SOURCE, /MACOS_MOUNT_COMMAND_TIMEOUT_MS/)
  assert.match(UPDATER_SOURCE, /MACOS_SIGNATURE_COMMAND_TIMEOUT_MS/)
  assert.match(
    UPDATER_SOURCE,
    /await runLoggedCommand\(\s*log,\s*'archive mounted application',\s*MACOS_DITTO,\s*archiveApplicationArguments\(source, archive\),\s*\{\s*timeoutMs:\s*MACOS_ARCHIVE_TIMEOUT_MS\b/
  )
})
test('runtime store 收敛为 <home>/runtime，独立覆盖轴已删除（proposal 112）', () => {
  // 旧组件 store 根解析口在 components.cjs；backend 经
  // runtimeStoreRoot(desktopHome()) 取 <home>/runtime，不再有 SCHOLARSEED_RUNTIME_STORE 覆盖档。
  assert.match(DESKTOP_BACKEND_SOURCE, /computeRuntimeStoreRoot\(desktopHome\(\)\)/)
  assert.doesNotMatch(DESKTOP_BACKEND_SOURCE, /resolveRuntimeStoreRoot/)
  assert.doesNotMatch(COMPONENTS_CJS_SOURCE, /SCHOLARSEED_RUNTIME_STORE/)
  assert.doesNotMatch(COMPONENTS_CJS_SOURCE, /RUNTIME_STORE_ENV/)
  assert.match(
    COMPONENTS_CJS_SOURCE,
    /function runtimeStoreRoot\(home\) \{\s*return path\.join\(home, RUNTIME_DIRNAME\)/
  )
  // .cmd 继承解释器的输出由 components.test.cjs 验证，
  // 此处只保证源码不再残留覆盖档常量。
})
test('data location is runtime read-only; container root is the only runtime-mutable axis (proposal 112)', () => {
  // 桥：storage-config 只读概览（含首启门控 firstLaunchEligible）+ commit-data-home 仅首启一次性
  // 「高级」消费；设置页「数据存储」home 只读 + 容器根可改；关于页不承载任何设置。
  assert.match(SHELL_SOURCE, /ipcMain\.handle\('scholarseed:storage-config'/)
  assert.match(SHELL_SOURCE, /firstLaunchEligible: canCommitDataHome\(storageNative\)/)
  assert.match(SHELL_SOURCE, /ipcMain\.handle\('scholarseed:commit-data-home'/)
  assert.match(DESKTOP_BACKEND_SOURCE, /export function runtimeStoreRoot\(\): string \{/)
  assert.match(PRELOAD_SOURCE, /ipcRenderer\.invoke\('scholarseed:storage-config'\)/)
  assert.match(PRELOAD_SOURCE, /ipcRenderer\.invoke\('scholarseed:commit-data-home', parent\)/)
  const GLOBAL_D_SOURCE = fs.readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/global.d.ts'),
    'utf8'
  )
  assert.match(GLOBAL_D_SOURCE, /storageConfig: \(\) => Promise<StorageConfig>/)
  assert.match(
    GLOBAL_D_SOURCE,
    /commitDataHome: \(parent: string\) => Promise<CommitDataHomeResult>/
  )
  const BROWSER_SOURCE = fs.readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/browser.ts'),
    'utf8'
  )
  assert.match(BROWSER_SOURCE, /import \{ createBrowserBridge \} from '\.\/app\/browser'/)
  assert.match(BROWSER_SOURCE, /window\.scholarseed = createBrowserBridge\(/)
  assert.match(BROWSER_BRIDGE_SOURCE, /storageConfig: async \(\)/)
  assert.match(BROWSER_BRIDGE_SOURCE, /firstLaunchEligible: false/)
  const ACCOUNT_PANEL_SOURCE = fs.readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/components/business/AccountPanel.tsx'
    ),
    'utf8'
  )
  // 关于页只读：版本/官方入口/引导，不得承载数据位置设置或任何改路径控件。
  const aboutPage = ACCOUNT_PANEL_SOURCE.match(/function AboutPage\(\)[\s\S]*?\nfunction /)
  assert.ok(aboutPage, 'AboutPage function not found')
  assert.doesNotMatch(aboutPage[0], /storageConfig|commitDataHome|pickDir|dataHome/)
  // 「数据存储」页：home 行只读（无更改按钮）+ 安装期说明；容器根行可改 + 重启/失败提示。
  const storagePage = ACCOUNT_PANEL_SOURCE.match(/function DataStoragePage\(\)[\s\S]*?\nfunction /)
  assert.ok(storagePage, 'DataStoragePage function not found')
  assert.match(storagePage[0], /data-testid="storage-data-home"/)
  assert.match(storagePage[0], /t\('accountPanel\.storage\.dataHomeDescription'\)/)
  assert.doesNotMatch(storagePage[0], /commitDataHome/)
  assert.match(storagePage[0], /t\('accountPanel\.storage\.installTimeNoteWin'\)/)
  assert.match(storagePage[0], /data-testid="storage-container-root-change"/)
  assert.match(storagePage[0], /saveWorkspaceRoot\(picked\)/)
  assert.match(storagePage[0], /data-testid="storage-container-root-restart"/)
  assert.match(storagePage[0], /data-testid="storage-container-root-failed"/)
  // 首启一次性「高级」入口：独立组件，四条件门控 + storageFirstLaunchSeen 消费一次。
  const FIRST_LAUNCH_SOURCE = fs.readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/components/business/StorageFirstLaunch.tsx'
    ),
    'utf8'
  )
  assert.match(FIRST_LAUNCH_SOURCE, /storage\.firstLaunchEligible/)
  assert.match(FIRST_LAUNCH_SOURCE, /window\.scholarseed\.commitDataHome/)
  assert.match(FIRST_LAUNCH_SOURCE, /storageFirstLaunchSeen: true/)
  const APP_SOURCE = fs.readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/App.tsx'),
    'utf8'
  )
  assert.match(APP_SOURCE, /<StorageFirstLaunchDialog \/>/)
  // 容器根入口不再埋在项目侧栏（原 bug 痛点），设置页为唯一配置面。
  const PROJECT_PANEL_SOURCE = fs.readFileSync(
    path.join(sourceDirectory, '../../src/renderer/src/features/project/ProjectPanel.tsx'),
    'utf8'
  )
  assert.doesNotMatch(
    PROJECT_PANEL_SOURCE,
    /project-root-browse|project-root-input|saveWorkspaceRoot/
  )
})
// ── 更新面三条不变量（bug 86968393）─────────────────────────────────────────
// updater.ts / index.ts 都导不进 node --test（依赖 electron 与无扩展名相对导入），
// 所以这三条按源码形状钉住；行为本身由渲染层纯函数测试与真实产品验收覆盖。

test('the shell never discards the staged package before the install result is known', () => {
  // 启动安装器不等于安装成功；macOS 保留 Squirrel 交接记录，直到启动观察到目标构建。
  // initialUpdateSnapshot 根据实际运行身份收口，结果未知时保留恢复所需状态。
  assert.doesNotMatch(SHELL_SOURCE, /clearReadyState/)
  assert.match(UPDATER_SOURCE, /export function clearReadyState/)
})

test('discovery keeps newer builds available without discarding a macOS ready package', () => {
  assert.match(SHELL_SOURCE, /const updatePreparation = new UpdatePreparation/)
  assert.match(SHELL_SOURCE, /updatePreparation\.offer\(latest\)/)
  assert.match(SHELL_SOURCE, /updatePreparation\.observe\(latest\)/)
  assert.match(SHELL_SOURCE, /updatePreparation\.background\(enabled\)/)
  assert.match(SHELL_SOURCE, /snapshot\.latestCandidate \?\? snapshot\.candidate/)
  assert.match(
    SHELL_SOURCE,
    /if \(!preparationPolicy\) updater\.supersedeStagedUpdate\(candidate, pushLog\)/
  )
  assert.match(
    SHELL_SOURCE,
    /if\s*\(\s*updateInstallAbort\s*\|\|\s*updateInstallationInProgress\s*\|\|\s*updateRestartRequested\s*\|\|\s*macMaintenanceUncertain\s*\|\|\s*updater\.macHandoffCommitted\(\)\s*\|\|\s*snapshot\.phase === 'manual'\s*\|\|\s*snapshot\.errorFallback === 'activation_recovery_required'\s*\)/
  )

  // 推进判定只此一份：启动期检查、周期复查、手动「检查更新」三个入口共用，才不会一个能
  // 推进另一个不能。
  assert.match(SHELL_SOURCE, /function publishUpdateCheckResult\(result: UpdateCheckResult\)/)
  assert.match(
    SHELL_SOURCE,
    /const result = await updateChecks\.run\(\)\n      return publishUpdateCheckResult\(result\)/
  )
  assert.match(
    SHELL_SOURCE,
    /void updateChecks\n\s*\.run\(\)\n\s*\.then\(\(result\) => \{\n\s*publishUpdateCheckResult\(result\)/
  )

  // 只有线上候选**严格**新于暂存包才推进；排不出先后（身份串不合契约，isNewerRelease 回 null）
  // 一律不动，已经下好并校验过的那一个继续有效。
  assert.match(UPDATER_SOURCE, /export function supersedeStagedUpdate\(/)
  assert.match(UPDATER_SOURCE, /if \(newer !== true\) return false/)
  // 取代时记录与包体一起回收：只清记录会让几百 MB 一直躺在磁盘上，只删包体会让下一次启动
  // 因为记录还在而重新认领它。
  assert.match(
    UPDATER_SOURCE,
    /function dropStagedUpdate\(staged: ReadyState, log: LogSink\): void \{\n  clearReadyState\(\)\n  removeStaleInstaller\(staged\.path, log\)/
  )
  assert.match(UPDATER_SOURCE, /dropStagedUpdate\(staged, log\)\n  return true/)

  // Same-candidate checks preserve an install failure; a newer candidate may prepare.
  assert.match(
    SHELL_SOURCE,
    /if \(snapshot\.phase === 'ready' && snapshot\.candidate\?\.id === latest\.id\)/
  )
  assert.match(SHELL_SOURCE, /updatePreparation\.adopt\(latest\)/)
})

test('preparation reports success only for the requested ready identity', () => {
  assert.match(SHELL_SOURCE, /ok: prepared\.phase === 'ready' && prepared\.candidate\?\.id === id/)
})

test('checkpoint failures retain a real ready package instead of routing it to download', () => {
  assert.match(
    SHELL_SOURCE,
    /failed: \(error\) => \{[\s\S]*?const retained = preparationPolicy \? retainedUpdateReady\(\) : null[\s\S]*?phase: retained \? 'ready' : 'failed',[\s\S]*?candidate: retained\?\.meta \?\? currentUpdateSnapshot\(\)\.candidate/
  )
  assert.match(SHELL_SOURCE, /function retainedUpdateReady\(\)[\s\S]*?updater\.readReadyState\(\)[\s\S]*?updater\.previewCandidateValidated\(ready\.meta, pushLog\)/)
})

test('the renderer holds no cross-restart update state', () => {
  // 窗口 origin 含后端随机端口（listen(0)），localStorage 按 origin 分区：写在渲染层的
  // 「弹窗已收起」每次启动都读不回来，更新内容弹窗会反复自动弹。
  assert.doesNotMatch(
    UPDATE_FEATURE_SOURCE,
    /localStorage\s*\.\s*(getItem|setItem|removeItem|clear)/
  )
  assert.match(UPDATE_FEATURE_SOURCE, /state\?\.announcedKey === key/)
  assert.match(UPDATER_SOURCE, /ANNOUNCED_STATE_FILE = 'announced\.json'/)
})

test('every snapshot the shell publishes carries the announcement acknowledgement', () => {
  // 部分发布点是新构造的对象而不是展开当前快照；漏盖一次就等于把用户的确认丢掉。
  assert.match(
    SHELL_SOURCE,
    /function publishUpdateSnapshot\([^\n)]*\): UpdateSnapshot \{\s*const stamped = withAnnouncedKey\(\{\s*\.\.\.next,[\s\S]*?\brestartPending:[\s\S]*?\}\)\s*updateSnapshot = stamped\s*sendToMainWindow\('scholarseed:update-state', stamped\)/
  )
  assert.match(SHELL_SOURCE, /updateSnapshot = withAnnouncedKey\(/)
  assert.match(SHELL_SOURCE, /scholarseed:update-announce-ack/)
})

test('progress publication clears the previous failure so a retry is not shown as failed', () => {
  // 「有 error 即失败呈现」这条判据成立的前提：成功路径必须把上一次失败的三个字段一起清掉。
  // errorOrigin 漏清不会立刻出错，但会让下一次失败沿用上一次的动作来源、报错误的文案。
  assert.match(
    SHELL_SOURCE,
    /function publishUpdateProgress[\s\S]{0,500}error: undefined,\n    errorFallback: undefined,\n    errorOrigin: undefined,\n    resumable: undefined/
  )
  // 三个动作各自标注来源，展示侧不从相位或 error 文本反推。安装动作的来源由
  // failure.ts:updateInstallFailure 与 updater.ts 的回滚快照给出，failure.test.ts 直接钉住。
  assert.match(SHELL_SOURCE, /errorOrigin: 'check'/)
  assert.match(SHELL_SOURCE, /errorOrigin: 'download'/)
  assert.match(SHELL_SOURCE, /updateInstallFailure\(result\)/)
  assert.match(UPDATER_SOURCE, /errorOrigin: 'install'/)
})

test('opening an update surface refreshes silently through the background check path', () => {
  // 上一次检查与用户点「重启完成更新」之间的窗口（上界 = 30min 周期复查间隔）里发布的新包，
  // 会让安装点击装掉旧包、重启后才发现新的（Aone 87009973 修复后的残留窗口）。收敛方式：
  // 更新表面打开时静默刷新一次，把状态在用户点安装**之前**刷新到位，安装点击保持秒级可预测。
  //
  // 必须复用背景检查路径而不是手动 update-check：后者先设 'checking' 相位，
  // updateActionOf('checking') = 'none'，ready 相位的安装按钮会当场消失再出现。
  // 静默路径的投影仍是 publishUpdateCheckResult 那一份（in-flight 闸、安装失败结果保护、
  // supersede、announcedKey 保留全部生效），刷新天然安全。
  assert.match(
    SHELL_SOURCE,
    /ipcMain\.handle\('scholarseed:update-refresh', \(\): void => \{\n    runBackgroundUpdateCheck\(\)\n  \}\)/
  )

  // 三个安装入口一个都不能漏。UpdatePanel 挂载 == 卡片被打开：工作台活动栏火箭与 0.1 侧栏
  // 药丸两个入口表面都只在展开时渲染它，挂这一处即同时覆盖；AccountPanel 关于页自带
  // 「重启安装」按钮且不渲染 UpdatePanel，必须单独挂。空依赖数组钉住「只在挂载时刷一次」，
  // 每次 render 都发一遍检查不是本不变量的语义。
  const mountRefresh =
    /React\.useEffect\(\(\) => \{\n    void window\.scholarseed\.refreshUpdate\(\)\n  \}, \[\]\)/
  assert.match(UPDATE_PANEL_SOURCE, mountRefresh)
  assert.match(ACCOUNT_PANEL_SOURCE, mountRefresh)

  // 桥接三件套缺一 typecheck 红：preload 实现、typed contract、浏览器模式桩。
  // web 形态没有更新通路（恒 upToDate、从不带候选包），静默刷新如实无操作。
  assert.match(PRELOAD_SOURCE, /ipcRenderer\.invoke\('scholarseed:update-refresh'\)/)
  assert.match(BRIDGE_TYPES_SOURCE, /refreshUpdate: \(\) => Promise<void>/)
  assert.match(BROWSER_BRIDGE_SOURCE, /refreshUpdate: async \(\) => \{\},/)
})

test('macOS candidates do not require signing credentials', () => {
  const parsed = options([
    '--platform',
    'darwin',
    '--arch',
    'arm64',
    '--type',
    'preview',
    '--candidate',
    '--update-base-url',
    'https://updates.example.test',
  ])
  assert.equal(parsed.signed, false)
  assert.equal(parsed.candidate, true)
})

test('macOS runtime verification rejects a seal modified by package check without repeating notarization', async () => {
  const filename = path.join(sourceDirectory, 'verify.cjs')
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const declarations = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement) &&
    ['verifyApplication', 'verifyMacSeal'].includes(statement.name?.text)).map(statement => statement.getText(parsed)).join('\n')
  let sealed = true
  let trustChecks = 0
  let structuralChecks = 0
  let mutate = true
  let refuseTrust = false
  let contentChecks = 0
  const verify = runInNewContext(`${declarations}\nverifyApplication`, {
    verifyIdentity() {}, unsignedPackageCheck: () => false,
    layout: () => ({ resources: '/fixture/resources' }),
    verifyExecution: async () => ({ status: 'passed' }),
    verifyContent: async () => {
      contentChecks += 1
      assert.ok(trustChecks > 0, 'Gatekeeper assessment must precede bundled executable probes')
      return { current: {}, imports: {}, browser: {}, closure: {} }
    },
    macTrust() { trustChecks += 1; assert.equal(sealed, true); if (refuseTrust) throw new Error('policy denied'); return { signature: 'ad-hoc' } },
    runPackageCheck: async () => { if (mutate) sealed = false; return { ok: true } },
    spawnSync(executable, args) {
      assert.equal(executable, 'codesign')
      assert.deepEqual(Array.from(args), ['--verify', '--deep', '--strict', '/fixture/ScholarSeed.app'])
      structuralChecks += 1
      return { status: sealed ? 0 : 1 }
    },
  })
  const frozen = { platform: 'darwin', signingRequired: false }
  await assert.rejects(verify('/fixture/ScholarSeed.app', frozen, true), /structural codesign/)
  assert.equal(trustChecks, 1)
  assert.equal(structuralChecks, 1)
  sealed = true
  mutate = false
  assert.equal((await verify('/fixture/ScholarSeed.app', frozen, true)).signature_valid, true)
  assert.equal(trustChecks, 2)
  assert.equal(structuralChecks, 2)
  refuseTrust = true
  await assert.rejects(verify('/fixture/ScholarSeed.app', frozen, true), /policy denied/)
  assert.equal(contentChecks, 2, 'rejected trust must not execute package contents')
})

test('macOS candidate dir checks stop before codesigning', () => {
  assert.equal(
    unsignedPackageCheck({
      platform: 'darwin',
      stage: 'dir',
      candidate: true,
      signingRequired: false,
    }),
    true
  )
  assert.equal(
    unsignedPackageCheck({
      platform: 'darwin',
      stage: 'dmg',
      candidate: true,
      signingRequired: false,
    }),
    false
  )
  assert.equal(
    unsignedPackageCheck({
      platform: 'win32',
      stage: 'dir',
      candidate: true,
      signingRequired: false,
    }),
    false
  )
})

test('npm package check maps to unsigned dir build without signing credentials', () => {
  const args = desktopPackage.buildArguments('check')
  assert.equal(args[args.indexOf('--stage') + 1], 'dir')
  assert.equal(args[args.indexOf('--type') + 1], 'release')
  assert.ok(args.includes('--candidate'))
  assert.equal(args[args.indexOf('--update-base-url') + 1], 'https://updates.example.com/')
  assert.equal(args.includes('--team-id'), false)
  assert.equal(args.includes('--windows-publisher'), false)
})

test('package channel selection emits one type and preserves candidate safety', () => {
  for (const channel of ['preview', 'release']) {
    const args = desktopPackage.buildArguments('check', ['--channel', channel])
    assert.equal(args.filter(argument => argument === '--type').length, 1)
    assert.equal(args[args.indexOf('--type') + 1], channel)
    assert.equal(args.includes('--channel'), false)
    assert.equal(args.includes('--candidate'), true)
    assert.equal(args.includes('--team-id'), false)
    assert.equal(args.includes('--windows-publisher'), false)
  }
  assert.throws(() => desktopPackage.buildArguments('package', ['--channel', 'preview']), /release or check only/)
  assert.throws(() => desktopPackage.buildArguments('check', ['--channel', 'preview', '--channel', 'release']), /supported once/)
  assert.throws(() => desktopPackage.buildArguments('package', ['--type', 'release']), /type is owned/)
})

test('preview release channel retains mandatory distribution credentials', () => {
  const keys = ['SCHOLARSEED_UPDATE_BASE_URL', 'SCHOLARSEED_MACOS_TEAM_ID', 'APPLE_TEAM_ID', 'SCHOLARSEED_WINDOWS_SIGN_PUBLISHER']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) delete process.env[key]
    assert.throws(() => desktopPackage.buildArguments('release', ['--channel', 'preview']), /SCHOLARSEED_UPDATE_BASE_URL/)
    process.env.SCHOLARSEED_UPDATE_BASE_URL = 'https://updates.example.test/'
    process.env.SCHOLARSEED_MACOS_TEAM_ID = 'ABCDEFGHIJ'
    process.env.SCHOLARSEED_WINDOWS_SIGN_PUBLISHER = 'Test Publisher'
    if (['darwin', 'win32'].includes(process.platform)) {
      const args = desktopPackage.buildArguments('release', ['--channel', 'preview'])
      assert.equal(args.filter(argument => argument === '--type').length, 1)
      assert.equal(args[args.indexOf('--type') + 1], 'preview')
      assert.equal(args.includes('--candidate'), false)
      assert.equal(args.includes(process.platform === 'darwin' ? '--team-id' : '--windows-publisher'), true)
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

test('npm release build requires CI-injected update and signing metadata', () => {
  const previousUpdate = process.env.SCHOLARSEED_UPDATE_BASE_URL
  const previousTeam = process.env.SCHOLARSEED_MACOS_TEAM_ID
  const previousAppleTeam = process.env.APPLE_TEAM_ID
  try {
    delete process.env.SCHOLARSEED_UPDATE_BASE_URL
    delete process.env.SCHOLARSEED_MACOS_TEAM_ID
    delete process.env.APPLE_TEAM_ID
    assert.throws(() => desktopPackage.buildArguments('release'), /SCHOLARSEED_UPDATE_BASE_URL/)
    process.env.SCHOLARSEED_UPDATE_BASE_URL = 'https://updates.example.test/'
    if (process.platform === 'darwin') {
      process.env.SCHOLARSEED_MACOS_TEAM_ID = 'ABCDEFGHIJ'
      const args = desktopPackage.buildArguments('release')
      assert.equal(args[args.indexOf('--stage') + 1], 'installer')
      assert.equal(args[args.indexOf('--team-id') + 1], 'ABCDEFGHIJ')
    }
  } finally {
    if (previousUpdate === undefined) delete process.env.SCHOLARSEED_UPDATE_BASE_URL
    else process.env.SCHOLARSEED_UPDATE_BASE_URL = previousUpdate
    if (previousTeam === undefined) delete process.env.SCHOLARSEED_MACOS_TEAM_ID
    else process.env.SCHOLARSEED_MACOS_TEAM_ID = previousTeam
    if (previousAppleTeam === undefined) delete process.env.APPLE_TEAM_ID
    else process.env.APPLE_TEAM_ID = previousAppleTeam
  }
})

test('distribution inputs require only an update URL', () => {
  const base = [
    '--type',
    'release',
    '--candidate',
    '--update-base-url',
    'https://updates.example.test',
  ]
  const parsed = options(base)
  assert.equal(parsed.lane, 'distribution')
  assert.equal(Object.hasOwn(parsed, 'verification'), false)
  assert.equal(parsed.candidate, true)
  assert.throws(
    () =>
      options(
        base.map((value) =>
          value === 'https://updates.example.test' ? 'http://updates.example.test' : value
        )
      ),
    /HTTPS/
  )
  assert.throws(
    () =>
      options(
        base.filter(
          (value, index) => base[index - 1] !== '--update-base-url' && value !== '--update-base-url'
        )
      ),
    /require/
  )
})
test('credentials do not reach offline child builds', () => {
  const source = {
    PATH: '/bin',
    SCHOLARSEED_SKILLHUB_TOKEN: 'fixture',
    SCHOLARSEED_SKILLHUB_TOKEN_FILE: '/fixture',
    SCHOLARSEED_WINDOWS_SIGN_KEY: 'signing-secret',
    SCHOLARSEED_HOME: '/runtime',
    SCHOLARSEED_UPDATE_PAYLOAD_PRIVATE_KEY: '/secret/key.pem',
  }
  assert.deepEqual(credentialFreeEnv(source), { PATH: '/bin', SCHOLARSEED_HOME: '/runtime' })
  assert.equal(source.SCHOLARSEED_SKILLHUB_TOKEN, 'fixture')
  assert.equal(source.SCHOLARSEED_WINDOWS_SIGN_KEY, 'signing-secret')
})
test('DMG builds require the locked local executable and never fall back to a download', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-dmgbuild-'))
  const executable = path.join(directory, 'dmgbuild')
  try {
    assert.throws(() => localDmgbuild(directory, '1.6.7'), /ENOENT/)
    fs.writeFileSync(executable, '')
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
    assert.throws(() => localDmgbuild(directory, '1.6.6'), /not the locked/)
    assert.equal(localDmgbuild(directory, '1.6.7'), executable)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})
test('builder evidence resolves the selected Electron Builder dependency graph without hoisting', async () => {
  const manifest = require.resolve('electron-builder/package.json', { paths: [path.resolve(sourceDirectory, '../..')] })
  const owner = createRequire(manifest)
  const library = owner.resolve('app-builder-lib/package.json')
  const evidence = builderEvidence()
  assert.equal(evidence.resolvedVersion, JSON.parse(fs.readFileSync(library, 'utf8')).version)
})

test('Electron Builder template rendering remains compatible with the EJS override', () => {
  const manifest = require.resolve('electron-builder/package.json', { paths: [path.resolve(sourceDirectory, '../..')] })
  const owner = createRequire(manifest)
  const library = owner.resolve('app-builder-lib/package.json')
  const { compile } = createRequire(library)('ejs')
  const builder = path.dirname(library)
  const source = fs.readFileSync(path.join(builder, 'templates', 'msi', 'template.xml'), 'utf8')
  const template = source
    .replace(/{{/g, '<%')
    .replace(/}}/g, '%>')
    .replace(/\${([^}]+)}/g, '<%=$1%>')
  assert.equal(typeof compile(template), 'function')
})
test('installed dependency probes receive only product and system executable roots', () => {
  if (process.platform === 'win32') {
    const joined = productPath('/app/python/bin', '/app/bin')
    const parts = joined.split(path.delimiter)
    assert.deepEqual(parts.slice(0, 2), ['/app/python/bin', '/app/bin'])
    const system = String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
    assert.deepEqual(parts.slice(2), system)
  } else {
    assert.equal(
      productPath('/app/python/bin', '/app/bin'),
      '/app/python/bin:/app/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    )
  }
})
test('bundled workspace distributions are installed only from immutable wheels', () => {
  assert.match(BUNDLE_BACKEND_SOURCE, /'runtime', 'packages\/runtime'/)
  assert.doesNotMatch(BUNDLE_BACKEND_SOURCE, /packages\/damoagent/)
  const wheelSource = fs.readFileSync(path.join(sourceDirectory, 'wheels.cjs'), 'utf8')
  const assemblySource = fs.readFileSync(path.join(sourceDirectory, 'assembly.cjs'), 'utf8')
  assert.match(wheelSource, /'scripts\/cd\/wheel\.py'/)
  assert.match(wheelSource, /'--builder', 'pip'/)
  assert.match(assemblySource, /'pip', 'sync'/)
  assert.match(assemblySource, /'--require-hashes'/)
  assert.match(BUNDLE_BACKEND_SOURCE, /'--no-deps', '--no-index'/)
  assert.match(VERIFY_SOURCE, /frozen\.pythonDependencies\.inventory_sha256/)
  assert.match(VERIFY_SOURCE, /VERIFIER_FILENAME\),\s*'verify'/)
  assert.match(assemblySource, /--no-sources/)
  assert.doesNotMatch(BUNDLE_BACKEND_SOURCE, /uv_bin" pip install[\s\S]*"\$pkg"/)
  // editable 残留断言随探针脚本移入 probe.cjs（bundle.cjs 经 RUNTIME_PROBE_SCRIPT 执行）
  assert.match(PROBE_SOURCE, /__editable__/)
  assert.match(PROBE_SOURCE, /direct_url\.json/)
  assert.match(BUNDLE_BACKEND_SOURCE, /RUNTIME_PROBE_SCRIPT/)
  assert.doesNotMatch(BUNDLE_BACKEND_SOURCE, /shell: process\.platform/)
})
test('artifact verification imports the packaged runtime and starts its real health endpoint', () => {
  for (const moduleName of [
    'scholarseed_runtime',
    'damoatrace',
    'service.cli.serve',
    'scholarseed_codex',
  ]) {
    assert.match(RUNTIME_PROBE_SCRIPT, new RegExp(moduleName.replaceAll('.', '\\.')))
  }
  assert.match(RUNTIME_PROBE_SCRIPT, /is_relative_to/)
  assert.match(VERIFY_SOURCE, /--package-check/)
  assert.match(VERIFY_SOURCE, /payload\.backend/)
  assert.match(VERIFY_SOURCE, /payload\.renderer/)
  assert.match(VERIFY_SOURCE, /SCHOLARSEED_PRODUCT_MANIFEST: required\[6\]/)
  assert.match(VERIFY_SOURCE, /createPackageCheckDirectory\(frozen\)/)
})
test('package-check requires an ordered, normal backend exit for the same instance', () => {
  const lines = [
    '2026-10-05T13:00:00.000Z pid=42 [shell] backend ready pid=43 port=55328',
    '2026-10-05T13:00:01.000Z pid=42 [shell] backend stop requested pid=43 port=55328 quitting=true installing=false restarting=false',
    '2026-10-05T13:00:02.790Z pid=42 [shell] backend exited code=0 signal=null',
    '2026-10-05T13:00:02.900Z pid=42 [shell] will quit; draining log writes',
  ]
  for (const newline of ['\n', '\r\n']) {
    assert.deepEqual(packageShutdownReceipt(lines.join(newline)), {
      code: 0,
      signal: null,
      elapsed_ms: 1790,
    })
  }
  const normal = lines.join('\n')
  for (const failed of [
    '',
    lines.slice(0, 2).join('\n'),
    lines.slice(0, 3).join('\n'),
    [...lines, lines[2]].join('\n'),
    normal.replace('code=0 signal=null', 'code=null signal=SIGKILL'),
    normal.replace('code=0 signal=null', 'code=1 signal=null'),
    normal.replace('requested pid=43', 'requested pid=99'),
    normal.replace('pid=42 [shell] will quit', 'pid=99 [shell] will quit'),
    [lines[0], lines[2], lines[1], lines[3]].join('\n'),
    normal.replace('13:00:02.790', '12:59:59.000'),
  ])
    assert.throws(() => packageShutdownReceipt(failed), /packaged backend/)
})
test('package-check diagnostics preserve process output and failure metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-package-check-log-'))
  try {
    const filename = packageCheckLog({ runDirectory: directory }, 'unpacked', 'ScholarSeed.exe', {
      status: null,
      signal: 'SIGTERM',
      error: new Error('spawn timeout'),
      stdout: '[shell] backend exited\n',
      stderr: 'AttributeError: AF_UNIX\n',
    })
    const output = fs.readFileSync(filename, 'utf8')
    assert.match(output, /ScholarSeed\.exe/)
    assert.match(output, /spawn timeout/)
    assert.match(output, /backend exited/)
    assert.match(output, /AttributeError: AF_UNIX/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
test('package-check temporary cleanup is best-effort after successful verification', () => {
  const warn = console.warn
  const rmSync = fs.rmSync
  const directory = path.join(
    os.tmpdir(),
    `scholarseed-package-check-locked-${crypto.randomUUID()}`
  )
  try {
    const warnings = []
    console.warn = (message) => warnings.push(message)
    fs.rmSync = (candidate) => {
      if (candidate === directory) {
        const error = new Error('EPERM: operation not permitted')
        error.code = 'EPERM'
        throw error
      }
      return rmSync(candidate, { recursive: true, force: true })
    }
    assert.doesNotThrow(() => bestEffortRemoveTemporary(directory, 0))
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /cleanup-error.*EPERM/)
    assert.match(warnings[1], /could not remove temporary directory/)
  } finally {
    fs.rmSync = rmSync
    console.warn = warn
  }
})
test('artifact verification keeps the macOS local bridge below the Unix socket path limit', () => {
  const endpoint = path.join(
    artifactTemporaryRoot('darwin'),
    'scholarseed-package-check-XXXXXX',
    'home',
    'service',
    'bridge',
    'endpoint-XXXXXXXXXXXX',
    'api.sock'
  )
  assert.ok(Buffer.byteLength(endpoint) < DARWIN_UNIX_SOCKET_PATH_BYTES)
  assert.equal(artifactTemporaryRoot('linux'), os.tmpdir())
  assert.throws(() => artifactTemporaryRoot('win32'), /absolute build run directory/)
  assert.throws(() => artifactTemporaryRoot('win32', 'relative'), /absolute build run directory/)
  const buildRoot = path.resolve('release', 'preview-win32-x86_64')
  assert.equal(artifactTemporaryRoot('win32', buildRoot), buildRoot)
})
test(
  'macOS package check returns its physical directory without a /tmp alias',
  {
    skip: process.platform !== 'darwin' ? 'Requires macOS filesystem' : false,
  },
  () => {
    const directory = createPackageCheckDirectory({ platform: 'darwin' })
    try {
      assert.equal(directory, fs.realpathSync(directory))
      assert.ok(directory.startsWith('/private/tmp/ss-package-check-'))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
)
test(
  'Windows package check creates private state under the build tree',
  {
    skip: process.platform !== 'win32' ? 'Requires Windows ACL commands' : false,
  },
  () => {
    const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-check-contract-'))
    try {
      const directory = createPackageCheckDirectory({
        platform: 'win32',
        runDirectory: path.join(runDirectory, 'release', 'deep-'.repeat(40)),
        repo: runDirectory,
      })
      assert.equal(path.dirname(directory), path.join(runDirectory, 'tmp'))
      assert.deepEqual(fs.readdirSync(directory), [])
      const acl = spawnSync(
        path.join(
          process.env.SystemRoot,
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe'
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$a = Get-Acl -LiteralPath $env:SS_CHECK_DIRECTORY; if (!$a.AreAccessRulesProtected) { exit 1 }; $trusted = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, "S-1-5-18", "S-1-5-32-544"); foreach ($r in $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { if ($r.AccessControlType -eq "Allow" -and $r.IdentityReference.Value -notin $trusted) { exit 2 } }',
        ],
        { env: { ...process.env, SS_CHECK_DIRECTORY: directory }, encoding: 'utf8' }
      )
      assert.equal(acl.status, 0, `${acl.stdout}\n${acl.stderr}`)
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true })
    }
  }
)
test(
  'directory preflight exercises real native permissions and rejects a writable output',
  {
    skip:
      process.platform !== 'darwin' && process.platform !== 'win32'
        ? 'Requires supported packaging platform'
        : false,
  },
  () => {
    const python =
      process.env.SCHOLARSEED_TEST_PYTHON || path.join(REPO_ROOT, '.venv', 'bin', 'python')
    assert.ok(fs.existsSync(python), 'Prepare the reviewed Python or set SCHOLARSEED_TEST_PYTHON')
    const parent = path.join(REPO_ROOT, 'tmp')
    fs.mkdirSync(parent, { recursive: true })
    const runDirectory = fs.mkdtempSync(path.join(parent, 'ss-preflight-contract-'))
    try {
      if (process.platform === 'win32') protectWindowsVerificationDirectory(runDirectory)
      const frozen = { platform: process.platform, repo: REPO_ROOT, runDirectory }
      const result = preflightDirectories(frozen, python)
      assert.equal(result.status, 'passed')
      assert.equal(result.roots.length, 3)
      assert.equal(result.roots[0], fs.realpathSync(runDirectory))
      assert.equal(
        fs.existsSync(path.dirname(result.roots[1])),
        false,
        'preflight state is removed'
      )
      if (process.platform === 'darwin') fs.chmodSync(runDirectory, 0o777)
      else {
        const system = path.join(process.env.SystemRoot, 'System32')
        const grant = spawnSync(
          path.join(system, 'icacls.exe'),
          [runDirectory, '/grant', '*S-1-5-32-545:(OI)(CI)(M)'],
          { encoding: 'utf8' }
        )
        assert.equal(grant.status, 0, `${grant.stdout}\n${grant.stderr}`)
      }
      assert.throws(() => preflightDirectories(frozen, python), /ERR_LEASE_PERMISSION/)
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true })
    }
  }
)
test('desktop projects the immutable product manifest into its Python child', () => {
  assert.match(DESKTOP_BACKEND_SOURCE, /SCHOLARSEED_PRODUCT_MANIFEST/)
  assert.match(DESKTOP_BACKEND_SOURCE, /env\[SCHOLARSEED_PRODUCT_MANIFEST_ENV\]/)
  assert.match(DESKTOP_BACKEND_SOURCE, /resolvedProductConfig\.source/)
  assert.match(DESKTOP_BACKEND_SOURCE, /config: SECURE_PACKAGED_FALLBACK, source/)
})
test('packaged default runtime carries the complete Serve product metadata', () => {
  const runtime = PRODUCT_POLICY.runtimes[PRODUCT_POLICY.default_runtime]
  for (const field of ['display_name', 'client_name', 'client_title', 'service_name']) {
    assert.equal(typeof runtime[field], 'string')
    assert.ok(runtime[field].trim(), `${field} must be non-empty`)
  }
  for (const field of ['sandbox', 'approval_policy', 'full_access_sandbox', 'no_approval_policy']) {
    assert.equal(typeof runtime.default_permission[field], 'string')
    assert.ok(
      runtime.default_permission[field].trim(),
      `default_permission.${field} must be non-empty`
    )
  }
})
test('developer entry points share locked dependency installation', () => {
  const { resolveCommand } = require('../../../../../scripts/shared/commands.cjs')
  assert.equal(ROOT_PACKAGE.scripts.ops, 'node scripts/ops-cli.cjs')
  for (const [command, script] of [
    [['cd', 'build', 'local', '--stage', 'app'], 'build'],
    [['cd', 'build', 'local', '--stage', 'dir'], 'package:dir'],
    [['cd', 'build', 'local'], 'package'],
    [['ci', 'check', 'types', 'desktop'], 'typecheck']
  ]) {
    const [step] = resolveCommand(command).steps
    assert.equal(step.kind, 'desktop')
    assert.equal(step.script, script)
  }
  assert.doesNotMatch(WORKSPACE_SOURCE, /RESOLVE_LOCAL_CODEX|command -v codex|shasum/)
  assert.match(WORKSPACE_SOURCE, /scripts\/pre\/toolchain\.cjs', 'codex'/)
})

const PACKAGING_ENTRY = path.join(sourceDirectory, 'build.cjs')
// Only the post-install loader may touch third-party modules; everything it requires
// is resolved after npm ci, so the file head must stay resolvable on a bare checkout.
const POST_INSTALL_LOADER = /function loadDependencies\(\) \{[\s\S]*?\n\}/
const REQUIRED_SPECIFIER = /require\(\s*['"]([^'"]+)['"]\s*\)/g

function requiredSpecifiers(source) {
  return [...source.matchAll(REQUIRED_SPECIFIER)].map((match) => match[1])
}

function loadTimeModuleGraph(entry, source) {
  const graph = new Set()
  const pending = requiredSpecifiers(source)
    .filter((name) => name.startsWith('.'))
    .map((name) => path.resolve(path.dirname(entry), name))
  while (pending.length) {
    const file = pending.pop()
    if (graph.has(file)) continue
    graph.add(file)
    pending.push(
      ...requiredSpecifiers(fs.readFileSync(file, 'utf8'))
        .filter((name) => name.startsWith('.'))
        .map((name) => path.resolve(path.dirname(file), name))
    )
  }
  return [...graph]
}

test('packaging entry loads third-party modules only after installing locked dependencies', () => {
  const entrySource = fs.readFileSync(PACKAGING_ENTRY, 'utf8')
  const headSource = entrySource.replace(POST_INSTALL_LOADER, '')
  assert.notEqual(headSource, entrySource, `${PACKAGING_ENTRY} must keep its post-install loader`)
  for (const file of [PACKAGING_ENTRY, ...loadTimeModuleGraph(PACKAGING_ENTRY, headSource)]) {
    const loaded =
      file === PACKAGING_ENTRY
        ? headSource
        : fs.readFileSync(file, 'utf8').replace(POST_INSTALL_LOADER, '')
    const thirdParty = requiredSpecifiers(loaded).filter(
      (name) => !name.startsWith('node:') && !name.startsWith('.')
    )
    assert.deepEqual(thirdParty, [], `${path.relative(REPO_ROOT, file)} is required before npm ci`)
  }
  const body = entrySource.slice(entrySource.indexOf('async function main('))
  const installed = body.indexOf('ensureNodeDependencies()')
  const loaded = body.indexOf('loadDependencies()')
  assert.ok(
    installed >= 0 && loaded > installed,
    'main() must install locked dependencies before loading third-party modules'
  )
  const clean = body.indexOf('sourceInputs(')
  assert.ok(
    clean >= 0 && installed > clean,
    'main() must capture and validate its source lane before installing locked dependencies'
  )
})

function sourceFixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-build-source-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'source.cjs'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(directory, '.gitignore'), 'ignored/\n')
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: directory, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'source fixture')
  return { directory, git }
}

test('local build source accepts a stable dirty checkout without reporting it clean', context => {
  const { sourceInputs, assertSource } = require('../build.cjs')
  const { directory } = sourceFixture(context)
  assert.equal(sourceInputs({ type: 'release' }, directory).clean, true)
  fs.writeFileSync(path.join(directory, 'source.cjs'), 'module.exports = 2\n')
  fs.writeFileSync(path.join(directory, 'new.cjs'), 'module.exports = 3\n')
  const source = sourceInputs({ type: 'dev', candidate: false }, directory)
  assert.equal(source.clean, false)
  assert.equal(source.snapshot.clean, false)
  source.snapshotAfter = assertSource(source, directory)
  const receipt = JSON.parse(JSON.stringify(source))
  assert.equal(receipt.clean, false)
  assert.equal(receipt.snapshot.fingerprint, receipt.snapshotAfter.fingerprint)
  for (const args of [{ type: 'preview' }, { type: 'release' }, { type: 'release', candidate: true }, { type: 'dev', candidate: true }]) {
    assert.throws(() => sourceInputs(args, directory), /clean worktree/)
  }
})

test('local build rejects tracked, untracked, index and HEAD changes after its source snapshot', context => {
  const { sourceInputs, assertSource } = require('../build.cjs')
  for (const mutation of ['tracked', 'untracked', 'index', 'head']) {
    const { directory, git } = sourceFixture(context)
    fs.writeFileSync(path.join(directory, 'source.cjs'), 'module.exports = 2\n')
    const source = sourceInputs({ type: 'dev', candidate: false }, directory)
    if (mutation === 'tracked') fs.writeFileSync(path.join(directory, 'source.cjs'), 'module.exports = 4\n')
    if (mutation === 'untracked') fs.writeFileSync(path.join(directory, 'new.cjs'), 'module.exports = 3\n')
    if (mutation === 'index') git('add', 'source.cjs')
    if (mutation === 'head') {
      git('add', 'source.cjs')
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'changed source')
    }
    assert.throws(() => assertSource(source, directory), /source checkout changed/, mutation)
  }
})

test('build source lane rejects ambiguous types before dependency preparation', () => {
  const { buildType } = require('../build.cjs')
  assert.equal(buildType(['--type', 'dev']), 'dev')
  for (const args of [['--type'], ['--type', 'unknown'], ['--type', 'dev', '--type', 'release'], ['--type', 'dev', '--candidate'], ['--unknown', 'value']]) {
    assert.throws(() => buildType(args))
  }
})

test('desktop development identity uses the branch name and detached HEAD fallback', () => {
  const branchGit = (_command, args) =>
    args.includes('--show-current') ? 'feature/branch-label\n' : 'unused\n'
  const detachedGit = (_command, args) =>
    args.includes('--show-current') ? '\n' : '86aa803b1234\n'

  assert.equal(resolveGitIdentity(REPO_ROOT, branchGit), 'feature/branch-label')
  assert.equal(resolveGitIdentity(REPO_ROOT, detachedGit), '86aa803b1234')
  assert.equal(
    developmentDisplayName('feature/branch-label'),
    `${PACKAGE.build.productName} · feature/branch-label`
  )
  assert.equal(
    developmentDisplayName('86aa803b1234'),
    `${PACKAGE.build.productName} · 86aa803b1234`
  )
  const windowsGit = (_command, args) =>
    args.includes('--show-current') ? '\r\n' : '86aa803b1234\r\n'
  assert.equal(resolveGitIdentity(REPO_ROOT, windowsGit), '86aa803b1234')
})
test('desktop development identity rejects unresolved Git identities and propagates failures', () => {
  assert.throws(() => resolveGitIdentity(REPO_ROOT, () => '\r\n'), /cannot resolve Git/)
  assert.throws(() => developmentDisplayName(''), /must not be empty/)
  const failure = new Error('Git unavailable')
  const fail = () => { throw failure }
  assert.throws(() => resolveGitIdentity(REPO_ROOT, fail), error => error === failure)
  assert.throws(
    () => registerMacDevelopmentBundle('/tmp/Electron.app/Contents/Info.plist', 'darwin', fail),
    error => error === failure
  )
})
test('desktop development identity reads product metadata and skips macOS writes on Windows', () => {
  const source = fs.readFileSync(path.join(sourceDirectory, '../pre/identity.cjs'), 'utf8')
  for (const platform of ['darwin', 'win32', 'linux']) {
    const calls = []
    const output = []
    const identityModule = { exports: {} }
    const dependencies = {
      'node:path': path,
      'node:child_process': {
        execFileSync: (command, args) => {
          calls.push([command, args])
          return command === 'git' ? 'feature/metadata\r\n' : ''
        },
      },
      'node:crypto': crypto,
      electron: '/tmp/checkout/Electron.app/Contents/MacOS/Electron',
      '../../package.json': { build: { productName: 'Contract Product', protocols: PACKAGE.build.protocols } },
    }
    const loadDependency = name => {
      assert.ok(Object.hasOwn(dependencies, name), name)
      return dependencies[name]
    }
    loadDependency.main = identityModule
    runInNewContext(source, {
      module: identityModule,
      require: loadDependency,
      __dirname: path.join(sourceDirectory, '../pre'),
      process: {
        platform,
        argv: ['node', 'identity.cjs', REPO_ROOT],
        stdout: { write: text => output.push(text) },
      },
    })
    if (platform === 'darwin') {
      assert.equal(
        output.join(''),
        '[desktop-dev] macOS app name: Contract Product · feature/metadata\n'
      )
      assert.deepEqual(Array.from(calls[1][1]).slice(0, 4), [
        '-replace', 'CFBundleName', '-string', 'Contract Product · feature/metadata',
      ])
      assert.deepEqual(Array.from(calls[2][1]).slice(0, 4), [
        '-replace', 'CFBundleDisplayName', '-string', 'Contract Product · feature/metadata',
      ])
      assert.equal(JSON.parse(calls[4][1][3])[0].CFBundleURLName, 'Contract Product')
    } else {
      assert.deepEqual(calls, [])
      assert.deepEqual(output, [])
    }
  }
})
test('desktop development identity updates only macOS bundle display keys', () => {
  const calls = []
  const run = (command, args) => calls.push([command, args])

  for (const platform of ['linux', 'win32']) {
    assert.equal(
      updateMacBundleName(
        '/tmp/Electron.app/Contents/Info.plist',
        '书深 · feature/one',
        platform,
        run
      ),
      false
    )
  }
  assert.deepEqual(calls, [])
  assert.equal(
    updateMacBundleName(
      '/tmp/Electron.app/Contents/Info.plist',
      '书深 · feature/one',
      'darwin',
      run
    ),
    true
  )
  assert.deepEqual(calls, [
    [
      '/usr/bin/plutil',
      [
        '-replace',
        'CFBundleName',
        '-string',
        '书深 · feature/one',
        '/tmp/Electron.app/Contents/Info.plist',
      ],
    ],
    [
      '/usr/bin/plutil',
      [
        '-replace',
        'CFBundleDisplayName',
        '-string',
        '书深 · feature/one',
        '/tmp/Electron.app/Contents/Info.plist',
      ],
    ],
  ])
})
test('replay input is an exclusive frozen copy, not a later read of the external lock', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-build-contract-'))
  try {
    const source = path.join(directory, 'source.json')
    const frozen = path.join(directory, 'frozen.json')
    fs.writeFileSync(source, '{"input":"A"}')
    assert.equal(await freezeFile(source, frozen), await sha256(frozen))
    fs.writeFileSync(source, '{"input":"B"}')
    assert.equal(fs.readFileSync(frozen, 'utf8'), '{"input":"A"}')
    await assert.rejects(() => freezeFile(source, frozen), /EEXIST/)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})
test('release evidence uses SHA-256 and SHA-512 over the same immutable bytes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-hash-contract-'))
  try {
    const artifact = path.join(directory, 'artifact.dmg')
    fs.writeFileSync(artifact, 'book-depth')
    assert.match(await sha256(artifact), /^[a-f0-9]{64}$/)
    assert.match(await sha512(artifact), /^[a-f0-9]{128}$/)
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})
test('frozen distribution product policy is product-scoped and HTTPS-only', () => {
  const product = frozenProductConfiguration(
    {
      type: 'release',
      lane: 'distribution',
      channel: 'release',
      buildNumber: '202608271200',
      'update-base-url': 'https://updates.example.test/',
      'team-id': 'A1B2C3D4E5',
    },
    REVIEWED_BINARIES
  )
  assert.equal(product.product_id, 'scholarseed')
  assert.equal(product.bundle_id, 'com.scholarseed.desktop')
  const appIdExpression = BUILD_SOURCE.match(/appId: (args\.platform[^\n]+),/)[1]
  assert.equal(runInNewContext(appIdExpression, { args: { platform: 'win32' }, product, PACKAGE }), 'scholarseed')
  assert.equal(runInNewContext(appIdExpression, { args: { platform: 'darwin' }, product, PACKAGE }), 'com.scholarseed.desktop')
  assert.equal(product.release_lane, 'distribution')
  assert.equal(product.update_channel, 'release')
  // app.getVersion() carries only the SemVer, so the build stamp must travel here.
  assert.equal(product.build_number, '202608271200')
  assert.equal(product.update_base_url, 'https://updates.example.test')
  assert.equal(product.expected_team_id, 'A1B2C3D4E5')
  assert.equal(product.credential_profiles.distribution.key_provider, 'system_keychain')
  assert.equal(PRODUCT_POLICY.credential_profiles.local.key_provider, 'mock_keychain')
  assert.equal(product.runtimes.codex.executable_sha256, REVIEWED_BINARIES.codex.executable_sha256)
  assert.equal(Object.hasOwn(product.runtimes.codex, 'inspection'), false)
  assert.equal(product.default_runtime, 'codex')
  assert.equal(product.runtimes.dsh, undefined)
  assert.throws(
    () =>
      frozenProductConfiguration(
        { lane: 'local', type: 'preview', channel: 'preview' },
        {
          ...REVIEWED_BINARIES,
          codex: { ...REVIEWED_BINARIES.codex, source: undefined },
        }
      ),
    /lacks verified official release evidence/
  )
})
test('frozen Windows product policy carries the Authenticode publisher', () => {
  const product = frozenProductConfiguration(
    {
      type: 'release',
      lane: 'distribution',
      channel: 'release',
      buildNumber: '202608271200',
      'update-base-url': 'https://updates.example.test/',
      'windows-publisher': 'CN=ScholarSeed Test Publisher',
    },
    REVIEWED_BINARIES
  )
  assert.equal(product.expected_team_id, '')
  assert.equal(product.build_number, '202608271200')
  assert.equal(product.expected_windows_publisher, 'CN=ScholarSeed Test Publisher')
})
test('official runtime packaging does not require a rebuilt inspection executable', () => {
  const product = frozenProductConfiguration(
    { lane: 'local', type: 'preview', channel: 'preview' },
    REVIEWED_BINARIES
  )
  assert.equal(product.runtimes.codex.reported_version, REVIEWED_BINARIES.codex.reported_version)
  assert.deepEqual(product.runtimes.codex.source, REVIEWED_BINARIES.codex.source)
  assert.equal(Object.hasOwn(product.runtimes.codex, 'inspection'), false)
})
test('electron-builder receives one frozen resource set instead of merging package resources twice', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-builder-config-'))
  try {
    const filename = writeBuilderConfiguration(
      {
        runDirectory: directory,
        resourceRoot: path.join(directory, 'resources'),
        output: path.join(directory, 'artifacts'),
        productName: 'ScholarSeed',
        closure: { protected: { generation: 'a'.repeat(64) } },
      },
      {
        version: '0.1.1',
        type: 'dev',
        platform: 'darwin',
        arch: 'arm64',
        lane: 'local',
        signed: false,
        candidate: false,
        target: require('../../shared/target.cjs').target('darwin', 'arm64'),
      }
    )
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    assert.deepEqual(config.extraResources.find(entry => entry.to === 'desktop'), { from: path.join(directory, 'resources', 'desktop'), to: 'desktop' })
    const backend = config.extraResources.filter((entry) => entry.to === 'backend')
    assert.deepEqual(config.asarUnpack, ['out/main/lease.node', 'out/main/notarization.node', 'out/main/repair.node'])
    assert.equal(config.files.includes('out/**/*'), false)
    assert.equal(config.files.includes(`out/protected/${'a'.repeat(64)}/**/*`), true)
    assert.equal(
      config.files.some((pattern) => pattern.includes('staging-')),
      false
    )
    assert.equal(backend.length, 1)
    assert.equal(backend[0].from, path.join(directory, 'resources', 'backend'))
    assert.equal(
      config.extraResources.find((entry) => entry.to === 'notices').from,
      path.join(directory, 'resources', 'notices')
    )
    assert.equal(config.directories.output, path.join(directory, 'artifacts'))
    assert.equal(config.productName, 'ScholarSeed')
    assert.deepEqual(config.extraMetadata, {
      version: '0.1.1',
      author: { name: 'Alibaba Damo (Hangzhou) Technology Co., Ltd.' },
    })
    assert.equal(config.artifactName, 'scholarseed-0.1.1-darwin-arm64.${ext}')
    assert.ok(
      [
        directory,
        path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules', 'electron', 'dist'),
      ].includes(config.electronDist)
    )
    assert.equal(config.mac.identity, null)
    assert.equal(Object.hasOwn(config.mac, 'sign'), false)
    assert.equal(config.mac.hardenedRuntime, true)
    assert.equal(config.mac.entitlements, 'resources/entitlements.mac.plist')
    assert.equal(config.mac.extendInfo.CFBundleDevelopmentRegion, 'en')
    assert.equal(config.mac.extendInfo.CFBundleDisplayName, 'ScholarSeed')
    assert.equal(config.mac.extendInfo.CFBundleSpokenName, '书深')
    assert.equal(config.mac.extendInfo.LSHasLocalizedDisplayName, true)
    assert.ok(config.mac.extendInfo.MDItemKeywords.includes('书深'))
    assert.deepEqual(
      config.extraResources.find((entry) => entry.to === 'zh_CN.lproj'),
      {
        from: 'resources/mac/zh_CN.lproj',
        to: 'zh_CN.lproj',
        filter: ['InfoPlist.strings'],
      }
    )
    assert.deepEqual(
      config.extraResources.find((entry) => entry.to === 'en.lproj'),
      {
        from: 'resources/mac/en.lproj',
        to: 'en.lproj',
        filter: ['InfoPlist.strings'],
      }
    )
    assert.deepEqual(config.electronLanguages, PACKAGE.build.electronLanguages)
    assert.equal(config.dmg.format, PACKAGE.build.dmg.format)
    assert.deepEqual(config.mac.signIgnore, [
      '/Contents/Resources/backend/bin/codex$',
      '/Contents/Resources/backend/browser/node$',
      '/Contents/Resources/backend/codex-runtime(?:/|$)',
    ])
    assert.equal(config.afterPack, path.join(sourceDirectory, 'sign.cjs'))
    assert.equal(config.afterAllArtifactBuild, path.join(sourceDirectory, 'verify.cjs'))
    assert.equal(config.afterSign, path.join(sourceDirectory, 'notarize.cjs'))
    assert.ok(config.files.includes('!out/renderer/**/*'))
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})
// app-builder-lib 的 removeUnusedLanguagesIfNeeded 也作用于 Contents/Resources，那里有
// 产品经 extraResources 放进去的 InfoPlist.strings（承载本地化显示名）：白名单漏掉哪个
// locale，删掉的就是显示名而不是冗余翻译。
test('electronLanguages 覆盖产品自己交付的每个 .lproj', () => {
  const shipped = PACKAGE.build.extraResources
    .map((entry) => entry.to)
    .filter((to) => typeof to === 'string' && to.endsWith('.lproj'))
    .map((to) => to.slice(0, -'.lproj'.length).toLowerCase().replace(/_/g, '-'))
  assert.ok(shipped.length > 0, '产品不再交付任何本地化 .lproj；本守卫失去对象')
  const wanted = PACKAGE.build.electronLanguages.map((language) =>
    language.toLowerCase().replace(/_/g, '-')
  )
  assert.ok(wanted.length > 0, 'electronLanguages 为空时 app-builder-lib 不做裁剪')
  for (const locale of shipped) {
    assert.ok(wanted.includes(locale), `electronLanguages 会删掉产品的 ${locale}.lproj`)
  }
  // CFBundleDevelopmentRegion 指向的区域必须留下，否则 Finder 显示名回退到 bundle 名。
  const development = PACKAGE.build.mac.extendInfo.CFBundleDevelopmentRegion.toLowerCase()
  assert.ok(
    wanted.some((language) => language === development || language.startsWith(`${development}-`)),
    `electronLanguages 丢掉了 CFBundleDevelopmentRegion=${development}`
  )
})
// 选择格式必须同时衡量下载体积及客户端读取成本，而不是只取最小包。
// 同一1417完整app：UDBZ 605,774,796 B，挂载/完整验签/ZIP合计177.874s；
// ULFO 651,798,525 B，同样操作52.915s，ZIP均732,308,716 B。
// UDBZ的DiskImages采样集中在BZ2解压；ULFO降低反复读取时的解压成本，保留所有安全门。
// electron-builder 26.15.7支持ULFO(macOS10.11+)，低于当前Electron最低13.0。
test('DMG uses LZFSE to bound client read cost without changing verification', () => {
  assert.equal(PACKAGE.build.dmg.format, 'ULFO')
})
test('Intel macOS uses the x64 Electron Builder architecture and the Intel runtime triple', () => {
  const selected = require('../../shared/target.cjs').target('darwin', 'x86_64')
  assert.equal(selected.builderArch, require('electron-builder').Arch.x64)
  assert.equal(selected.triple, 'x86_64-apple-darwin')
  assert.equal(selected.installer, 'dmg')
})
test('local signing preserves only reviewed upstream signed runtimes', () => {
  const app = '/Applications/fixture.app'
  assert.equal(adHocOptions(app).ignore, shouldIgnore)
  assert.equal(preserveReviewedRuntime(`${app}/Contents/Resources/backend/bin/codex`), true)
  assert.equal(
    preserveReviewedRuntime(
      `${app}/Contents/Resources/backend/codex-runtime/bin/codex-code-mode-host`
    ),
    true
  )
  assert.equal(preserveReviewedRuntime(`${app}/Contents/Resources/backend/bin/rg`), false)
})
test('Windows dir packaging excludes legacy NSIS configuration and resources', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-nsis-config-'))
  try {
    const context = {
      runDirectory: directory,
      resourceRoot: path.join(directory, 'resources'),
      output: path.join(directory, 'artifacts'),
      productName: 'ScholarSeed',
      updater: { file: 'updater/update-owner.exe' },
      closure: { protected: { generation: 'a'.repeat(64) } },
    }
    const filename = writeBuilderConfiguration(context, {
      version: '0.1.1',
      type: 'dev',
      platform: 'win32',
      arch: 'x86_64',
      lane: 'local',
      signed: false,
      candidate: false,
      target: require('../../shared/target.cjs').target('win32', 'x86_64'),
    })
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    assert.equal(Object.hasOwn(config, 'nsis'), false)
    assert.deepEqual(config.win.target, [{ target: 'dir', arch: ['x64'] }])
    assert.equal(config.extraFiles, undefined)
    assert.deepEqual(config.extraResources.find(entry => entry.to === 'components'), {from: path.join(context.resourceRoot, 'components'), to: 'components'})
    assert.deepEqual(config.extraResources.find(entry => entry.to === 'renderer').filter, ['**/*', '!office{,/**/*}'])
    assert.deepEqual(config.extraResources.find(entry => entry.to === 'backend').filter, ['**/*', '!python{,/**/*}', '!texlive{,/**/*}', '!powershell{,/**/*}', '!codex-runtime{,/**/*}', '!office{,/**/*}', '!components{,/**/*}'])
    assert.equal(context.nsis, undefined)
    assert.equal(config.extraResources.some((entry) => /\.nsh$/i.test(entry.from)), false)
    assert.equal(config.extraResources.find((item) => item.to === 'updater'), undefined)
    assert.equal(config.extraResources.find((item) => item.to === 'desktop'), undefined)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Windows application assembly does not include the retired native carrier', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-native-config-'))
  try {
    const context = {
      runDirectory: directory,
      resourceRoot: path.join(directory, 'resources'),
      output: path.join(directory, 'artifacts'),
      productName: 'ScholarSeed',
      updater: { file: 'updater/update-owner.exe' },
      closure: { protected: { generation: 'a'.repeat(64) } },
    }
    const filename = writeBuilderConfiguration(context, {
      version: '0.2.0',
      type: 'preview',
      platform: 'win32',
      arch: 'x86_64',
      lane: 'distribution',
      signed: true,
      candidate: false,
      target: require('../../shared/target.cjs').target('win32', 'x86_64'),
    })
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    assert.equal(config.extraResources.some(item => item.to === 'updater'), false)
    assert.equal(fs.existsSync(path.join(directory, 'native-installer.nsh')), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Windows 载荷统计只数 win-unpacked 的常规文件', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-payload-'))
  try {
    const unpacked = path.join(directory, 'win-unpacked')
    fs.mkdirSync(path.join(unpacked, 'resources', 'backend'), { recursive: true })
    fs.writeFileSync(path.join(unpacked, 'ScholarSeed.exe'), 'x'.repeat(10))
    fs.writeFileSync(path.join(unpacked, 'resources', 'backend', 'python.exe'), 'y'.repeat(7))
    const args = { platform: 'win32', stage: 'nsis' }
    assert.deepEqual(payloadStatistics({ output: directory }, args), {
      root: 'win-unpacked',
      files: 2,
      bytes: 17,
    })
    assert.equal(
      payloadStatistics({ output: directory }, { platform: 'darwin', stage: 'dmg' }),
      null
    )
    assert.equal(
      payloadStatistics({ output: directory }, { platform: 'win32', stage: 'backend' }),
      null
    )
    assert.equal(payloadStatistics({ output: path.join(directory, 'missing') }, args), null)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('Windows CI components are immutable archives with persistent prepared runtime', () => {
  assert.match(BUILD_SOURCE, /args\.platform === 'win32' \? \{ UV_LINK_MODE: 'copy' \} : \{\}/)
  assert.match(BUNDLE_BACKEND_SOURCE, /writeProductLibraries\(run, python, wheels, pylibs\)/)
  for (const derive of ['derivePythonContentId', 'deriveTexliveContentId', 'derivePowerShellContentId'])
    assert.ok(BUNDLE_BACKEND_SOURCE.includes(derive + '('))
  assert.match(BUNDLE_BACKEND_SOURCE, /runtimeTreeEvidence/)
  assert.match(BUNDLE_BACKEND_SOURCE, /cache\.publish/)
  assert.match(VERIFY_SOURCE, /prepared runtime inventory differs/)
  assert.match(VERIFY_SOURCE, /runtime envelope differs from frozen build/)
  assert.match(VERIFY_SOURCE, /probePowerShell\(runtime\.powershell/)
  assert.match(VERIFY_SOURCE, /'--requirements', path\.join\(backend, REQUIREMENTS_FILENAME\)\], \{\s*env: \{ \.\.\.process\.env, SCHOLARSEED_PRODUCT_LIBS: pylibs \}/)
  assert.match(DESKTOP_BACKEND_SOURCE, /bundledWindowsRuntime/)
  assert.doesNotMatch(DESKTOP_BACKEND_SOURCE, /ensureComponents|provisionedComponents|component provisioning failed/)
  assert.match(DESKTOP_BACKEND_SOURCE, /\[PYTHONPATH_ENV\]: toNamespacedPath\(join\(cwd, PYLIBS_DIRNAME\)\)/)
})

test('distribution builder uses an unprefixed certificate qualifier and preserves native signing identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-builder-distribution-'))
  const signing = { identity: 'Developer ID Application: Contract (ABCDE12345)' }
  try {
    const filename = writeBuilderConfiguration(
      {
        runDirectory: directory,
        resourceRoot: path.join(directory, 'resources'),
        output: path.join(directory, 'artifacts'),
        productName: 'ScholarSeed',
        native: { signing },
        closure: { protected: { generation: 'a'.repeat(64) } },
      },
      {
        version: '0.1.1',
        type: 'release',
        platform: 'darwin',
        arch: 'arm64',
        lane: 'distribution',
        signed: true,
        candidate: false,
        target: require('../../shared/target.cjs').target('darwin', 'arm64'),
      }
    )
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    assert.equal(config.mac.identity, 'Contract (ABCDE12345)')
    assert.equal(signing.identity, 'Developer ID Application: Contract (ABCDE12345)')
    assert.equal(config.mac.sign, path.join(sourceDirectory, 'signer.cjs'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
test('distribution verification requires Developer ID trust for signed ripgrep', () => {
  assert.match(
    VERIFY_SOURCE,
    /verifySignedRuntime\(current\.rg, frozen\.product\.config\.expected_team_id\)/
  )
  assert.match(VERIFY_SOURCE, /flags=0x10000\(runtime\)/)
  assert.match(VERIFY_SOURCE, /TeamIdentifier=/)
  assert.match(VERIFY_SOURCE, /Timestamp=/)
})
test('macOS executable digest ignores Developer ID signature metadata', async () => {
  if (process.platform !== 'darwin') return
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-digest-'))
  try {
    const source = process.execPath
    const copy = path.join(directory, 'node')
    fs.copyFileSync(source, copy)
    const before = await executableDigest(copy)
    const signed = spawnSync('codesign', ['--force', '--sign', '-', copy])
    assert.equal(signed.status, 0)
    assert.equal(await executableDigest(copy), before)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
test('macOS signing progress counts the same list osx-sign walks and prefixes each line', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-sign-progress-'))
  const app = path.join(directory, 'Fixture.app')
  const contents = path.join(app, 'Contents')
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true })
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true })
  fs.copyFileSync(process.execPath, path.join(contents, 'MacOS', 'fixture'))
  fs.writeFileSync(path.join(contents, 'Resources', 'notes.txt'), 'not a binary')
  const originalWrite = process.stdout.write.bind(process.stdout)
  const lines = []
  try {
    assert.equal(await countSignableFiles(app, () => false), 2)
    process.stdout.write = (chunk) => {
      lines.push(String(chunk))
      return true
    }
    const restore = await trackSignProgress(app, () => false)
    try {
      process.stdout.write('electron-osx-sign Skipped... /resource +0ms\n')
      process.stdout.write('electron-osx-sign Signing... /one +0ms\n')
      process.stdout.write('electron-osx-sign Skipped... /another +0ms\n')
      process.stdout.write('electron-osx-sign Signing... /two +0ms\n')
    } finally {
      restore()
    }
  } finally {
    process.stdout.write = originalWrite
    fs.rmSync(directory, { recursive: true, force: true })
  }
  assert.deepEqual(lines, [
    'electron-osx-sign [1/2] Signing... /one +0ms\n',
    'electron-osx-sign [2/2] Signing... /two +0ms\n',
  ])
})
test('macOS signing targets Mach-O images and bundle directories only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-macho-'))
  try {
    const binary = path.join(directory, 'tool')
    // This is a magic-header unit contract, independent of the host Node format.
    fs.writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
    const resource = path.join(directory, 'locale.pak')
    fs.writeFileSync(resource, '\0\0\0\0not a Mach-O image')
    const bundle = path.join(directory, 'Nested.framework')
    fs.mkdirSync(bundle)
    assert.equal(isMachO(binary), true)
    assert.equal(isMachO(resource), false)
    assert.equal(isMachO(directory), false)
    assert.equal(isBundle(bundle), true)
    assert.equal(isSignable(bundle), true)
    assert.equal(isSignable(binary), true)
    assert.equal(isSignable(resource), false)
    const ignore = signableIgnore((filename) => filename === resource)
    assert.equal(ignore(binary), false)
    assert.equal(ignore(bundle), false)
    assert.equal(ignore(resource), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
test('notary credentials prefer the keychain profile and reject partial API keys', () => {
  assert.deepEqual(credentials({ SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE: 'profile' }), [
    '--keychain-profile',
    'profile',
  ])
  assert.deepEqual(
    credentials({
      SCHOLARSEED_APPLE_API_KEY: '/key',
      SCHOLARSEED_APPLE_API_KEY_ID: 'key-id',
      SCHOLARSEED_APPLE_API_ISSUER: 'issuer',
    }),
    ['--key', '/key', '--key-id', 'key-id', '--issuer', 'issuer']
  )
  assert.throws(() => credentials({ SCHOLARSEED_APPLE_API_KEY: '/key' }), /required/)
})
test('notary polling reports progress and returns once the submission settles', () => {
  const statuses = ['In Progress', 'In Progress', 'Accepted']
  const polls = []
  const receipt = waitForNotarization('submission-id', [], {
    request: (submissionId) => {
      polls.push(submissionId)
      return { id: submissionId, status: statuses.shift() }
    },
    wait: () => {},
  })
  assert.equal(receipt.status, 'Accepted')
  assert.equal(polls.length, 3)
})
test('notary polling fails instead of waiting forever', () => {
  assert.throws(
    () =>
      waitForNotarization('submission-id', [], {
        request: (submissionId) => ({ id: submissionId, status: 'In Progress' }),
        wait: () => {},
        maxPolls: 3,
      }),
    /did not settle/
  )
})

test('signed distribution freezes reviewed Ed25519 public roots and rejects missing roots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-activation-keys-'))
  try {
    const keys = {
      test: crypto
        .generateKeyPairSync('ed25519')
        .publicKey.export({ format: 'pem', type: 'spki' })
        .toString(),
    }
    const filename = path.join(directory, 'public.json')
    fs.writeFileSync(filename, JSON.stringify(keys))
    const args = {
      lane: 'distribution',
      signed: true,
      'update-base-url': 'https://updates.example.test',
    }
    assert.throws(
      () => frozenProductConfiguration(args, REVIEWED_BINARIES),
      /activation-public-keys/
    )
    assert.deepEqual(
      {
        ...frozenProductConfiguration(
          { ...args, 'activation-public-keys': filename },
          REVIEWED_BINARIES
        ).update_activation_keys,
      },
      keys
    )
    fs.writeFileSync(filename, JSON.stringify({ test: 'invalid' }))
    assert.throws(() =>
      frozenProductConfiguration({ ...args, 'activation-public-keys': filename }, REVIEWED_BINARIES)
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('npm package entry forwards activation public-key configuration', () => {
  const name = 'SCHOLARSEED_UPDATE_ACTIVATION_PUBLIC_KEYS'
  const previous = process.env[name]
  try {
    process.env[name] = 'reviewed-public-keys.json'
    const args = desktopPackage.buildArguments('check')
    assert.equal(
      args[args.indexOf('--activation-public-keys') + 1],
      path.resolve('reviewed-public-keys.json')
    )
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('packaging resolves native uv from the supplied PATH without invoking a preceding shim', () => {
  const { uvExecutable } = require('../bundle.cjs')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uv resolution space '))
  try {
    const shim = path.join(directory, 'shim')
    const native = path.join(directory, 'native')
    fs.mkdirSync(shim)
    fs.mkdirSync(native)
    fs.writeFileSync(path.join(shim, 'uv.cmd'), '@echo SHIM_MUST_NOT_RUN\r\nexit /b 19\r\n')
    const binary = path.join(native, process.platform === 'win32' ? 'uv.exe' : 'uv')
    fs.copyFileSync(process.execPath, binary)
    fs.chmodSync(binary, 0o755)
    const environment = {
      ...process.env,
      UV: '',
      PATH: [shim, native, process.env.PATH].join(path.delimiter),
    }
    assert.equal(uvExecutable(environment), binary)
    const result = spawnSync(uvExecutable(environment), ['--version'], {
      env: environment,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), process.version)
    assert.equal(uvExecutable({ ...environment, UV: binary }), binary)
    assert.equal(uvExecutable({ ...environment, UV: directory }), '')
    assert.equal(uvExecutable({ ...environment, UV: path.join(native, 'missing.exe') }), '')
    if (process.platform === 'win32') {
      assert.equal(uvExecutable({ ...environment, UV: binary.slice(0, -4) }), binary)
      for (const suffix of ['.cmd', '.bat', '.ps1']) {
        assert.throws(
          () => uvExecutable({ ...environment, UV: path.join(shim, 'uv' + suffix) }),
          /native \.exe/
        )
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// Reopening and retirement must address the state created by the first launch.
test('package check environments preserve the same isolated home across lifecycle calls', () => {
  const root = path.resolve('private-verification')
  const home = path.join(root, 'home')
  const first = packageCheckEnvironment(root)
  const reopen = packageCheckEnvironment(root)
  assert.deepEqual(reopen, first)
  assert.equal(first.USERPROFILE, process.platform === 'win32' ? process.env.USERPROFILE : home)
  assert.equal(first.SCHOLARSEED_HOME, home)
  assert.equal(first.HOME, home)
  assert.equal(first.APPDATA, path.join(home, 'AppData', 'Roaming'))
  assert.equal(first.LOCALAPPDATA, path.join(home, 'AppData', 'Local'))
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(first[name], root)
  assert.equal(first.SCHOLARSEED_DEFAULT_WORKSPACE, path.join(root, 'workspace'))
  assert.equal(first.PYTHONDONTWRITEBYTECODE, '1')
})

for (const platform of ['win32', 'darwin']) {
  for (const declaredProfile of [true, false]) {
    test(`package check separates system profile from product state on ${platform} (profile=${declaredProfile})`, () => {
      const paths = platform === 'win32' ? path.win32 : path.posix
      const root = platform === 'win32' ? 'C:\\private-verification' : '/private/verification'
      const home = paths.join(root, 'home')
      const environment = {
        HOME: 'original-home',
        APPDATA: 'original-appdata',
        LOCALAPPDATA: 'original-local',
        SCHOLARSEED_HOME: 'original-product',
        SCHOLARSEED_DEFAULT_WORKSPACE: 'original-workspace',
        TEMP: 'original-temp',
        TMP: 'original-tmp',
        TMPDIR: 'original-tmpdir',
        PRESERVED_MARKER: 'host',
      }
      if (declaredProfile) environment.USERPROFILE = 'original-system-profile'
      const before = { ...environment }
      const invoke = runInNewContext(`(${packageCheckEnvironment.toString()})`, {
        path: paths,
        process: { platform, env: environment },
        WINDOWS_PLATFORM: 'win32',
        PYTHON_DONT_WRITE_BYTECODE_ENV: 'PYTHONDONTWRITEBYTECODE',
      })
      const actual = { ...invoke(root) }
      assert.deepEqual(environment, before)
      assert.deepEqual({ ...invoke(root) }, actual)
      assert.equal(actual.USERPROFILE, platform === 'win32' ? environment.USERPROFILE : home)
      assert.equal(Object.hasOwn(actual, 'USERPROFILE'), platform !== 'win32' || declaredProfile)
      assert.equal(actual.SCHOLARSEED_HOME, home)
      assert.equal(actual.HOME, home)
      assert.equal(actual.APPDATA, paths.join(home, 'AppData', 'Roaming'))
      assert.equal(actual.LOCALAPPDATA, paths.join(home, 'AppData', 'Local'))
      assert.equal(actual.SCHOLARSEED_DEFAULT_WORKSPACE, paths.join(root, 'workspace'))
      for (const name of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(actual[name], root)
      assert.equal(actual.PYTHONDONTWRITEBYTECODE, '1')
      assert.equal(actual.PRESERVED_MARKER, 'host')
    })
  }
}

test('package check launches Electron with isolated user data under its private home', () => {
  const directory = path.join(os.tmpdir(), 'package-check-private')
  const result = path.join(directory, 'result.json')
  assert.deepEqual(packageCheckArguments(directory, result), [
    '--enable-logging=file',
    '--log-file',
    path.join(directory, 'electron.log'),
    `--user-data-dir=${path.join(directory, 'home', 'userData')}`,
    '--package-check',
    result,
  ])
})

test('reopen shutdown receipt covers new bytes and preserves prior evidence', () => {
  const events = [
    '2026-10-11T00:00:00.000Z pid=42 [shell] backend ready pid=43 port=5000',
    '2026-10-11T00:00:01.000Z pid=42 [shell] backend stop requested pid=43 port=5000 quitting=true',
    '2026-10-11T00:00:02.000Z pid=42 [shell] backend exited code=0 signal=null',
    '2026-10-11T00:00:03.000Z pid=42 [shell] will quit; draining log writes',
  ].join('\n') + '\n'
  const previous = Buffer.from('context 中文\n' + events)
  // Even PID reuse must not confuse an old receipt with this invocation.
  const current = Buffer.concat([previous, Buffer.from(events)])
  assert.throws(() => packageShutdownReceipt(current.toString('utf8')), /ambiguous/)
  assert.deepEqual(packageShutdownReceipt(packageShutdownLogDelta(previous, current)), { code: 0, signal: null, elapsed_ms: 1000 })
  for (const invalid of [previous.subarray(0, previous.length - 1), Buffer.from(previous.toString('utf8').replace('中文', '改写'))])
    assert.throws(() => packageShutdownLogDelta(previous, invalid), /truncated or changed/)
  const duplicate = Buffer.concat([current, Buffer.from(events)])
  assert.throws(() => packageShutdownReceipt(packageShutdownLogDelta(previous, duplicate)), /ambiguous/)
  assert.throws(() => packageShutdownReceipt(packageShutdownLogDelta(previous, previous)), /missing/)
})

test('native stage output identifies the check and excludes arbitrary diagnostics', () => {
  const child = {
    stdout: '[native-stage] {"stage":"native.bootstrap.extract","event":"start","secret":"ignored"}\r\nraw secret\n',
    stderr: '[native-stage] {"stage":"native.bootstrap.extract","event":"end","status":"passed","seconds":12.5,"path":"ignored"}\n' +
      '[native-stage] {"stage":"native.launch.verify-publication","event":"end","status":"failed","seconds":0.2}\n' +
      '[native-stage] {"stage":"native.invalid","event":"end","status":"passed","seconds":-1}\n' +
      '[native-stage] {broken\n[native-stage] null\n'
  }
  assert.deepEqual(nativeStageRecords(child, 'installed-native-first'), [
    { check: 'installed-native-first', stage: 'native.bootstrap.extract', event: 'start' },
    { check: 'installed-native-first', stage: 'native.bootstrap.extract', event: 'end', status: 'passed', seconds: 12.5 },
    { check: 'installed-native-first', stage: 'native.launch.verify-publication', event: 'end', status: 'failed', seconds: 0.2 }
  ])
})

test('package-check emits native timing on success while keeping raw output on disk', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-stage-output-'))
  const log = console.log
  const emitted = []
  console.log = line => emitted.push(line)
  try {
    const child = { status: 0, stdout: 'private diagnostic\n',
      stderr: '[native-stage] {"stage":"native.launch.family-start","event":"end","status":"passed","seconds":1.25,"private":"hidden"}\n' }
    const filename = packageCheckLog({ runDirectory: directory }, 'installed-native-reopen', 'ScholarSeed.exe', child)
    assert.deepEqual(emitted, ['[native-stage] {"check":"installed-native-reopen","stage":"native.launch.family-start","event":"end","status":"passed","seconds":1.25}'])
    assert.match(fs.readFileSync(filename, 'utf8'), /private diagnostic/)
  } finally {
    console.log = log
    fs.rmSync(directory, { recursive: true, force: true })
  }
})


test('native stage forwards only nonnegative safe operation counts', () => {
  for (const operations of [0, 108105, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'private']) {
    const child = { stderr: '[native-stage] ' + JSON.stringify({stage:'native.extract.directory-reuse',event:'end',status:'passed',seconds:0.01,operations}) }
    const records = nativeStageRecords(child, 'installed-native-first')
    assert.equal(records.length, 1)
    assert.equal(records[0].operations, Number.isSafeInteger(operations) && operations >= 0 ? operations : undefined)
  }
})

test('removed Windows update targets reject stale CLI and CI environment configuration', () => {
  for (const value of ['standard', 'carrier-bootstrap']) {
    assert.throws(() => options(['--windows-update-target', value]), /targets were removed/)
    assert.throws(() => options([`--windows-update-target=${value}`]), /targets were removed/)
  }
  const original = process.env.SCHOLARSEED_WINDOWS_UPDATE_TARGET
  try {
    for (const value of ['standard', 'carrier-bootstrap', 'unknown']) {
      process.env.SCHOLARSEED_WINDOWS_UPDATE_TARGET = value
      assert.throws(() => options([]), /targets were removed/)
    }
    process.env.SCHOLARSEED_WINDOWS_UPDATE_TARGET = ''
    assert.equal(Object.hasOwn(options([]), 'windowsUpdateTarget'), false)
  } finally {
    if (original === undefined) delete process.env.SCHOLARSEED_WINDOWS_UPDATE_TARGET
    else process.env.SCHOLARSEED_WINDOWS_UPDATE_TARGET = original
  }
})


test('component timing forwarding labels attempts and filters raw/private fields', () => {
  const event = {kind: 'python', version: '3.12.13-r1', operation: 'prepare', pid: 42,
    status: 'passed', last_phase: 'publish', elapsed_ms: 1200, files: 20000, bytes: 1000000,
    flush_workers: 2, flush_peak: 7,
    metrics: { sync: { calls: 20000, elapsed_ms: 900, path: 'private' } }, url: 'private' }
  const child = { stdout: '[runtime] [component-timing] ' + JSON.stringify(event) + '\n' +
    '[component-timing] null\n[component-timing] {broken\n' +
    '[component-timing] ' + JSON.stringify({...event, elapsed_ms: -1}) + '\n' }
  const records = componentTimingRecords(child, 'installed-first')
  assert.equal(records.length, 1)
  assert.equal(records[0].check, 'installed-first')
  assert.equal(records[0].url, undefined)
  assert.equal(records[0].flush_workers, 2)
  assert.equal(records[0].flush_peak, 7)
  const invalid = componentTimingRecords({stdout: '[component-timing] ' + JSON.stringify({...event, flush_workers: 'private', flush_peak: -1})}, 'test')[0]
  assert.equal(invalid.flush_workers, undefined)
  assert.equal(invalid.flush_peak, undefined)
  assert.deepEqual(records[0].metrics, { sync: {calls: 20000, elapsed_ms: 900} })
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'component-timing-'))
  const original = console.log
  const logs = []
  console.log = line => logs.push(line)
  try {
    packageCheckLog({runDirectory: directory}, 'installed-first', 'ScholarSeed.exe', {...child, status: 0})
    assert.deepEqual(logs, records.map(record => '[component-timing] ' + JSON.stringify(record)))
  } finally { console.log = original; fs.rmSync(directory, {recursive: true, force: true}) }
})

for (const code of ['ETIMEDOUT', 'EACCES']) {
  test(`macOS trust failure retains command cause and bounded diagnostics: ${code}`, () => {
    const filename = path.join(sourceDirectory, 'verify.cjs')
    const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
    const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'trustCommand').getText(parsed)
    const events = []
    const failure = Object.assign(new Error('policy check failed'), {code, status: 68, signal: null, pid: 23,
      stdout: 'x'.repeat(9000) + 'CloudKit network connection was lost', stderr: 'x'.repeat(9000)})
    const execute = runInNewContext(`${declaration}\ntrustCommand`, {
      MAC_TRUST_TIMEOUT_MS: 300000, TRUST_DIAGNOSTIC_BYTES: 4096,
      console: {log: line => events.push(JSON.parse(line.slice(line.indexOf('{')))), error: line => events.push(JSON.parse(line.slice(line.indexOf('{'))))},
      command(executable, args, options) { assert.equal(options.timeout, 300000); throw failure },
    })
    assert.throws(() => execute('gatekeeper', 'spctl', []), error => error === failure)
    assert.equal(events[0].status, 'start')
    assert.equal(events[1].status, 'failed')
    assert.equal(events[1].code, code)
    assert.equal(events[1].pid, 23)
    assert.equal(events[1].exit_code, 68)
    assert.equal(events[1].stdout.length, 4096)
    assert.match(events[1].stdout, /CloudKit network connection was lost$/)
    assert.equal(events[1].stderr.length, 4096)
  })
}
