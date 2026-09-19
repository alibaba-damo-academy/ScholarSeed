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
  writeBuilderConfiguration
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
  RUNTIME_PROBE_SCRIPT
} = require('./verify.cjs')
const { sha256, sha512, executableDigest } = require('./digest.cjs')
const { OFFICE_BUILD_DIRECTORY, verifyOfficeAssets } = require('./office-assets.cjs')
const { ownedExecutable } = require('./windows-sign.cjs')
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
const MAKEFILE_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'Makefile'), 'utf8')
const BUNDLE_BACKEND_SOURCE = fs.readFileSync(path.join(__dirname, 'bundle.cjs'), 'utf8')
test('backend bundling uses current runtime and product configuration owners', () => {
  assert.ok(BUNDLE_BACKEND_SOURCE.includes("'runtime', 'packages/runtime'"))
  assert.ok(BUNDLE_BACKEND_SOURCE.includes('"scholarseed_runtime"'))
  assert.ok(!BUNDLE_BACKEND_SOURCE.includes('packages/damoagent'))
  assert.ok(!BUNDLE_BACKEND_SOURCE.includes('"damoagent"'))
})
const VERIFY_SOURCE = fs.readFileSync(path.join(__dirname, 'verify.cjs'), 'utf8')
const BUILD_SOURCE = fs.readFileSync(path.join(__dirname, 'build.cjs'), 'utf8')
const DESKTOP_BACKEND_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backend.ts'), 'utf8')
const UPDATER_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'updater.ts'), 'utf8')
const SHELL_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
const UPDATE_FEATURE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'src', 'features', 'updates', 'state.ts'), 'utf8')
const PRODUCT_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'product.json')))
const DEFAULT_RUNTIME_POLICY = PRODUCT_POLICY.runtimes[PRODUCT_POLICY.default_runtime]
const REVIEWED_BINARIES = {
  codex: {
    executable_sha256: 'a'.repeat(64),
    reported_version: '0.999.0',
    source: { package: '@openai/codex', distribution: 'git-lfs',
      archive_sha256: 'b'.repeat(64), integrity: 'sha512-fixture' }
  }
}

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
test('Windows updater verifies Authenticode before launching NSIS without a shell', () => {
  assert.match(UPDATER_SOURCE, /Get-AuthenticodeSignature/)
  assert.match(UPDATER_SOURCE, /WINDOWS_UPDATE_ARGUMENTS = \['--updated', '\/S', '--force-run'\]/)
  assert.match(UPDATER_SOURCE, /verifyWindowsInstaller\(installer, config\.expectedWindowsPublisher\)/)
  assert.match(UPDATER_SOURCE, /spawn\(installer, WINDOWS_UPDATE_ARGUMENTS/)
  assert.doesNotMatch(UPDATER_SOURCE, /spawn\(installer,[\s\S]{0,160}shell:/)
})
test('Windows updater command parses as PowerShell before signature verification', {
  skip: process.platform !== 'win32' && 'requires the Windows PowerShell parser'
}, () => {
  // Read the actual command expression so this catches script assembly regressions.
  // This is a syntax gate, not packaged application/update acceptance.
  const source = ts.createSourceFile('updater.ts', UPDATER_SOURCE, ts.ScriptTarget.Latest, true)
  const verifier = source.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'verifyWindowsInstaller')
  assert.ok(verifier)
  const declaration = verifier.body.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText(source) === 'script')
  assert.ok(declaration?.initializer)
  const script = runInNewContext(declaration.initializer.getText(source), {
    WINDOWS_INSTALLER_ENV: 'SCHOLARSEED_TEST_INSTALLER'
  })
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
  assert.match(SHELL_SOURCE, /updateInstallFailure\(result\.error\)/)
  assert.match(UPDATER_SOURCE, /errorOrigin: 'install'/)
})

test('macOS candidates do not require signing credentials', () => {
  const parsed = options(['--platform', 'darwin', '--arch', 'arm64', '--type', 'preview',
    '--candidate', '--update-base-url', 'https://updates.example.test'])
  assert.equal(parsed.signed, false)
  assert.equal(parsed.candidate, true)
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
  assert.match(BUNDLE_BACKEND_SOURCE, /__editable__/)
  assert.match(BUNDLE_BACKEND_SOURCE, /direct_url\.json/)
  assert.doesNotMatch(BUNDLE_BACKEND_SOURCE, /shell: process\.platform/)
})
test('artifact verification imports the packaged runtime and starts its real health endpoint', () => {
  for (const moduleName of ['scholarseed_runtime', 'damoatrace', 'service.cli.serve', 'scholarseed_codex', 'scholarseed_dsh']) {
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
  assert.match(MAKEFILE_SOURCE, /node scripts\/toolchain.cjs ensure/)
  for (const target of ['run', 'desktop', 'desktop-dev', 'health']) {
    assert.match(MAKEFILE_SOURCE, new RegExp(`^${target}:[^\\n]*\\bui-deps\\b`, 'm'))
  }
  assert.doesNotMatch(MAKEFILE_SOURCE, /RESOLVE_LOCAL_CODEX|command -v codex|shasum/)
  assert.match(MAKEFILE_SOURCE, /codex="\$\$\(node scripts\/toolchain.cjs codex\)"/)
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
  assert.equal(product.runtimes.dsh.enabled, false)
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
test('the frozen Office runtime asset set is complete and digest-verified', () => {
  const manifest = verifyOfficeAssets(path.join(__dirname, '..'))
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
