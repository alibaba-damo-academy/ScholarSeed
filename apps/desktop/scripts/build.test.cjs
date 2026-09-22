// Deterministic input contracts only; not Electron/DMG acceptance.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { runInNewContext } = require('node:vm')
const ts = require('typescript')
const { TARGETS } = require('./target.cjs')
const { verifyInputs, verifyNotices, stageNotices } = require('./notices.cjs')
const PACKAGE = require('../package.json')
const {
  options,
  acquireMutex,
  BUILD_TYPES,
  buildNumberOf,
  buildRunDirectory,
  credentialFreeEnv,
  freezeFile,
  frozenProductConfiguration,
  installerArtifacts,
  localDmgbuild,
  writeBuilderConfiguration,
  resolveNsisConfiguration,
  payloadStatistics
} = require('./build.cjs')
const {
  adHocOptions,
  preserveReviewedRuntime,
  shouldIgnore,
  countSignableFiles,
  trackSignProgress
} = require('./sign.cjs')
const { isMachO, isBundle, isSignable, signableIgnore } = require('./macho.cjs')
const { credentials, waitForNotarization } = require('./notarize.cjs')
const {
  packageCheckLog,
  artifactTemporaryRoot,
  DARWIN_UNIX_SOCKET_PATH_BYTES,
  productPath,
  RUNTIME_PROBE_SCRIPT,
  unsignedPackageCheck,
  bestEffortRemoveTemporary
} = require('./verify.cjs')
const { sha256, sha512, executableDigest } = require('./digest.cjs')
const { OFFICE_BUILD_DIRECTORY, verifyOfficeAssets } = require('./office-assets.cjs')
const { ownedExecutable } = require('./windows-sign.cjs')
const desktopPackage = require('./package.cjs')
const {
  developmentDisplayName,
  resolveGitIdentity,
  registerMacDevelopmentBundle,
  updateMacBundleName
} = require('./identity.cjs')
const REPO_ROOT = path.join(__dirname, '..', '..', '..')
test('packaging targets preserve independent macOS and Windows artwork', () => {
  const desktopRoot = path.join(__dirname, '..')
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
test('repository skill locks include manifests matching the reviewed dependency policy', () => {
  const skillsRoot = path.join(REPO_ROOT, 'skills')
  const sourceRoot = path.join(skillsRoot, 'community')
  const lock = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'skills.lock.json')))
  const registry = JSON.parse(fs.readFileSync(path.join(skillsRoot, 'registry.json')))
  const packageManifest = '.scholarseed-package.json'
  const sourceNames = fs.readdirSync(sourceRoot).filter(name =>
    fs.existsSync(path.join(sourceRoot, name, 'SKILL.md'))).sort()
  assert.deepEqual(lock.skills.map(skill => skill.slug).sort(), sourceNames)
  for (const skill of lock.skills) {
    const inventory = skill.files.find(file => file.path === packageManifest)
    assert.ok(inventory, `${skill.slug} is missing its package manifest from the lock`)
    const payload = fs.readFileSync(path.join(sourceRoot, skill.slug, packageManifest))
    assert.equal(crypto.createHash('sha256').update(payload).digest('hex'), inventory.sha256)
    assert.equal(payload.length, inventory.size)
    const manifest = JSON.parse(payload)
    assert.equal(manifest.name, skill.slug)
    assert.equal(manifest.version, skill.version)
    assert.deepEqual(manifest.dependencies, registry.dependencies[skill.slug])
  }
  const publicationOracle = 'scripts/smoke_publication.py'
  const literatureReview = lock.skills.find(skill => skill.slug === 'literature-review')
  assert.ok(literatureReview.files.some(file => file.path === publicationOracle))
  assert.ok(fs.statSync(path.join(sourceRoot, 'literature-review', publicationOracle)).size > 0)
})
test('macOS development protocol registration uses a stable checkout-specific bundle identity', () => {
  const calls = []
  const run = (...args) => calls.push(args)
  const plist = '/tmp/checkout/Electron.app/Contents/Info.plist'
  assert.equal(registerMacDevelopmentBundle(plist, 'linux', run), false)
  assert.equal(calls.length, 0)
  registerMacDevelopmentBundle(plist, 'darwin', run)
  const firstId = calls[0][1][3]
  assert.match(firstId, /^com\.scholarseed\.desktop\.dev\.[a-f0-9]{16}$/)
  assert.deepEqual(JSON.parse(calls[1][1][3])[0].CFBundleURLSchemes, ['scholarseed'])
  assert.deepEqual(calls[2][1], ['-f', '/tmp/checkout/Electron.app'])
  registerMacDevelopmentBundle(plist, 'darwin', run)
  assert.equal(calls[3][1][3], firstId)
  registerMacDevelopmentBundle('/tmp/other/Electron.app/Contents/Info.plist', 'darwin', run)
  assert.notEqual(calls[6][1][3], firstId)
})
const ROOT_PACKAGE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const WORKSPACE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'workspace.cjs'), 'utf8')
const BUNDLE_BACKEND_SOURCE = fs.readFileSync(path.join(__dirname, 'bundle.cjs'), 'utf8')
const PROBE_SOURCE = fs.readFileSync(path.join(__dirname, 'probe.cjs'), 'utf8')
test('backend bundling uses current runtime and product configuration owners', () => {
  assert.ok(BUNDLE_BACKEND_SOURCE.includes("'runtime', 'packages/runtime'"))
  // 产品模块清单的唯一载体已移入 scripts/probe.cjs（bundle 构建期与 verify 包内验证共用），
  // bundle.cjs 必须真的执行这份探针。
  assert.ok(PROBE_SOURCE.includes('"scholarseed_runtime"'))
  assert.ok(BUNDLE_BACKEND_SOURCE.includes('RUNTIME_PROBE_SCRIPT'))
  assert.ok(!BUNDLE_BACKEND_SOURCE.includes('packages/damoagent'))
  assert.ok(!BUNDLE_BACKEND_SOURCE.includes('"damoagent"'))
})
const VERIFY_SOURCE = fs.readFileSync(path.join(__dirname, 'verify.cjs'), 'utf8')
const BUILD_SOURCE = fs.readFileSync(path.join(__dirname, 'build.cjs'), 'utf8')
const DESKTOP_BACKEND_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backend.ts'), 'utf8')
const UPDATER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'updater.ts'), 'utf8')
const UPDATE_CONTRACT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'updates.ts'), 'utf8')
const AUTHENTICODE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'authenticode.ts'), 'utf8')
const INSTALLER_NSH = fs.readFileSync(path.join(__dirname, '..', 'resources', 'installer.nsh'), 'utf8')
const COMPONENTS_CJS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'components.cjs'), 'utf8')
const SHELL_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
const UPDATE_FEATURE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'features', 'updates', 'state.ts'), 'utf8')
const PRELOAD_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.ts'), 'utf8')
const BRIDGE_TYPES_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'global.d.ts'), 'utf8')
const BROWSER_BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'browser.ts'), 'utf8')
const UPDATE_PANEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'business', 'UpdatePanel.tsx'), 'utf8')
const ACCOUNT_PANEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'business', 'AccountPanel.tsx'), 'utf8')
const PRODUCT_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'product.json')))
const DEFAULT_RUNTIME_POLICY = PRODUCT_POLICY.runtimes[PRODUCT_POLICY.default_runtime]
const REVIEWED_BINARIES = {
  codex: {
    executable_sha256: 'a'.repeat(64),
    reported_version: '0.999.0',
    source: { package: '@openai/codex', distribution: 'verified-download',
      archive_sha256: 'b'.repeat(64), integrity: 'sha512-fixture' }
  }
}

function noticesFixture(context) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-notices-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const original = path.resolve(__dirname, '../../..')
  const desktop = path.join(repo, 'apps', 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  fs.copyFileSync(path.join(original, 'uv.lock'), path.join(repo, 'uv.lock'))
  fs.copyFileSync(path.join(original, 'apps', 'desktop', 'package-lock.json'), path.join(desktop, 'package-lock.json'))
  const notices = path.join(desktop, 'resources', 'notices')
  fs.cpSync(path.join(original, 'apps', 'desktop', 'resources', 'notices'), notices, { recursive: true })
  return { repo, desktop, notices, resources: path.join(repo, 'staged') }
}

test('reviewed notices match locked Python and build dependencies and stage without network', context => {
  const fixture = noticesFixture(context)
  const expected = verifyInputs(fixture.repo)
  assert.deepEqual(stageNotices(fixture.repo, fixture.resources), expected)
  assert.deepEqual(verifyNotices(fixture.resources, expected), expected)
  assert.ok(expected.some(file => file.path === 'README.md'))
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.notices, 'manifest.json')))
  const pillow = manifest.components.find(component => component.name === 'pillow')
  assert.deepEqual(pillow.artifacts.map(artifact => artifact.platform).sort(), Object.keys(TARGETS).sort())
  for (const name of ['pypdf', 'pycparser']) {
    const component = manifest.components.find(item => item.name === name)
    assert.equal(component.license, 'BSD-3-Clause')
    assert.equal(component.artifacts[0].platform, 'any')
    const license = fs.readFileSync(path.join(fixture.notices, component.artifacts[0].licenseFile), 'utf8')
    assert.match(license, /Redistribution and use in source and binary forms/)
    assert.match(license, /ANY EXPRESS OR IMPLIED WARRANTIES/)
  }
  assert.ok(PACKAGE.build.extraResources.some(entry => entry.from === 'resources/notices' && entry.to === 'notices'))
})

test('notice input verification rejects Python version drift with CRLF lockfiles', context => {
  const fixture = noticesFixture(context)
  const filename = path.join(fixture.repo, 'uv.lock')
  const text = fs.readFileSync(filename, 'utf8')
  fs.writeFileSync(filename, text.replaceAll('\n', '\r\n'))
  assert.doesNotThrow(() => verifyInputs(fixture.repo))
  fs.writeFileSync(filename, text.replace('name = "certifi"\nversion = "2026.6.17"', 'name = "certifi"\nversion = "0.0.0"'))
  assert.throws(() => verifyInputs(fixture.repo), /notice version differs from lock: certifi/)
})

test('notice input verification rejects npm version and integrity drift', context => {
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

test('notice input verification rejects missing license and source evidence', context => {
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

test('notice artifact verification rejects missing, changed and extra files on either platform layout', context => {
  const fixture = noticesFixture(context)
  for (const resources of [path.join(fixture.repo, 'Application.app', 'Contents', 'Resources'),
    path.join(fixture.repo, 'windows-unpacked', 'resources')]) {
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

test('notice input verification requires the source guide and the liblzma correction', context => {
  const fixture = noticesFixture(context)
  const guide = path.join(fixture.notices, 'README.md')
  const original = fs.readFileSync(guide)
  fs.unlinkSync(guide)
  assert.throws(() => verifyInputs(fixture.repo), /notice document missing/)
  fs.writeFileSync(guide, original)
  fs.unlinkSync(path.join(fixture.notices, 'xz-0bsd.txt'))
  assert.throws(() => verifyInputs(fixture.repo), /notice supplement missing or changed/)
})

test('notice input verification rejects Python source and artifact hash drift', context => {
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
  const parsed = options(['--version', '0.1.1', '--platform', 'darwin', '--arch', 'arm64', '--stage', 'dir'])
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
  assert.throws(() => options(['--version', '0.1.1', '--build-number', '2026082612']), /build-number/)
  assert.equal(options(['--version', '0.1.1', '--build-number', '202608261200'])['build-number'],
    '202608261200')
})
test('build number defaults to the Beijing stamp of the built commit', () => {
  assert.equal(buildNumberOf({ 'build-number': '202601010000' }, 'not-a-commit'), '202601010000')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim()
  const stamp = buildNumberOf({ 'build-number': '' }, head)
  assert.match(stamp, /^\d{12}$/)
  // Cross-check against an independent derivation: China has no DST, so Beijing
  // wall-clock is always the committer instant shifted by +8h.
  const epoch = Number(spawnSync('git', ['show', '-s', '--format=%ct', head],
    { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim())
  const expected = new Date((epoch + 8 * 3600) * 1000).toISOString().slice(0, 16).replace(/[-T:]/g, '')
  assert.equal(stamp, expected)
})
test('result artifacts are keyed by the installer extension', () => {
  assert.deepEqual(installerArtifacts(null), {})
  assert.deepEqual(installerArtifacts({ path: '/out/scholarseed-0.1.1-darwin-arm64.dmg' }),
    { dmg: { path: '/out/scholarseed-0.1.1-darwin-arm64.dmg' } })
  assert.deepEqual(installerArtifacts({ path: 'C:/out/scholarseed-0.1.1-windows-amd64.exe' }),
    { exe: { path: 'C:/out/scholarseed-0.1.1-windows-amd64.exe' } })
})
test('packaging reads the Serve-owned default configuration', () => {
  assert.match(BUILD_SOURCE, /apps\/serve\/service\/settings\/default\.json/)
  assert.doesNotMatch(BUILD_SOURCE, /packages\/damoagent\/damoagent\/surface\/config\/default\.json/)
})
test('builds reject bypass flags and malformed identifiers', () => {
  assert.throws(() => options(['--no-preflight', 'yes']))
  assert.throws(() => options(['--version', '../wrong']))
  assert.throws(() => options(['--arch', 'x64']))
})
test('packaging lock replaces a stale owner and rejects a live owner', () => {
  const lock = path.join(__dirname, '..', '.package-lock')
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
test('Windows x64 uses NSIS and requires signing inputs unless explicitly candidate', () => {
  const base = ['--platform', 'win32', '--arch', 'x86_64', '--type', 'preview',
    '--update-base-url', 'https://updates.example.test']
  assert.throws(() => options(base), /windows-publisher|signing environment/i)
  const parsed = options([...base, '--candidate'])
  assert.equal(parsed.stage, 'nsis')
  assert.equal(parsed.target.triple, 'x86_64-pc-windows-msvc')
  assert.equal(parsed.target.archType, 'windows-amd64')
  assert.equal(parsed.signed, false)
  assert.equal(parsed.lane, 'distribution')
})
test('Windows signer changes only ScholarSeed-owned executables', () => {
  assert.equal(ownedExecutable('C:/app/ScholarSeed.exe'), true)
  assert.equal(ownedExecutable('C:/app/scholarseed-0.2.0-windows-amd64.exe'), true)
  assert.equal(ownedExecutable('C:/app/__uninstaller-nsis-scholarseed-desktop.exe'), true)
  assert.equal(ownedExecutable('C:/app/resources/backend/codex-runtime/bin/codex.exe'), false)
  assert.equal(ownedExecutable('C:/app/resources/backend/python/Scripts/scholarseed.exe'), false)
  assert.equal(ownedExecutable('C:/app/resources/backend/python/python.exe'), false)
})
// 抽出 verifyWindowsInstaller 真正发给 PowerShell 的脚本字面量。CLM 安全断言必须针对这段脚本、
// 而不是整个 updater.ts 源码：后者的 JSDoc 会点名 Add-Type / [PSCustomObject] / [Console]:: 这些被禁
// 构造来解释「为什么不用」，对整文件 doesNotMatch 会被注释误触发（上一轮就踩过同名陷阱）。
function windowsVerifyScript() {
  const source = ts.createSourceFile('updater.ts', UPDATER_SOURCE, ts.ScriptTarget.Latest, true)
  const verifier = source.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'verifyWindowsInstaller')
  assert.ok(verifier, 'verifyWindowsInstaller not found')
  const declaration = verifier.body.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText(source) === 'script')
  assert.ok(declaration?.initializer, 'script literal not found')
  return runInNewContext(declaration.initializer.getText(source), {
    WINDOWS_INSTALLER_ENV: 'SCHOLARSEED_UPDATE_INSTALLER',
    WINDOWS_VERIFY_REPORT_ENV: 'SCHOLARSEED_UPDATE_VERIFY_REPORT',
    // 报告契约值在 authenticode.ts 只存一份；这里的字面量必须与它一致，下面单独钉死。
    AUTHENTICODE_REPORT_KEYS: { languageMode: 'LanguageMode', status: 'Status', subject: 'Subject' }
  })
}
test('Windows updater verifies Authenticode with a ConstrainedLanguage-safe cmdlet, no shell', () => {
  // bug 87042987：受限语言模式（WDAC/AppLocker 企业终端管控）下 Add-Type、[PSCustomObject] 类型转换、
  // [Console]::OutputEncoding 静态属性赋值全部被禁，内联 WinVerifyTrust 脚本必然非零退出 → 校验
  // fail-closed 永久阻断安装。改用内置 cmdlet Get-AuthenticodeSignature（受限模式允许运行）+ 属性 get。
  const script = windowsVerifyScript()
  assert.match(script, /Get-AuthenticodeSignature/)
  assert.match(script, /\.SignerCertificate\.Subject/)
  // 被禁构造一个都不能出现在真正下发的脚本里（只查抽出的 script，注释里点名不算）。
  assert.doesNotMatch(script, /Add-Type/)
  assert.doesNotMatch(script, /\[Console\]::/)
  assert.doesNotMatch(script, /\[PSCustomObject\]/)
  assert.doesNotMatch(script, /WinVerifyTrust/)
  assert.doesNotMatch(script, /\[Convert\]::|\[uint32\]/)
  // 判定输入一律走 `-Encoding UTF8` 的报告文件，脚本什么都不往 stdout 写（bug 87108457）：证书 DN 带
  // 中文属地属性（L=杭州市 / S=浙江省 / OID.1.3.6.1.4.1.311.60.2.1.1=西湖区），而 powershell.exe 的
  // stdout 按本机控制台代码页编码（中文 Windows 是 936/GBK），Node 侧解码一旦与实际代码页不一致，这几个
  // 属性就变成 U+FFFD，与构建期冻结的期望串必然不符 → 一次**解码降级**被误判成「发布者不符」的**安全
  // 拦截**、更新永久阻断。真机（PS 5.1.17763 / chcp 936）已实测否掉两条更省事的路：ConvertTo-Json 不会
  // 把非 ASCII 转义成 \uXXXX；chcp 探测在现场客户端里已存在却仍回退到 UTF-8。文件编码由 cmdlet 参数
  // 显式决定，与代码页和序列化器实现都无关。
  assert.match(script, /ConvertTo-Json -Compress/)
  assert.match(script, /Set-Content -LiteralPath \$env:SCHOLARSEED_UPDATE_VERIFY_REPORT/)
  assert.match(script, /-Encoding UTF8/)
  assert.doesNotMatch(script, /Write-Output/)
  assert.match(UPDATER_SOURCE, /WINDOWS_VERIFY_REPORT_ENV = 'SCHOLARSEED_UPDATE_VERIFY_REPORT'/)
  // 枚举字段一律先 [string] 再进 JSON：否则序列化出来是底层整数，Node 侧拿到 0 而不是 'Valid'。
  assert.match(script, /\[string\]\$signature\.Status/)
  assert.match(script, /\[string\]\$ExecutionContext\.SessionState\.LanguageMode/)
  // 报告从文件读、读完即删；文件名带一次性 UUID，上一轮残留不可能被冒充成本轮结果。报告不合规 ==
  // 校验没能执行，归 verify-env-unavailable，不得落成发布者不符的安全拦截。
  assert.match(UPDATER_SOURCE, /parseAuthenticodeReport\(readVerifyReport\(reportPath\)\)/)
  assert.match(UPDATER_SOURCE, /if \(result\.status !== 0 \|\| report === null\) \{/)
  assert.match(UPDATER_SOURCE, /randomUUID\(\)/)
  assert.match(UPDATER_SOURCE, /VERIFY_REPORT_SUFFIX = '\.verify\.json'/)
  assert.match(UPDATER_SOURCE, /rmSync\(reportPath, \{ force: true \}\)/)
  assert.doesNotMatch(UPDATER_SOURCE, /parseAuthenticodeReport\(result\.stdout\)/)
  assert.doesNotMatch(UPDATER_SOURCE, /\^SUBJECT=/)
  // 契约值单一来源：脚本插值的键名与解析器读的键名都出自 authenticode.ts，且必须与上面沙箱里的
  // 字面量一致（否则脚本与解析器会各自漂移，而两侧的形状断言都还是绿的）。
  assert.match(AUTHENTICODE_SOURCE, /languageMode: 'LanguageMode'/)
  assert.match(AUTHENTICODE_SOURCE, /status: 'Status'/)
  assert.match(AUTHENTICODE_SOURCE, /subject: 'Subject'/)
  assert.match(AUTHENTICODE_SOURCE, /export function parseAuthenticodeReport/)
  // U+FFFD 是编码降级的指纹，真实证书 DN 里不可能出现；出现即拒绝判定。
  assert.match(AUTHENTICODE_SOURCE, /includes\(REPLACEMENT_CHARACTER\)\) return null/)
  // fail-closed：仅 Valid 放行，且发布者必须与打包策略一致。三档判定与 DN 同发布者判定归
  // authenticode.ts（纯函数、有单测），updater 只消费判定结果。
  assert.match(AUTHENTICODE_SOURCE, /AUTHENTICODE_VALID = 'Valid'/)
  assert.match(AUTHENTICODE_SOURCE, /export function classifyAuthenticodeStatus/)
  assert.match(AUTHENTICODE_SOURCE, /export function publisherSubjectsMatch/)
  assert.match(UPDATER_SOURCE, /classifyAuthenticodeStatus\(status\)/)
  assert.match(UPDATER_SOURCE, /publisherSubjectsMatch\(subject, expectedPublisher\)/)
  assert.doesNotMatch(UPDATER_SOURCE, /subject !== expectedPublisher/)
  // 启动 NSIS 仍不经 shell、参数由常量拼装（proposal 108 §5.2 起为新握手协议：--updated +
  // /SCHOLARSEED_UPDATE_ID=<uuid>，不再传 /S 与 --force-run——/S 会抑制进度页，--force-run 会让
  // installSection 的 isForceRun&&Silent 分支成为第二个拉起者）。旧断言钉死的三元组已被协议取代，
  // 这里替换为同等强度的新不变量：参数形态、env 交接、commit 前置、以及「新客户端永不再传
  // /S、--force-run」的否定断言（带引号字面量形态，避开中文注释里的提及）。
  assert.match(UPDATER_SOURCE, /WINDOWS_UPDATE_ARGUMENT = '--updated'/)
  assert.match(UPDATER_SOURCE, /spawn\(installer, \[WINDOWS_UPDATE_ARGUMENT, `\$\{UPDATE_ID_ARGUMENT_PREFIX\}\$\{updateId\}`\]/)
  assert.match(UPDATER_SOURCE, /\[HANDSHAKE_HOME_ENV\]: desktopHome\(\)/)
  assert.match(UPDATER_SOURCE, /\[HANDSHAKE_NONCE_ENV\]: request\.nonce/)
  assert.match(UPDATER_SOURCE, /publishHandshakeDecision\(directory, request, DECISION_COMMIT, log\)/)
  assert.doesNotMatch(UPDATER_SOURCE, /'\/S'/)
  assert.doesNotMatch(UPDATER_SOURCE, /'--force-run'/)
  assert.match(UPDATER_SOURCE, /verifyWindowsInstaller\(installer, config\.expectedWindowsPublisher, log\)/)
  assert.doesNotMatch(UPDATER_SOURCE, /spawn\(installer,[\s\S]{0,160}shell:/)
})
test('Windows subprocess output is decoded by console code page, not blindly as UTF-8', () => {
  // bug 87042987 次生缺陷：中文 Windows 的 powershell.exe 按 GBK(936) 输出，无条件 toString('utf8')
  // 会把错误原文解成乱码。改为探测活动代码页（chcp.com 是原生 exe、不经 PowerShell，不受 CLM 影响）
  // 后用 TextDecoder 按对应标签解码；并收齐字节再整体解码，避免逐块 toString 截断跨块多字节字符。
  assert.match(UPDATER_SOURCE, /chcp\.com/)
  assert.match(UPDATER_SOURCE, /new TextDecoder\(/)
  assert.match(UPDATER_SOURCE, /WINDOWS_CODE_PAGE_ENCODINGS/)
  assert.match(UPDATER_SOURCE, /'936': 'gbk'/)
  assert.doesNotMatch(UPDATER_SOURCE, /chunk\.toString\('utf8'\)/)
  // 探测只服务日志/stderr 可读性：判定输入走 ASCII-only JSON 报告，与探测结果无关。探测有两条静默
  // 回退（chcp 没跑成、TextDecoder 不认标签），87108457 现场因此无法定论是哪一条 —— 实际选用的编码
  // 必须落进 update.log。
  assert.match(UPDATER_SOURCE, /encoding: string/)
  assert.match(UPDATER_SOURCE, /stdoutEncoding=\$\{result\.encoding\}/)
})
test('Windows install failures are classified and never surface raw stderr to the user', () => {
  // bug 87042987：区分「校验环境不可用」与「签名不可信」，原始诊断只落 update.log，界面给结构化本地化
  // 文案（手动安装引导 / 安全拦截），不再把可能乱码的 PowerShell stderr 插值进用户可见串。
  assert.match(UPDATER_SOURCE, /install_verify_unavailable/)
  assert.match(UPDATER_SOURCE, /install_signature_untrusted/)
  // 本机不可判定是独立分类：主进程标注、渲染层映射文案，两侧都要有，缺一侧就会退回笼统说法。
  assert.match(UPDATER_SOURCE, /install_signature_indeterminate/)
  assert.match(UPDATE_FEATURE_SOURCE, /install_signature_indeterminate/)
  assert.match(UPDATER_SOURCE, /class WindowsVerifyError extends Error/)
  assert.match(UPDATER_SOURCE, /return \{ ok: false, errorFallback: windowsInstallFallback\(error\) \}/)
})
test('the updater never blocks the main process with a synchronous spawn', () => {
  // Electron 主进程与 macOS AppKit 主线程是同一个：任何 spawnSync 都会冻住事件循环，期间原生
  // 窗口控件（红绿灯）点不动。Windows 签名校验联网吊销卡住、macOS 安装链 ditto + codesign/spctl/
  // stapler 十几秒，都曾让客户端在安装期无响应（最小化/关闭失灵）。所有子进程一律走异步 runCommandAsync。
  assert.match(UPDATER_SOURCE, /runCommandAsync/)
  assert.doesNotMatch(UPDATER_SOURCE, /spawnSync\s*\(/)
  // 安全校验必须 await：漏掉会让安装先于签名校验完成（fail-open 安全洞），比卡住更糟。
  assert.match(UPDATER_SOURCE, /await requireCommandAsync\('codesign', \['--verify', '--deep', '--strict'/)
  assert.match(UPDATER_SOURCE, /await verifyMountedApplication\(stage, meta, config\)/)
})
test('Windows update recreates a missing desktop shortcut (customInstall safety net)', () => {
  // 更新时 electron-builder 的 addDesktopLink 在 $keepShortcuts=="true" 下只把旧名快捷方式 Rename 成
  // 新名；旧卸载器已删、或改名致旧路径对不上时既不 Rename 也不 Create（RECREATE 分支被
  // ${ifNot} ${isUpdated} 挡死，createDesktopShortcut:"always" 也无效）→ 桌面快捷方式永久丢失。
  // resources/installer.nsh 的 customInstall 必须无条件补建缺失的快捷方式。真机踩过，钉死。
  assert.match(INSTALLER_NSH, /!macro customInstall/)
  assert.match(INSTALLER_NSH, /\$\{ifNot\} \$\{FileExists\} "\$newDesktopLink"/)
  assert.match(INSTALLER_NSH, /CreateShortCut "\$newDesktopLink"/)
  assert.match(INSTALLER_NSH, /CreateShortCut "\$newStartMenuLink"/)
})

test('Windows installer.nsh carries the update handshake contract (proposal 108 P0)', () => {
  // 源码形态契约（同 customInstall 兜底的钉法）：运行时行为待 Windows 真机出包验证，
  // 但这些结构一旦漂移，握手/单拉起/legacy 兼容会静默失效。
  // 1. customInit 接管握手；协议参数缺失 → legacy（旧客户端 /S --force-run 路径保留）。
  assert.match(INSTALLER_NSH, /!macro customInit\r?\n\s*Call ssHandshakeInit/)
  assert.match(INSTALLER_NSH, /StrCpy \$ssHandshakeMode "legacy"/)
  assert.match(INSTALLER_NSH, /\$\{GetOptions\} \$R0 "\$\{SS_UPDATE_ID_OPTION\}" \$ssUpdateId/)
  // 2. updateId 过 UUID 形状闸后才参与路径拼接（防路径穿越，与 Node 侧同判据）。
  assert.match(INSTALLER_NSH, /Call ssValidateUuid\r?\n\s*IfErrors ss_init_fail_uuid/)
  // 3. 握手文件是 UTF-16LE（不依赖系统代码页，bug 87108457 同源纪律）。写侧带 /BOM；
  // 读侧不带 —— FileReadUTF16LE 没有 /BOM 旗标（真机 makensis 验证，267a5d905 前身修复）。
  assert.match(INSTALLER_NSH, /FileReadUTF16LE \$R2 \$R4/)
  assert.doesNotMatch(INSTALLER_NSH, /FileReadUTF16LE \/BOM/)
  assert.match(INSTALLER_NSH, /FileWriteUTF16LE \/BOM \$R2 "schemaVersion=/)
  // NSIS 无内建 $PID：安装器进程号必须显式 GetCurrentProcessId 取得。
  assert.match(INSTALLER_NSH, /GetCurrentProcessId\(\) i \.r0/)
  assert.match(INSTALLER_NSH, /installerPid=\$ssInstallerPid/)
  // reparse 拒绝走 FileFunc 宏形式（原生指令形式在真机上不成立）。
  assert.match(INSTALLER_NSH, /\$\{GetFileAttributes\} "\$R1" "REPARSE_POINT" \$R6/)
  // 4. cancel 与决策超时都必须在卸载前 Quit（绝不带活流程进 installSection）。
  assert.match(INSTALLER_NSH, /ss_decision_cancel:[\s\S]{0,400}?Quit/)
  assert.match(INSTALLER_NSH, /ss_decision_timeout:[\s\S]{0,600}?Quit/)
  // 5. 旧进程退出超时必须中止且不强杀：等待循环里不得出现任何 kill 原语。
  assert.match(INSTALLER_NSH, /ss_init_fail_oldproc:[\s\S]{0,600}?Quit/)
  assert.doesNotMatch(INSTALLER_NSH, /nsProcess|taskkill|TerminateProcess/)
  // 6. 自动拉起唯一所有者：ssLaunchUpdatedAppOnce（单次守卫 + ExecShellAsUser 降权拉起真实 exe）。
  assert.match(INSTALLER_NSH, /StrCmp \$ssLaunchAttempted "1" ss_launch_done/)
  assert.match(INSTALLER_NSH, /\$\{StdUtils\.ExecShellAsUser\} \$0 "\$appExe" "open" "--updated --scholarseed-update-id=\$ssUpdateId"/)
  assert.match(INSTALLER_NSH, /!define MUI_PAGE_CUSTOMFUNCTION_PRE ssFinishPre/)
  // 7. customInstall 只置成功标志，绝不自己拉起（否则出现第二个启动者）。
  // 行首锚定：文件头注释里也提到 "!macro customInstall" 字样，不能抢先命中。
  const customInstall = INSTALLER_NSH.match(/\n!macro customInstall\r?\n([\s\S]*?)\n!macroend/)
  assert.ok(customInstall, 'customInstall macro not found')
  assert.match(customInstall[1], /StrCpy \$ssInstallComplete "1"/)
  assert.doesNotMatch(customInstall[1], /Exec/)
  // 8. install.log 行是 ASCII JSON、与 update.log 共享 updateId。
  assert.match(INSTALLER_NSH, /"schemaVersion":\$\{SS_HANDSHAKE_SCHEMA\},"timestampUtc":"/)
  assert.match(INSTALLER_NSH, /FileWrite \$ssLogHandle "\$ssUpdateId"/)
  // 8b. 2026-09-22 真机 install.log 恒 0 字节后的加固形态（运行时待 Windows 出包验证）：
  // 句柄用具名 Var 不借 $9；20 个寄存器全自保存（GetTime 会扫 $0-$9/$R0-$R9，扫掉调用方的
  // $R1 握手目录就是静默错写）；目录已存在跳过 CreateDirectory；时间戳分段写，杜绝
  // "$ssTimeDayT" 这种 T/Z 被并进变量名（最长标识符解析）展开成空串的串。
  const ssLogEvent = INSTALLER_NSH.match(/\n\s*Function ssLogEvent\r?\n([\s\S]*?)\n\s*FunctionEnd/)
  assert.ok(ssLogEvent, 'ssLogEvent function not found')
  assert.match(ssLogEvent[1], /FileOpen \$ssLogHandle/)
  assert.match(ssLogEvent[1], /FileWrite \$ssLogHandle /)
  assert.doesNotMatch(ssLogEvent[1], /FileOpen \$9 |FileWrite \$9 |FileClose \$9/)
  assert.match(ssLogEvent[1], /Push \$R9/)
  assert.match(ssLogEvent[1], /Pop \$0\s*\r?\n\s*FunctionEnd|Pop \$0\s*$/)
  assert.match(ssLogEvent[1], /IfFileExists "\$ssHome\\logs" ss_log_dir_ok/)
  assert.doesNotMatch(ssLogEvent[1], /\$ssTimeDayT|\$ssTimeSecondZ/)
  // 第二轮真机证明 'a'+FileSeek 组合仍 0 字节（ready.ini 的 'w'+UTF16LE 每轮成功）：弃用 append，
  // 首条日志前轮转旧文件（崩溃轮证据保留一代），本体 'w' 写；轮转每轮只发生一次。
  assert.doesNotMatch(ssLogEvent[1], /FileSeek/)
  assert.match(ssLogEvent[1], /StrCmp \$ssLogRotated "1" ss_log_open/)
  assert.match(ssLogEvent[1], /Delete "\$ssHome\\logs\\\$\{SS_INSTALL_PREV_LOG\}"/)
  assert.match(ssLogEvent[1], /Rename "\$ssHome\\logs\\\$\{SS_INSTALL_LOG\}" "\$ssHome\\logs\\\$\{SS_INSTALL_PREV_LOG\}"/)
  assert.match(ssLogEvent[1], /FileOpen \$ssLogHandle "\$ssHome\\logs\\\$\{SS_INSTALL_LOG\}" w/)
  // 8c. boot 探针矩阵：四种写原语组合各写独立文件，home 一可用就跑（后续校验失败/崩溃也留证据）。
  const probe = INSTALLER_NSH.match(/\n\s*Function ssProbeWritePrimitives\r?\n([\s\S]*?)\n\s*FunctionEnd/)
  assert.ok(probe, 'ssProbeWritePrimitives function not found')
  assert.match(probe[1], /FileOpen \$ssLogHandle "\$ssHome\\logs\\\$\{SS_PROBE_APPEND_ANSI_LOG\}" a/)
  assert.match(probe[1], /FileOpen \$ssLogHandle "\$ssHome\\logs\\\$\{SS_PROBE_WRITE_ANSI_LOG\}" w/)
  assert.match(probe[1], /FileOpen \$ssLogHandle "\$ssHome\\logs\\\$\{SS_PROBE_APPEND_UTF16_LOG\}" a/)
  assert.match(probe[1], /FileWriteUTF16LE \$ssLogHandle 'probe-u16/)
  assert.match(probe[1], /nsExec::Exec `cmd\.exe \/c echo probe-x>>/)
  assert.match(INSTALLER_NSH, /ReadEnvStr \$ssHome \$\{SS_HOME_ENV\}\r?\n\s*StrCmp \$ssHome "" ss_init_fail_home\r?\n\s*;[^\n]*\r?\n\s*Call ssProbeWritePrimitives/)
  // 8d. Node 侧把六个文件尺寸落进 update.log：安装器日志静默与坏原语指认都从现场日志可见。
  assert.match(UPDATER_SOURCE, /installer log sizes: \$\{installerLogSizes\(\)\}/)
  assert.match(UPDATER_SOURCE, /'install-probe-a\.log'/)
  assert.match(UPDATER_SOURCE, /'install-prev\.log'/)
  // 9. 协议模式跳掉 assisted 非静默必弹的「安装模式」选择页（2026-09-22 真机事故：只不传 /S
  //    而不跳页时，自动更新停在该页等人工点击，安装始终没发生）。模板在页 PRE 里给的钩子
  //    customInstallMode 置 isForceCurrentInstall 走 setInstallModePerUser+Abort 跳页分支；
  //    仅当确有 per-user 旧安装时才强制（否则回退模板默认页），卸载器构建不得引用握手 Var。
  const customInstallMode = INSTALLER_NSH.match(/\n\s*!macro customInstallMode\r?\n([\s\S]*?)\n\s*!macroend/)
  assert.ok(customInstallMode, 'customInstallMode macro not found')
  assert.match(customInstallMode[1], /!ifndef BUILD_UNINSTALLER/)
  assert.match(customInstallMode[1], /\$ssHandshakeMode == "protocol"/)
  assert.match(customInstallMode[1], /\$hasPerUserInstallation == "1"/)
  assert.match(customInstallMode[1], /StrCpy \$isForceCurrentInstall "1"/)
})
test('runtime store root resolves through the single owner, env override first', () => {
  // store 根唯一解析口在 components.cjs（.cmd 前导的 batch 三档与它同档同序）；backend 不得再
  // 自己拼 join(home, 'runtime')，否则首装自定义 store 会被主进程静默忽略、与 .cmd 走岔。
  assert.match(DESKTOP_BACKEND_SOURCE, /resolveRuntimeStoreRoot\(process\.env, desktopHome\(\), process\.platform\)/)
  assert.doesNotMatch(DESKTOP_BACKEND_SOURCE, /join\(desktopHome\(\), RUNTIME_DIRNAME\)/)
  assert.match(COMPONENTS_CJS_SOURCE, /const RUNTIME_STORE_ENV = 'SCHOLARSEED_RUNTIME_STORE'/)
  assert.match(COMPONENTS_CJS_SOURCE, /if defined \$\{RUNTIME_STORE_ENV\} \(set "SS_RUNTIME=%\$\{RUNTIME_STORE_ENV\}%"\) else \(if defined \$\{HOME_ENV\}/)
})
test('uninstaller clears re-acquirable caches: transient-only on update, full sweep on real uninstall', () => {
  // 用户目录残留的是「可再获取」缓存（组件 store 数 GB + 暂存包），不是用户数据；NSIS 卸载器
  // 默认只清 INSTDIR。两档语义钉死：版本更新（旧卸载器带 --updated）只删不一致瞬态
  // （staging/locks），components/manifests 必须活过更新（proposal 108 P2a 跨版本命中）；
  // 真卸载整删 store 与暂存包缓存，但 .scholarseed 其余内容一字不动。更新档不碰暂存包缓存——
  // 新安装器正从其中那个 exe 运行。
  const customUnInstall = INSTALLER_NSH.match(/\n!macro customUnInstall\r?\n([\s\S]*?)\n!macroend/)
  assert.ok(customUnInstall, 'customUnInstall macro not found')
  // store 根与 Node/.cmd 同源三档：env 登记优先，否则默认路径。
  assert.match(customUnInstall[1], /ReadEnvStr \$R0 "SCHOLARSEED_RUNTIME_STORE"/)
  assert.match(customUnInstall[1], /StrCpy \$R0 "\$PROFILE\\\.scholarseed\\runtime"/)
  assert.match(customUnInstall[1], /\$\{if\} \$\{isUpdated\}\r?\n\s*RMDir \/r "\$R0\\staging"\r?\n\s*RMDir \/r "\$R0\\locks"\r?\n\s*\$\{else\}\r?\n\s*RMDir \/r "\$R0"\r?\n\s*DeleteRegValue HKCU "Environment" "SCHOLARSEED_RUNTIME_STORE"\r?\n\s*System::Call 'user32::SendMessageTimeout[^\n]*\r?\n\s*RMDir \/r "\$LOCALAPPDATA\\scholarseed-update"\r?\n\s*\$\{endIf\}/)
  // 不得整删用户 home 或 .scholarseed 根（用户数据）：只允许删 $R0（store 根）与暂存包缓存。
  assert.doesNotMatch(customUnInstall[1], /RMDir \/r "\$PROFILE"/)
  assert.doesNotMatch(customUnInstall[1], /RMDir \/r "\$R0\\(?!staging|locks)/)
  // 目录名与 TS 事实源逐字对齐，防 nsh 手抄走样。
  assert.match(DESKTOP_BACKEND_SOURCE, /SCHOLARSEED_HOME_DIRNAME = '\.scholarseed'/)
  assert.match(COMPONENTS_CJS_SOURCE, /const RUNTIME_DIRNAME = 'runtime'/)
  assert.match(COMPONENTS_CJS_SOURCE, /const STAGING_DIRNAME = 'staging'/)
  assert.match(COMPONENTS_CJS_SOURCE, /const LOCKS_DIRNAME = 'locks'/)
  assert.match(UPDATER_SOURCE, /UPDATE_CACHE_DIRNAME = 'scholarseed-update'/)
})
test('runtime store path is exposed read-only through the bridge for the about page', () => {
  // 展示链路四层齐全：主进程 handle（解析口收 null 不甩异常给渲染层）→ preload → 桥类型 →
  // web 形态 stub；关于页只读展示、不给改（改 = 数 GB 重解压，入口锁在首装向导）。
  assert.match(SHELL_SOURCE, /ipcMain\.handle\('scholarseed:runtime-store-path', \(\) => runtimeStoreRoot\(\)\)/)
  assert.match(DESKTOP_BACKEND_SOURCE, /export function runtimeStoreRoot\(\): string \| null/)
  assert.match(PRELOAD_SOURCE, /ipcRenderer\.invoke\('scholarseed:runtime-store-path'\)/)
  const GLOBAL_D_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'global.d.ts'), 'utf8')
  assert.match(GLOBAL_D_SOURCE, /runtimeStorePath: \(\) => Promise<string \| null>/)
  const BROWSER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'browser.ts'), 'utf8')
  assert.match(BROWSER_SOURCE, /runtimeStorePath: async \(\) => null/)
  const ACCOUNT_PANEL_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'business', 'AccountPanel.tsx'), 'utf8')
  assert.match(ACCOUNT_PANEL_SOURCE, /data-testid="about-runtime-store"/)
  assert.match(ACCOUNT_PANEL_SOURCE, /runtimeStore \?\? t\('accountPanel\.about\.runtimeStoreUnavailable'\)/)
  // 只读：关于页不得出现改路径的控件（pick-dir 只允许出现在首装侧/其它既有面）。
  const aboutPage = ACCOUNT_PANEL_SOURCE.match(/function AboutPage\(\)[\s\S]*?\nfunction /)
  assert.ok(aboutPage, 'AboutPage function not found')
  assert.doesNotMatch(aboutPage[0], /pickDir|NSD_CreateDirRequest|runtimeStorePath\(\)\.then\([^)]*set.*[Ee]dit/)
})
test('first-install wizard offers an optional component store location, skipped otherwise', () => {
  // 首装高级步骤：留空 = 默认（透明），仅非空且校验通过才登记 env；非首装场景全部 PRE 跳页。
  assert.match(INSTALLER_NSH, /!macro customPageAfterChangeDir\r?\n\s*!insertmacro MUI_PAGE_INIT\r?\n\s*PageEx custom\r?\n\s*PageCallbacks ssStorePagePre ssStorePageLeave/)
  const pre = INSTALLER_NSH.match(/\n\s*Function ssStorePagePre\r?\n([\s\S]*?)\n\s*FunctionEnd/)
  assert.ok(pre, 'ssStorePagePre function not found')
  assert.match(pre[1], /\$\{if\} \$\{isUpdated\}\r?\n\s*Abort/)
  assert.match(pre[1], /\$\{if\} \$hasPerUserInstallation == "1"\r?\n\s*Abort/)
  assert.match(pre[1], /\$\{if\} \$hasPerMachineInstallation == "1"\r?\n\s*Abort/)
  assert.match(pre[1], /ReadEnvStr \$R0 "SCHOLARSEED_RUNTIME_STORE"\r?\n\s*StrCmp \$R0 "" ss_store_show\r?\n\s*Abort/)
  const leave = INSTALLER_NSH.match(/\n\s*Function ssStorePageLeave\r?\n([\s\S]*?)\n\s*FunctionEnd/)
  assert.ok(leave, 'ssStorePageLeave function not found')
  assert.match(leave[1], /StrCmp \$R4 "" ss_leave_done/)
  assert.match(leave[1], /StrCmp \$R5 "\\\\" ss_store_valid/)
  assert.match(leave[1], /CreateDirectory "\$R4\\ScholarSeedWriteProbe"/)
  assert.match(leave[1], /RMDir "\$R4\\ScholarSeedWriteProbe"/)
  assert.match(leave[1], /WriteRegStr HKCU "Environment" "SCHOLARSEED_RUNTIME_STORE" "\$R4"/)
  assert.match(leave[1], /SendMessageTimeout\(i 0xffff, i 0x001A/)
})
test('the updater refuses to spawn a second installer while a previous one is alive', () => {
  // 2026-09-22 真机事故：重拉的客户端对着还挂着的安装器再 spawn 一个，被模板
  // ALLOW_ONLY_ONE_INSTALLER_INSTANCE 的 CreateMutex 命中后 Abort（退出码 2、无 ready.ini），
  // 用户拿到一张「更新安装失败」卡，而真安装器窗口还停在向导页等点击。闸门 = 握手目录里
  // ready.ini 的 installerPid + 创建时刻双判据（PID 被复用即视为已退，见 handshake.ts），
  // 命中时回报独立分类，而不是笼统失败诱导用户对着互斥量重试。
  assert.match(UPDATER_SOURCE, /async function findRunningProtocolInstaller/)
  assert.match(UPDATER_SOURCE, /readyPointsToLiveProcess\(record, Number\(record\.installerPid\), low, high\)/)
  assert.match(UPDATER_SOURCE, /event: 'concurrent-installer'/)
  assert.match(UPDATER_SOURCE, /return \{ ok: false, errorFallback: 'install_already_running' \}/)
  // 分类三层齐全：契约类型、主进程标注、渲染层文案映射，缺一层就退回笼统「安装失败」。
  assert.match(UPDATE_CONTRACT_SOURCE, /\| 'install_already_running'/)
  assert.match(UPDATE_FEATURE_SOURCE, /install_already_running/)
})
test('Windows updater command parses as PowerShell before signature verification', {
  skip: process.platform !== 'win32' && 'requires the Windows PowerShell parser'
}, () => {
  // Syntax gate on the actual command expression (shared extractor catches script assembly
  // regressions), not packaged application/update acceptance.
  const script = windowsVerifyScript()
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$tokens = $null;',
    '$errors = $null;',
    '[void][System.Management.Automation.Language.Parser]::ParseInput(',
    '$env:SCHOLARSEED_TEST_UPDATE_SCRIPT, [ref]$tokens, [ref]$errors);',
    'if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }'
  ].join(' ')], {
    encoding: 'utf8',
    env: { ...process.env, SCHOLARSEED_TEST_UPDATE_SCRIPT: script }
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
// ── 更新面三条不变量（bug 86968393）─────────────────────────────────────────
// updater.ts / index.ts 都导不进 node --test（依赖 electron 与无扩展名相对导入），
// 所以这三条按源码形状钉住；行为本身由渲染层纯函数测试与真实产品验收覆盖。

test('the shell never discards the staged package before the install result is known', () => {
  // 安装器被拉起来不等于装成了：Windows 侧拿不到退出码，macOS 侧要等新进程回写 confirm。
  // 提前清掉暂存态，失败时用户既看不到「已就绪」也看不到错误。收口在 initialUpdateSnapshot
  // 的新旧比较：装成了就连记录带包体一起回收，没装成就都留着可直接重试。
  assert.doesNotMatch(SHELL_SOURCE, /clearReadyState/)
  assert.match(UPDATER_SOURCE, /export function clearReadyState/)
})

test('a staged package never pins the client to a superseded build', () => {
  // 「已就绪」是等用户挑时间重启的**等待**态，不是下载/安装那种进行中态：等待期间线上还会
  // 继续发布，检查发现更新的构建必须能推进过去。把 ready 当成进行中，界面就被钉死在当初
  // 暂存的那一个包上 —— 用户装完还不是最新，只能一级一级升（Aone 87009973）。
  const inFlight = /const UPDATE_IN_FLIGHT_PHASES = new Set<UpdatePhase>\(\[([\s\S]*?)\]\)/
    .exec(SHELL_SOURCE)
  assert.ok(inFlight, 'UPDATE_IN_FLIGHT_PHASES not found')
  // 断言集合本体而不是子串：注释里点名 'ready' 解释「为什么不在其中」不该让断言通过。
  const phases = [...inFlight[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]).sort()
  assert.deepEqual(phases, ['downloading', 'installing', 'manual', 'restarting', 'verifying'])

  // 推进判定只此一份：启动期检查、周期复查、手动「检查更新」三个入口共用，才不会一个能
  // 推进另一个不能。
  assert.match(SHELL_SOURCE, /function publishUpdateCheckResult\(result: UpdateCheckResult\)/)
  assert.match(SHELL_SOURCE, /const result = await updater\.checkForUpdate\(pushLog\)\n      return publishUpdateCheckResult\(result\)/)
  assert.match(SHELL_SOURCE, /void updater\.checkForUpdate\(pushLog\)\.then\(\(result\) => \{\n    publishUpdateCheckResult\(result\)/)

  // 只有线上候选**严格**新于暂存包才推进；排不出先后（身份串不合契约，isNewerRelease 回 null）
  // 一律不动，已经下好并校验过的那一个继续有效。
  assert.match(UPDATER_SOURCE, /export function supersedeStagedUpdate\(/)
  assert.match(UPDATER_SOURCE, /if \(newer !== true\) return false/)
  // 取代时记录与包体一起回收：只清记录会让几百 MB 一直躺在磁盘上，只删包体会让下一次启动
  // 因为记录还在而重新认领它。
  assert.match(UPDATER_SOURCE, /function dropStagedUpdate\(staged: ReadyState, log: LogSink\): void \{\n  clearReadyState\(\)\n  removeStaleInstaller\(staged\.path, log\)/)
  assert.match(UPDATER_SOURCE, /dropStagedUpdate\(staged, log\)\n  return true/)

  // 安装失败把相位留在 ready 并带上错误（bug 86968393）：那是唯一的结果表面，检查不得用
  // 「发现新版本」把它悄悄换掉。
  assert.match(SHELL_SOURCE, /if \(snapshot\.error \|\| snapshot\.errorFallback\) return snapshot/)
})

test('the renderer holds no cross-restart update state', () => {
  // 窗口 origin 含后端随机端口（listen(0)），localStorage 按 origin 分区：写在渲染层的
  // 「弹窗已收起」每次启动都读不回来，更新内容弹窗会反复自动弹。
  assert.doesNotMatch(UPDATE_FEATURE_SOURCE, /localStorage\s*\.\s*(getItem|setItem|removeItem|clear)/)
  assert.match(UPDATE_FEATURE_SOURCE, /state\?\.announcedKey === key/)
  assert.match(UPDATER_SOURCE, /ANNOUNCED_STATE_FILE = 'announced\.json'/)
})

test('every snapshot the shell publishes carries the announcement acknowledgement', () => {
  // 部分发布点是新构造的对象而不是展开当前快照；漏盖一次就等于把用户的确认丢掉。
  assert.match(SHELL_SOURCE, /function publishUpdateSnapshot\(next: UpdateSnapshot\): UpdateSnapshot \{\n  const stamped = withAnnouncedKey\(next\)/)
  assert.match(SHELL_SOURCE, /updateSnapshot = withAnnouncedKey\(/)
  assert.match(SHELL_SOURCE, /scholarseed:update-announce-ack/)
})

test('progress publication clears the previous failure so a retry is not shown as failed', () => {
  // 「有 error 即失败呈现」这条判据成立的前提：成功路径必须把上一次失败的三个字段一起清掉。
  // errorOrigin 漏清不会立刻出错，但会让下一次失败沿用上一次的动作来源、报错误的文案。
  assert.match(
    SHELL_SOURCE,
    /function publishUpdateProgress[\s\S]{0,500}error: undefined,\n    errorFallback: undefined,\n    errorOrigin: undefined,\n    resumable: undefined/)
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
    /ipcMain\.handle\('scholarseed:update-refresh', \(\): void => \{\n    runBackgroundUpdateCheck\(\)\n  \}\)/)

  // 三个安装入口一个都不能漏。UpdatePanel 挂载 == 卡片被打开：工作台活动栏火箭与 0.1 侧栏
  // 药丸两个入口表面都只在展开时渲染它，挂这一处即同时覆盖；AccountPanel 关于页自带
  // 「重启安装」按钮且不渲染 UpdatePanel，必须单独挂。空依赖数组钉住「只在挂载时刷一次」，
  // 每次 render 都发一遍检查不是本不变量的语义。
  const mountRefresh = /React\.useEffect\(\(\) => \{\n    void window\.scholarseed\.refreshUpdate\(\)\n  \}, \[\]\)/
  assert.match(UPDATE_PANEL_SOURCE, mountRefresh)
  assert.match(ACCOUNT_PANEL_SOURCE, mountRefresh)

  // 桥接三件套缺一 typecheck 红：preload 实现、typed contract、浏览器模式桩。
  // web 形态没有更新通路（恒 upToDate、从不带候选包），静默刷新如实无操作。
  assert.match(PRELOAD_SOURCE, /ipcRenderer\.invoke\('scholarseed:update-refresh'\)/)
  assert.match(BRIDGE_TYPES_SOURCE, /refreshUpdate: \(\) => Promise<void>/)
  assert.match(BROWSER_BRIDGE_SOURCE, /refreshUpdate: async \(\) => \{\},/)
})

test('macOS candidates do not require signing credentials', () => {
  const parsed = options(['--platform', 'darwin', '--arch', 'arm64', '--type', 'preview',
    '--candidate', '--update-base-url', 'https://updates.example.test'])
  assert.equal(parsed.signed, false)
  assert.equal(parsed.candidate, true)
})

test('macOS candidate dir checks stop before codesigning', () => {
  assert.equal(unsignedPackageCheck({
    platform: 'darwin', stage: 'dir', candidate: true, signingRequired: false
  }), true)
  assert.equal(unsignedPackageCheck({
    platform: 'darwin', stage: 'dmg', candidate: true, signingRequired: false
  }), false)
  assert.equal(unsignedPackageCheck({
    platform: 'win32', stage: 'dir', candidate: true, signingRequired: false
  }), false)
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
    '--type', 'release', '--candidate', '--update-base-url', 'https://updates.example.test'
  ]
  const parsed = options(base)
  assert.equal(parsed.lane, 'distribution')
  assert.equal(Object.hasOwn(parsed, 'verification'), false)
  assert.equal(parsed.candidate, true)
  assert.throws(() => options(base.map((value) => value === 'https://updates.example.test' ? 'http://updates.example.test' : value)), /HTTPS/)
  assert.throws(() => options(base.filter((value, index) => base[index - 1] !== '--update-base-url' && value !== '--update-base-url')), /require/)
})
test('credentials do not reach offline child builds', () => {
  const source = { PATH: '/bin', SCHOLARSEED_SKILLHUB_TOKEN: 'fixture',
    SCHOLARSEED_SKILLHUB_TOKEN_FILE: '/fixture', SCHOLARSEED_WINDOWS_SIGN_KEY: 'signing-secret',
    SCHOLARSEED_HOME: '/runtime' }
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
  } finally { fs.rmSync(directory, { recursive: true }) }
})
test('Electron Builder template rendering remains compatible with the EJS override', () => {
  const { compile } = require('ejs')
  const builder = path.dirname(require.resolve('app-builder-lib/package.json'))
  const source = fs.readFileSync(path.join(builder, 'templates', 'msi', 'template.xml'), 'utf8')
  const template = source.replace(/{{/g, '<%').replace(/}}/g, '%>').replace(/\${([^}]+)}/g, '<%=$1%>')
  assert.equal(typeof compile(template), 'function')
})
test('installed dependency probes receive only product and system executable roots', () => {
  if (process.platform === 'win32') {
    const joined = productPath('/app/python/bin', '/app/bin')
    const parts = joined.split(path.delimiter)
    assert.deepEqual(parts.slice(0, 2), ['/app/python/bin', '/app/bin'])
    const system = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
    assert.deepEqual(parts.slice(2), system)
  } else {
    assert.equal(productPath('/app/python/bin', '/app/bin'), '/app/python/bin:/app/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  }
})
test('bundled workspace distributions are installed only from immutable wheels', () => {
  assert.match(BUNDLE_BACKEND_SOURCE, /'runtime', 'packages\/runtime'/)
  assert.doesNotMatch(BUNDLE_BACKEND_SOURCE, /packages\/damoagent/)
  assert.match(BUNDLE_BACKEND_SOURCE, /'scripts', 'wheel.py'/)
  assert.match(BUNDLE_BACKEND_SOURCE, /'--builder', 'pip'/)
  assert.match(BUNDLE_BACKEND_SOURCE, /'pip', 'sync'/)
  assert.match(BUNDLE_BACKEND_SOURCE, /'--require-hashes'/)
  assert.match(BUNDLE_BACKEND_SOURCE, /'--no-deps', '--no-index'/)
  assert.match(VERIFY_SOURCE, /frozen\.pythonDependencies\.inventory_sha256/)
  assert.match(VERIFY_SOURCE, /VERIFIER_FILENAME\), 'verify'/)
  assert.match(BUNDLE_BACKEND_SOURCE, /--no-sources/)
  assert.match(BUNDLE_BACKEND_SOURCE, /const wheels = \[\]/)
  assert.doesNotMatch(BUNDLE_BACKEND_SOURCE, /uv_bin" pip install[\s\S]*"\$pkg"/)
  // editable 残留断言随探针脚本移入 probe.cjs（bundle.cjs 经 RUNTIME_PROBE_SCRIPT 执行）
  assert.match(PROBE_SOURCE, /__editable__/)
  assert.match(PROBE_SOURCE, /direct_url\.json/)
  assert.match(BUNDLE_BACKEND_SOURCE, /RUNTIME_PROBE_SCRIPT/)
  assert.doesNotMatch(BUNDLE_BACKEND_SOURCE, /shell: process\.platform/)
})
test('artifact verification imports the packaged runtime and starts its real health endpoint', () => {
  for (const moduleName of ['scholarseed_runtime', 'damoatrace', 'service.cli.serve', 'scholarseed_codex']) {
    assert.match(RUNTIME_PROBE_SCRIPT, new RegExp(moduleName.replaceAll('.', '\\.')))
  }
  assert.match(RUNTIME_PROBE_SCRIPT, /is_relative_to/)
  assert.match(VERIFY_SOURCE, /--package-check/)
  assert.match(VERIFY_SOURCE, /payload\.backend/)
  assert.match(VERIFY_SOURCE, /payload\.renderer/)
  assert.match(VERIFY_SOURCE, /SCHOLARSEED_PRODUCT_MANIFEST: required\[6\]/)
  assert.match(VERIFY_SOURCE, /artifactTemporaryRoot\(frozen.platform\)/)
})
test('package-check diagnostics preserve process output and failure metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-package-check-log-'))
  try {
    const filename = packageCheckLog({ runDirectory: directory }, 'unpacked', 'ScholarSeed.exe', {
      status: null, signal: 'SIGTERM',
      error: new Error('spawn timeout'), stdout: '[shell] backend exited\n',
      stderr: 'AttributeError: AF_UNIX\n'
    })
    const output = fs.readFileSync(filename, 'utf8')
    assert.match(output, /ScholarSeed\.exe/)
    assert.match(output, /spawn timeout/)
    assert.match(output, /backend exited/)
    assert.match(output, /AttributeError: AF_UNIX/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('package-check temporary cleanup is best-effort after successful verification', () => {
  const warn = console.warn
  const rmSync = fs.rmSync
  const directory = path.join(os.tmpdir(), `scholarseed-package-check-locked-${crypto.randomUUID()}`)
  try {
    const warnings = []
    console.warn = message => warnings.push(message)
    fs.rmSync = candidate => {
      if (candidate === directory) {
        const error = new Error('EPERM: operation not permitted')
        error.code = 'EPERM'
        throw error
      }
      return rmSync(candidate, { recursive: true, force: true })
    }
    assert.doesNotThrow(() => bestEffortRemoveTemporary(directory, 0))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /could not remove temporary directory/)
  } finally {
    fs.rmSync = rmSync
    console.warn = warn
  }
})
test('artifact verification keeps the macOS local bridge below the Unix socket path limit', () => {
  const endpoint = path.join(
    fs.realpathSync(artifactTemporaryRoot('darwin')),
    'scholarseed-package-check-XXXXXX',
    'home',
    'service',
    'bridge',
    'endpoint-XXXXXXXXXXXX',
    'api.sock'
  )
  assert.ok(Buffer.byteLength(endpoint) < DARWIN_UNIX_SOCKET_PATH_BYTES)
  assert.equal(artifactTemporaryRoot('linux'), os.tmpdir())
  assert.equal(artifactTemporaryRoot('win32'), os.tmpdir())
})
test('desktop projects the immutable product manifest into its Python child', () => {
  assert.match(DESKTOP_BACKEND_SOURCE, /SCHOLARSEED_PRODUCT_MANIFEST/)
  assert.match(DESKTOP_BACKEND_SOURCE, /env\[SCHOLARSEED_PRODUCT_MANIFEST_ENV\]/)
  assert.match(DESKTOP_BACKEND_SOURCE, /resolvedProductConfig\.source/)
  assert.match(DESKTOP_BACKEND_SOURCE, /config: SECURE_PACKAGED_FALLBACK, source/)
})
test('packaged default runtime carries the complete Serve product metadata', () => {
  const runtime = PRODUCT_POLICY.runtimes[PRODUCT_POLICY.default_runtime]
  for (const field of [
    'display_name',
    'client_name',
    'client_title',
    'service_name'
  ]) {
    assert.equal(typeof runtime[field], 'string')
    assert.ok(runtime[field].trim(), `${field} must be non-empty`)
  }
  for (const field of ['sandbox', 'approval_policy', 'full_access_sandbox', 'no_approval_policy']) {
    assert.equal(typeof runtime.default_permission[field], 'string')
    assert.ok(runtime.default_permission[field].trim(), `default_permission.${field} must be non-empty`)
  }
})
test('developer entry points share locked dependency installation', () => {
  for (const script of ['dev', 'build', 'test', 'typecheck', 'package:check', 'package:dist']) {
    assert.match(ROOT_PACKAGE.scripts[script], /scripts\/desktop\.cjs|npm run package/)
  }
  for (const script of ['desktop', 'health', 'serve']) {
    assert.match(ROOT_PACKAGE.scripts[script], /scripts\/workspace\.cjs/)
  }
  assert.doesNotMatch(WORKSPACE_SOURCE, /RESOLVE_LOCAL_CODEX|command -v codex|shasum/)
  assert.match(WORKSPACE_SOURCE, /scripts\/toolchain\.cjs', 'codex'/)
})

const PACKAGING_ENTRY = path.join(__dirname, 'build.cjs')
// Only the post-install loader may touch third-party modules; everything it requires
// is resolved after npm ci, so the file head must stay resolvable on a bare checkout.
const POST_INSTALL_LOADER = /function loadDependencies\(\) \{[\s\S]*?\n\}/
const REQUIRED_SPECIFIER = /require\(\s*['"]([^'"]+)['"]\s*\)/g

function requiredSpecifiers(source) {
  return [...source.matchAll(REQUIRED_SPECIFIER)].map(match => match[1])
}

function loadTimeModuleGraph(entry, source) {
  const graph = new Set()
  const pending = requiredSpecifiers(source)
    .filter(name => name.startsWith('.'))
    .map(name => path.resolve(path.dirname(entry), name))
  while (pending.length) {
    const file = pending.pop()
    if (graph.has(file)) continue
    graph.add(file)
    pending.push(...requiredSpecifiers(fs.readFileSync(file, 'utf8'))
      .filter(name => name.startsWith('.'))
      .map(name => path.resolve(path.dirname(file), name)))
  }
  return [...graph]
}

test('packaging entry loads third-party modules only after installing locked dependencies', () => {
  const entrySource = fs.readFileSync(PACKAGING_ENTRY, 'utf8')
  const headSource = entrySource.replace(POST_INSTALL_LOADER, '')
  assert.notEqual(headSource, entrySource, `${PACKAGING_ENTRY} must keep its post-install loader`)
  for (const file of [PACKAGING_ENTRY, ...loadTimeModuleGraph(PACKAGING_ENTRY, headSource)]) {
    const loaded = file === PACKAGING_ENTRY
      ? headSource : fs.readFileSync(file, 'utf8').replace(POST_INSTALL_LOADER, '')
    const thirdParty = requiredSpecifiers(loaded)
      .filter(name => !name.startsWith('node:') && !name.startsWith('.'))
    assert.deepEqual(thirdParty, [], `${path.relative(REPO_ROOT, file)} is required before npm ci`)
  }
  const body = entrySource.slice(entrySource.indexOf('async function main('))
  const installed = body.indexOf('ensureNodeDependencies()')
  const loaded = body.indexOf('loadDependencies()')
  assert.ok(installed >= 0 && loaded > installed,
    'main() must install locked dependencies before loading third-party modules')
  const clean = body.indexOf('assertCleanWorktree()')
  assert.ok(clean >= 0 && installed > clean,
    'main() must verify a clean worktree before installing locked dependencies')
})

test('desktop development identity uses the branch name and detached HEAD fallback', () => {
  const branchGit = (_command, args) => args.includes('--show-current') ? 'feature/branch-label\n' : 'unused\n'
  const detachedGit = (_command, args) => args.includes('--show-current') ? '\n' : '86aa803b1234\n'

  assert.equal(resolveGitIdentity(REPO_ROOT, branchGit), 'feature/branch-label')
  assert.equal(resolveGitIdentity(REPO_ROOT, detachedGit), '86aa803b1234')
  assert.equal(developmentDisplayName('feature/branch-label'), '书深 · feature/branch-label')
})
test('desktop development identity updates only macOS bundle display keys', () => {
  const calls = []
  const run = (command, args) => calls.push([command, args])

  assert.equal(updateMacBundleName('/tmp/Electron.app/Contents/Info.plist', '书深 · feature/one', 'linux', run), false)
  assert.deepEqual(calls, [])
  assert.equal(updateMacBundleName('/tmp/Electron.app/Contents/Info.plist', '书深 · feature/one', 'darwin', run), true)
  assert.deepEqual(calls, [
    ['/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', '书深 · feature/one', '/tmp/Electron.app/Contents/Info.plist']],
    ['/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', '书深 · feature/one', '/tmp/Electron.app/Contents/Info.plist']]
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
  } finally { fs.rmSync(directory, { recursive: true }) }
})
test('release evidence uses SHA-256 and SHA-512 over the same immutable bytes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-hash-contract-'))
  try {
    const artifact = path.join(directory, 'artifact.dmg')
    fs.writeFileSync(artifact, 'book-depth')
    assert.match(await sha256(artifact), /^[a-f0-9]{64}$/)
    assert.match(await sha512(artifact), /^[a-f0-9]{128}$/)
  } finally { fs.rmSync(directory, { recursive: true }) }
})
test('frozen distribution product policy is product-scoped and HTTPS-only', () => {
  const product = frozenProductConfiguration({
    type: 'release',
    lane: 'distribution',
    channel: 'release',
    buildNumber: '202608271200',
    'update-base-url': 'https://updates.example.test/',
    'team-id': 'A1B2C3D4E5'
  }, REVIEWED_BINARIES)
  assert.equal(product.product_id, 'scholarseed')
  assert.equal(product.bundle_id, 'com.scholarseed.desktop')
  assert.equal(product.release_lane, 'distribution')
  assert.equal(product.update_channel, 'release')
  // app.getVersion() carries only the SemVer, so the build stamp must travel here.
  assert.equal(product.build_number, '202608271200')
  assert.equal(product.update_base_url, 'https://updates.example.test')
  assert.equal(product.expected_team_id, 'A1B2C3D4E5')
  assert.equal(product.credential_profiles.distribution.key_provider, 'system_keychain')
  assert.equal(PRODUCT_POLICY.credential_profiles.local.key_provider, 'mock_keychain')
  assert.equal(product.runtimes.codex.executable_sha256, REVIEWED_BINARIES.codex.executable_sha256)
  assert.equal(product.default_runtime, 'codex')
  assert.equal(product.runtimes.dsh, undefined)
  assert.throws(
    () => frozenProductConfiguration({ lane: 'local', type: 'preview', channel: 'preview' }, {
      ...REVIEWED_BINARIES,
      codex: { ...REVIEWED_BINARIES.codex, source: undefined }
    }),
    /lacks verified official release evidence/
  )
})
test('frozen Windows product policy carries the Authenticode publisher', () => {
  const product = frozenProductConfiguration({
    type: 'release', lane: 'distribution', channel: 'release',
    buildNumber: '202608271200',
    'update-base-url': 'https://updates.example.test/',
    'windows-publisher': 'CN=ScholarSeed Test Publisher'
  }, REVIEWED_BINARIES)
  assert.equal(product.expected_team_id, '')
  assert.equal(product.build_number, '202608271200')
  assert.equal(product.expected_windows_publisher, 'CN=ScholarSeed Test Publisher')
})
test('electron-builder receives one frozen resource set instead of merging package resources twice', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-builder-config-'))
  try {
    const filename = writeBuilderConfiguration({
      runDirectory: directory,
      resourceRoot: path.join(directory, 'resources'),
      output: path.join(directory, 'artifacts'),
      productName: 'ScholarSeed'
    }, { version: '0.1.1', type: 'dev', platform: 'darwin', arch: 'arm64', lane: 'local', signed: false,
      candidate: false, target: require('./target.cjs').target('darwin', 'arm64') })
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const backend = config.extraResources.filter((entry) => entry.to === 'backend')
    assert.equal(backend.length, 1)
    assert.equal(backend[0].from, path.join(directory, 'resources', 'backend'))
    assert.equal(config.extraResources.find(entry => entry.to === 'notices').from,
      path.join(directory, 'resources', 'notices'))
    assert.equal(config.directories.output, path.join(directory, 'artifacts'))
    assert.equal(config.productName, 'ScholarSeed')
    assert.equal(config.artifactName, 'scholarseed-0.1.1-darwin-arm64.${ext}')
    assert.ok([
      directory,
      path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules', 'electron', 'dist')
    ].includes(config.electronDist))
    assert.equal(config.mac.identity, null)
    assert.equal(Object.hasOwn(config.mac, 'sign'), false)
    assert.equal(config.mac.hardenedRuntime, true)
    assert.equal(config.mac.entitlements, 'resources/entitlements.mac.plist')
    assert.equal(config.mac.extendInfo.CFBundleDevelopmentRegion, 'en')
    assert.equal(config.mac.extendInfo.CFBundleDisplayName, 'ScholarSeed')
    assert.equal(config.mac.extendInfo.CFBundleSpokenName, '书深')
    assert.equal(config.mac.extendInfo.LSHasLocalizedDisplayName, true)
    assert.ok(config.mac.extendInfo.MDItemKeywords.includes('书深'))
    assert.deepEqual(config.extraResources.find((entry) => entry.to === 'zh_CN.lproj'), {
      from: 'resources/mac/zh_CN.lproj',
      to: 'zh_CN.lproj',
      filter: ['InfoPlist.strings']
    })
    assert.deepEqual(config.extraResources.find((entry) => entry.to === 'en.lproj'), {
      from: 'resources/mac/en.lproj',
      to: 'en.lproj',
      filter: ['InfoPlist.strings']
    })
    assert.equal(config.nsis.shortcutName, '书深')
    assert.deepEqual(config.mac.signIgnore, [
      '/Contents/Resources/backend/bin/codex$',
      '/Contents/Resources/backend/browser/node$',
      '/Contents/Resources/backend/codex-runtime(?:/|$)'
    ])
    assert.equal(config.afterPack, path.join(__dirname, 'sign.cjs'))
    assert.equal(config.afterAllArtifactBuild, path.join(__dirname, 'verify.cjs'))
    assert.equal(config.afterSign, path.join(__dirname, 'notarize.cjs'))
    assert.ok(config.files.includes('!out/renderer/**/*'))
  } finally { fs.rmSync(directory, { recursive: true }) }
})
test('Intel macOS uses the x64 Electron Builder architecture and the Intel runtime triple', () => {
  const selected = require('./target.cjs').target('darwin', 'x86_64')
  assert.equal(selected.builderArch, require('electron-builder').Arch.x64)
  assert.equal(selected.triple, 'x86_64-apple-darwin')
  assert.equal(selected.installer, 'dmg')
})
test('the frozen Office runtime asset set is complete and digest-verified', async () => {
  const manifest = await verifyOfficeAssets(path.join(__dirname, '..'))
  assert.equal(manifest.build_id, 'zeta-24-2-20250513')
  assert.equal(OFFICE_BUILD_DIRECTORY, 'zeta-20250513')
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'locales-residuals.json',
    'locales.data',
    'locales.json',
    'soffice.data',
    'soffice.data.js.metadata',
    'soffice.js',
    'soffice.wasm'
  ])
})
test('Office bilingual overlay contains contiguous verified native resources for every editor', () => {
  const root = path.join(__dirname, '..', 'src', 'renderer', 'public', 'office', OFFICE_BUILD_DIRECTORY)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'locales.json'), 'utf8'))
  const data = fs.readFileSync(path.join(root, manifest.data.file))
  assert.deepEqual(manifest.locales, ['en-US', 'zh-CN'])
  assert.equal(manifest.default_locale, 'zh-CN')
  assert.equal(data.length, manifest.data.bytes)
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), manifest.data.sha256)
  let end = 0
  for (const file of manifest.files) {
    assert.equal(file.start, end)
    assert.ok(file.end > file.start && file.end <= data.length)
    assert.equal(crypto.createHash('sha256').update(data.subarray(file.start, file.end)).digest('hex'), file.sha256)
    end = file.end
  }
  assert.equal(end, data.length)
  for (const domain of ['sc', 'sw', 'sd', 'sfx', 'svx']) {
    assert.ok(manifest.files.some(file => file.path === `/instdir/program/resource/zh_CN/LC_MESSAGES/${domain}.mo`))
  }
  assert.ok(fs.statSync(path.join(root, manifest.residuals)).size > 0)
})
test('local signing preserves only reviewed upstream signed runtimes', () => {
  const app = '/Applications/fixture.app'
  assert.equal(adHocOptions(app).ignore, shouldIgnore)
  assert.equal(preserveReviewedRuntime(`${app}/Contents/Resources/backend/bin/codex`), true)
  assert.equal(preserveReviewedRuntime(`${app}/Contents/Resources/backend/codex-runtime/bin/codex-code-mode-host`), true)
  assert.equal(preserveReviewedRuntime(`${app}/Contents/Resources/backend/bin/rg`), false)
})
test('NSIS useZip 与 differentialPackage 必须成对，缺一半拒绝构建（proposal 108 §6）', () => {
  // 默认：package.json 现状原样通过，不含 useZip
  const current = resolveNsisConfiguration(PACKAGE.build, {})
  assert.equal(current.shortcutName, PACKAGE.build.nsis.shortcutName)
  assert.equal(Object.hasOwn(current, 'useZip'), false)
  // 实验开关 =1：成对写入，其余键保留
  const zip = resolveNsisConfiguration(PACKAGE.build, { SCHOLARSEED_NSIS_USE_ZIP: '1' })
  assert.equal(zip.useZip, true)
  assert.equal(zip.differentialPackage, false)
  assert.equal(zip.shortcutName, PACKAGE.build.nsis.shortcutName)
  // 开关取值非法
  assert.throws(() => resolveNsisConfiguration(PACKAGE.build, { SCHOLARSEED_NSIS_USE_ZIP: 'yes' }),
    /accepts only "1"/)
  // 单独 useZip = 不可安装产物（7z 字节被命名成 app-64.zip），必须拒绝
  assert.throws(
    () => resolveNsisConfiguration({ nsis: { useZip: true } }, {}),
    /app-64\.zip/)
  // differentialPackage:true 视同缺失
  assert.throws(
    () => resolveNsisConfiguration({ nsis: { useZip: true, differentialPackage: true } }, {}),
    /app-64\.zip/)
  // 成对出现放行；显式关闭 useZip 不受影响
  assert.equal(resolveNsisConfiguration({ nsis: { useZip: true, differentialPackage: false } }, {}).useZip, true)
  assert.equal(resolveNsisConfiguration({ nsis: { useZip: false } }, {}).useZip, false)
})

test('生成的 electron-builder.json 携带解析后的 NSIS 配置且不引入 useZip 默认值', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-nsis-config-'))
  try {
    const context = {
      runDirectory: directory,
      resourceRoot: path.join(directory, 'resources'),
      output: path.join(directory, 'artifacts'),
      productName: 'ScholarSeed'
    }
    const filename = writeBuilderConfiguration(context, {
      version: '0.1.1', type: 'dev', platform: 'win32', arch: 'x86_64', lane: 'local',
      signed: false, candidate: false, target: require('./target.cjs').target('win32', 'x86_64')
    })
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    assert.equal(Object.hasOwn(config.nsis, 'useZip'), false)
    assert.equal(config.nsis.shortcutName, PACKAGE.build.nsis.shortcutName)
    assert.deepEqual(context.nsis, config.nsis)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Windows 载荷统计只数 win-unpacked 的常规文件', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-payload-'))
  try {
    const unpacked = path.join(directory, 'win-unpacked')
    fs.mkdirSync(path.join(unpacked, 'resources', 'backend'), { recursive: true })
    fs.writeFileSync(path.join(unpacked, 'ScholarSeed.exe'), 'x'.repeat(10))
    fs.writeFileSync(path.join(unpacked, 'resources', 'backend', 'python.exe'), 'y'.repeat(7))
    const args = { platform: 'win32', stage: 'nsis' }
    assert.deepEqual(payloadStatistics({ output: directory }, args),
      { root: 'win-unpacked', files: 2, bytes: 17 })
    assert.equal(payloadStatistics({ output: directory }, { platform: 'darwin', stage: 'dmg' }), null)
    assert.equal(payloadStatistics({ output: directory }, { platform: 'win32', stage: 'backend' }), null)
    assert.equal(payloadStatistics({ output: path.join(directory, 'missing') }, args), null)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('Windows 组件化载荷链路接线契约（proposal 108 §7，P2a）', () => {
  // 构建侧：产品 wheel 不进组件树；contentId 由冻结输入派生；松散树在打包证据冻结后删除。
  assert.match(BUNDLE_BACKEND_SOURCE, /writeProductLibraries\(run, python, wheels, pylibs\)/)
  assert.match(BUNDLE_BACKEND_SOURCE, /derivePythonContentId\(/)
  assert.match(BUNDLE_BACKEND_SOURCE, /deriveTexliveContentId\(/)
  assert.match(BUNDLE_BACKEND_SOURCE, /context\.runtime\.sha256/)
  // 组件树纯净性探针：产品发行物泄漏进 site-packages 必须构建失败
  assert.match(BUNDLE_BACKEND_SOURCE, /SCHOLARSEED_PRODUCT_LIBS: pylibs/)
  assert.match(BUNDLE_BACKEND_SOURCE, /RUNTIME_PROBE_SCRIPT/)
  // 打包顺序：packWindowsComponents 只在 dependencies verify 与锁拷贝之后被调用
  const packCall = BUILD_SOURCE.indexOf('context.components = packWindowsComponents')
  const verifierCall = BUILD_SOURCE.indexOf("'verify',")
  assert.ok(packCall > -1 && verifierCall > -1 && packCall > verifierCall,
    'component packing must run after the dependency verifier')
  // 产品步骤在 win32 换 -s -B + PYTHONPATH（-I 会忽略 PYTHONPATH，产品模块将不可导入）
  assert.match(BUILD_SOURCE, /const productFlags = args\.platform === 'win32' \? \['-s', '-B'\] : \['-I', '-B'\]/)
  // 包内验证：组件布局走摘要链 + 松散树必须不存在
  assert.match(VERIFY_SOURCE, /verifyComponentContent/)
  assert.match(VERIFY_SOURCE, /must not keep a loose/)
  assert.match(VERIFY_SOURCE, /appComponentsSha256/)
  // 启动侧：provision 先于 python 存在性检查；TeX 目录来自组件仓库；PYTHONPATH 注入 pylibs；
  // 失败 fail-closed（startupFailed），不得回落宿主 Python。
  const backendProvision = DESKTOP_BACKEND_SOURCE.indexOf('await ensureComponents(')
  const backendExists = DESKTOP_BACKEND_SOURCE.indexOf('if (!existsSync(python)) {')
  assert.ok(backendProvision > -1 && backendExists > -1 && backendProvision < backendExists,
    'component provisioning must complete before the python existence gate')
  assert.match(DESKTOP_BACKEND_SOURCE, /provisionedComponents\.texliveBinDirectory/)
  assert.match(DESKTOP_BACKEND_SOURCE, /\[PYTHONPATH_ENV\]: join\(cwd, PYLIBS_DIRNAME\)/)
  assert.match(DESKTOP_BACKEND_SOURCE, /component provisioning failed/)
  // SCHOLARSEED_PYTHON 显式覆盖优先于组件寻址（既有逃生门语义不变）
  assert.match(DESKTOP_BACKEND_SOURCE, /!process\.env\[SCHOLARSEED_PYTHON_ENV\] && existsSync\(manifestPath\)/)
})

test('distribution builder configuration never downgrades Developer ID discovery to ad-hoc signing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-builder-distribution-'))
  try {
    const filename = writeBuilderConfiguration({
      runDirectory: directory,
      resourceRoot: path.join(directory, 'resources'),
      output: path.join(directory, 'artifacts'),
      productName: 'ScholarSeed'
    }, { version: '0.1.1', type: 'release', platform: 'darwin', arch: 'arm64', lane: 'distribution', signed: true,
      candidate: false, target: require('./target.cjs').target('darwin', 'arm64') })
const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
    assert.equal(Object.hasOwn(config.mac, 'identity'), false)
    assert.equal(config.mac.sign, path.join(__dirname, 'signer.cjs'))
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('distribution verification requires Developer ID trust for signed ripgrep', () => {
  assert.match(VERIFY_SOURCE, /verifySignedRuntime\(current\.rg, frozen\.product\.config\.expected_team_id\)/)
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
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true }
    const restore = await trackSignProgress(app, () => false)
    try {
      process.stdout.write('electron-osx-sign Skipped... /resource +0ms\n')
      process.stdout.write('electron-osx-sign Signing... /one +0ms\n')
      process.stdout.write('electron-osx-sign Skipped... /another +0ms\n')
      process.stdout.write('electron-osx-sign Signing... /two +0ms\n')
    } finally { restore() }
  } finally {
    process.stdout.write = originalWrite
    fs.rmSync(directory, { recursive: true, force: true })
  }
  assert.deepEqual(lines, [
    'electron-osx-sign [1/2] Signing... /one +0ms\n',
    'electron-osx-sign [2/2] Signing... /two +0ms\n'
  ])
})
test('macOS signing targets Mach-O images and bundle directories only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-macho-'))
  try {
    const binary = path.join(directory, 'tool')
    fs.copyFileSync(process.execPath, binary)
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
    const ignore = signableIgnore(filename => filename === resource)
    assert.equal(ignore(binary), false)
    assert.equal(ignore(bundle), false)
    assert.equal(ignore(resource), true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('notary credentials prefer the keychain profile and reject partial API keys', () => {
  assert.deepEqual(credentials({ SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE: 'profile' }),
    ['--keychain-profile', 'profile'])
  assert.deepEqual(credentials({
    SCHOLARSEED_APPLE_API_KEY: '/key', SCHOLARSEED_APPLE_API_KEY_ID: 'key-id',
    SCHOLARSEED_APPLE_API_ISSUER: 'issuer'
  }), ['--key', '/key', '--key-id', 'key-id', '--issuer', 'issuer'])
  assert.throws(() => credentials({ SCHOLARSEED_APPLE_API_KEY: '/key' }), /required/)
})
test('notary polling reports progress and returns once the submission settles', () => {
  const statuses = ['In Progress', 'In Progress', 'Accepted']
  const polls = []
  const receipt = waitForNotarization('submission-id', [], {
    request: (submissionId) => { polls.push(submissionId); return { id: submissionId, status: statuses.shift() } },
    wait: () => {}
  })
  assert.equal(receipt.status, 'Accepted')
  assert.equal(polls.length, 3)
})
test('notary polling fails instead of waiting forever', () => {
  assert.throws(() => waitForNotarization('submission-id', [], {
    request: (submissionId) => ({ id: submissionId, status: 'In Progress' }),
    wait: () => {},
    maxPolls: 3
  }), /did not settle/)
})
