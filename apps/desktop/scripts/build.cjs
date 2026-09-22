#!/usr/bin/env node
// Desktop packaging owner for native macOS and Windows builds.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { executableDigest } = require('./digest.cjs')
const { REQUIREMENTS_FILENAME, INVENTORY_FILENAME, VERIFIER_FILENAME } = require('./bundle.cjs')
const { pythonRelease, verifyPythonArchive, verifyPython, verifyDevelopmentPython,
  developmentPython, nativeTar } = require('../../../scripts/python.cjs')
const { ensureRipgrep } = require('../../../scripts/ripgrep.cjs')
const { checkToolchain, ensureNodeDependencies } = require('../../../scripts/toolchain.cjs')
const { stageNotices } = require('./notices.cjs')
let dependencies

const DESKTOP = path.resolve(__dirname, '..')
const REPO = path.resolve(DESKTOP, '../..')
const PACKAGE = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json')))
const { PYLIBS_DIRNAME } = require('../runtime/components.cjs')
const PRODUCT_SOURCE = path.join(DESKTOP, 'resources', 'product.json')
const CONTEXT_ENV = 'SCHOLARSEED_BUILD_CONTEXT'
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/
const STAGES = new Set(['backend', 'dir', 'installer'])
const PUBLIC_TYPES = new Set(['preview', 'release'])
const CANDIDATE_FLAG = '--candidate'
const DEFAULT_REMOTE = 'origin'
const LOCAL_LANE = 'local'
const DISTRIBUTION_LANE = 'distribution'
const CONTEXT_SCHEMA = 3
const CREDENTIAL_PROVIDERS = { local: 'mock_keychain', distribution: 'system_keychain' }
const CREDENTIAL_ENV_PREFIXES = ['SCHOLARSEED_SKILLHUB_', 'SCHOLARSEED_WINDOWS_SIGN_']
const VERSION_PATTERN = /\d+\.\d+\.\d+/
// The published version is a plain three-part SemVer; the build stamp lives in its
// own field, so a version string never carries a timestamp or a commit suffix.
const SEMVER_VERSION = /^\d+\.\d+\.\d+$/
const BUILD_NUMBER = /^\d{12}$/
// Beijing 恒为 UTC+8（中国无夏令时），构建号直接加该固定秒数偏移。
const BUILD_NUMBER_OFFSET_SECONDS = 8 * 3600
const ELECTRON_CACHE_DIRECTORIES = [
  path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  path.join(os.homedir(), '.cache', 'electron')
]
const ARTIFACT_BASENAME = 'scholarseed'
const DMGBUILD_VERSION = '1.6.7'
const BUILD_TYPES = {
  dev: { channel: 'preview', lane: LOCAL_LANE, signed: false },
  preview: { channel: 'preview', lane: DISTRIBUTION_LANE, signed: true },
  release: { channel: 'release', lane: DISTRIBUTION_LANE, signed: true }
}
const OBSOLETE_ENV_PREFIX = 'VEDA_'
const OBSOLETE_ENV_ALLOWED = new Set(['VEDA_DESKTOP_DEFAULT_CONFIG'])
// P1 实验开关（proposal 108 §6）：=1 时生成 ZIP 直解压候选包（useZip + differentialPackage:false
// 成对写入）。默认（未设/为空）保持 package.json 现状。实验对照与生产启用由门槛决定，
// 不由这个开关单方面翻转。
const NSIS_ZIP_ENV = 'SCHOLARSEED_NSIS_USE_ZIP'

/**
 * NSIS 配置解析 + 配对不变量守卫。
 *
 * 26.15.7 NsisTarget 的归档格式是 `!isBuildDifferentialAware && useZip ? "zip" : "7z"`，
 * 而模板 defines（COMPRESSION_METHOD/ZIP_COMPRESSION）只看 useZip：单独启用 useZip 会把
 * 7z 字节以 app-64.zip 之名嵌进安装器，运行期 nsisunz 解压必失败（不可安装产物）。
 * 因此 useZip 为 true 时 differentialPackage 必须显式为 false，缺一即拒绝构建。
 */
function resolveNsisConfiguration(base, env = process.env) {
  const nsis = { ...(base.nsis || {}) }
  const requested = String(env[NSIS_ZIP_ENV] || '').trim()
  if (requested === '1') {
    nsis.useZip = true
    nsis.differentialPackage = false
  } else if (requested !== '') {
    throw new Error(`${NSIS_ZIP_ENV} accepts only "1" (ZIP candidate) or unset/empty (default)`)
  }
  if (nsis.useZip === true && nsis.differentialPackage !== false) {
    throw new Error('nsis.useZip=true requires nsis.differentialPackage=false: electron-builder would otherwise embed a 7z archive named app-64.zip, producing an uninstallable installer')
  }
  return nsis
}

/**
 * 构建证据（proposal 108 §3/§12「模板漂移」）：manifest 声明版本、实际解析版本与
 * NSIS 解压模板摘要一起进 result.json。升级 electron-builder 后模板摘要变化即提示
 * 重跑路径/日志/故障矩阵，不以注释里的旧版本作证据。
 */
async function builderEvidence(nsisConfiguration) {
  const { verify } = loadDependencies()
  const libraryManifest = require.resolve('app-builder-lib/package.json', { paths: [DESKTOP] })
  const declared = (PACKAGE.devDependencies && PACKAGE.devDependencies['electron-builder']) ||
    (PACKAGE.dependencies && PACKAGE.dependencies['electron-builder']) || ''
  const template = path.join(path.dirname(libraryManifest), 'templates', 'nsis', 'include',
    'extractAppPackage.nsh')
  return {
    declaredVersion: declared,
    resolvedVersion: JSON.parse(fs.readFileSync(libraryManifest, 'utf8')).version,
    extractTemplateSha256: fs.existsSync(template) ? await verify.sha256(template) : null,
    nsis: nsisConfiguration
  }
}

/**
 * Windows 载荷统计：win-unpacked 的文件数与字节数，P1/P2 实验的精确分母
 * （proposal 108 §2「出包清单需重新给出精确分母」）。非 win32 或 backend 阶段返回 null。
 */
function payloadStatistics(context, args) {
  if (args.platform !== 'win32' || args.stage === 'backend') return null
  const root = path.join(context.output, 'win-unpacked')
  if (!fs.existsSync(root)) return null
  let files = 0
  let bytes = 0
  const stack = [root]
  while (stack.length) {
    const directory = stack.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (!entry.isSymbolicLink()) {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  return { root: 'win-unpacked', files, bytes }
}

function loadDependencies() {
  if (dependencies) return dependencies
  dependencies = {
    build: require('electron-builder').build,
    verify: require('./verify.cjs'),
    verifyOfficeAssets: require('./office-assets.cjs').verifyOfficeAssets,
    bundle: require('./bundle.cjs').bundle,
    packWindowsComponents: require('./bundle.cjs').packWindowsComponents,
    targets: require('./target.cjs'),
    prepareBrowser: require('./browser.cjs').prepareBrowser,
    verifyBuiltClosure: require('./closure.cjs').verifyBuiltClosure,
    resolveVendoredCodex: require('../runtime/codex.cjs').resolveVendoredCodex
  }
  return dependencies
}

function command(executable, args, options = {}) {
  return execFileSync(executable, args, { cwd: REPO, encoding: 'utf8', ...options }).trim()
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: DESKTOP,
    stdio: 'inherit',
    shell: process.platform === 'win32' && executable.endsWith('.cmd'),
    ...options
  })
  if (result.error || result.status !== 0) {
    throw new Error(`build step failed: ${path.basename(executable)} (${result.status})`)
  }
}

function resourcePath(root, relative) {
  return path.join(root, ...relative.split('/'))
}

function localDmgbuild(scriptsDirectory, installedVersion) {
  if (installedVersion !== DMGBUILD_VERSION) {
    throw new Error(`dmgbuild ${installedVersion} is not the locked ${DMGBUILD_VERSION}`)
  }
  const executable = path.join(scriptsDirectory, 'dmgbuild')
  if (!fs.statSync(executable).isFile()) throw new Error(`dmgbuild is not a regular file: ${executable}`)
  fs.accessSync(executable, fs.constants.X_OK)
  return executable
}

function installedDmgbuild() {
  const python = developmentPython(REPO, process.env.VENV)
  const actual = verifyDevelopmentPython(REPO, python)
  const installedVersion = command(python, ['-I', '-B', '-c',
    'import importlib.metadata as metadata; print(metadata.version("dmgbuild"))'])
  return localDmgbuild(actual.scripts, installedVersion)
}

function options(argv) {
  const { hostArch, target } = loadDependencies().targets
  const obsolete = Object.keys(process.env).filter(name =>
    name.startsWith(OBSOLETE_ENV_PREFIX) && !OBSOLETE_ENV_ALLOWED.has(name))
  if (obsolete.length) throw new Error(`obsolete environment variables: ${obsolete.join(', ')}`)
  const result = {
    stage: 'installer',
    type: process.env.SCHOLARSEED_DESKTOP_TYPE || 'dev',
    version: process.env.SCHOLARSEED_DESKTOP_VERSION || PACKAGE.version,
    'build-number': process.env.SCHOLARSEED_DESKTOP_BUILD_NUMBER || '',
    platform: process.platform,
    arch: hostArch(),
    candidate: false,
    install: false
  }
  const keys = new Set([
    'stage', 'type', 'version', 'build-number', 'platform', 'arch', 'result',
    'update-base-url', 'team-id', 'windows-publisher', 'install'
  ])
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === CANDIDATE_FLAG) {
      result.candidate = true
      continue
    }
    if (argv[index] === '--install') {
      result.install = true
      continue
    }
    const key = argv[index].replace(/^--/, '')
    if (!argv[index].startsWith('--') || !keys.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`expected a supported --option value: ${argv[index]}`)
    }
    result[key] = argv[index + 1]
    index += 1
  }
  const policy = BUILD_TYPES[result.type]
  const selected = target(result.platform, result.arch)
  if (!STAGES.has(result.stage) || !policy || !SEMVER_VERSION.test(result.version)) {
    throw new Error('invalid build stage or type, or version is not x.y.z')
  }
  if (result['build-number'] && !BUILD_NUMBER.test(result['build-number'])) {
    throw new Error('--build-number must be a 12-digit YYYYMMDDHHMM Beijing stamp')
  }
  if (result.candidate && !PUBLIC_TYPES.has(result.type)) {
    throw new Error('--candidate is only valid with preview or release')
  }
  Object.assign(result, policy, { target: selected })
  if (result.candidate) result.signed = false
  if (result.stage === 'installer') result.stage = selected.installer
  if (result.result && fs.existsSync(path.resolve(result.result))) {
    throw new Error('result output already exists; use a new path')
  }
  if (result.lane === DISTRIBUTION_LANE) {
    const required = ['update-base-url']
    if (result.platform === 'darwin' && result.signed) required.push('team-id')
    if (result.platform === 'win32' && result.signed) required.push('windows-publisher')
    if (required.some(key => !result[key])) {
      throw new Error(`preview/release require ${required.map(key => `--${key}`).join(', ')}`)
    }
    if (result.platform === 'darwin' && result.signed && !APPLE_TEAM_ID.test(result['team-id'])) {
      throw new Error('invalid signing identity')
    }
    const updateUrl = new URL(result['update-base-url'])
    if (updateUrl.protocol !== 'https:' || updateUrl.username || updateUrl.password || updateUrl.search || updateUrl.hash) {
      throw new Error('distribution update base URL must be credential-free HTTPS')
    }
    if (result.platform === 'win32' && result.signed) {
      const requiredEnvironment = [
        'SCHOLARSEED_WINDOWS_SIGN_CLIENT', 'SCHOLARSEED_WINDOWS_SIGN_SERVER',
        'SCHOLARSEED_WINDOWS_SIGN_USER', 'SCHOLARSEED_WINDOWS_SIGN_KEY',
        'SCHOLARSEED_WINDOWS_SIGN_DOMAIN', 'SCHOLARSEED_WINDOWS_SIGN_PUBLISHER'
      ]
      if (requiredEnvironment.some(name => !String(process.env[name] || '').trim()) ||
          process.env.SCHOLARSEED_WINDOWS_SIGN_PUBLISHER !== result['windows-publisher']) {
        throw new Error('Windows signing environment is incomplete or publisher differs')
      }
    }
    if (result.platform === 'darwin' && result.signed) {
      const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
        encoding: 'utf8'
      })
      if (identities.status !== 0 || !identities.stdout.includes('Developer ID Application:')) {
        throw new Error('signed macOS builds require a Developer ID Application identity')
      }
      const notary = process.env.SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE ||
        (process.env.SCHOLARSEED_APPLE_API_KEY && process.env.SCHOLARSEED_APPLE_API_KEY_ID &&
          process.env.SCHOLARSEED_APPLE_API_ISSUER)
      if (!notary) throw new Error('signed macOS builds require Apple notarization credentials')
    }
  }
  return result
}

/**
 * Key the installer artifact by its own extension (`dmg` on macOS, `exe` on
 * Windows) so a consumer that knows the target architecture can address
 * `artifacts.dmg.sha512` directly instead of guessing which platform built it.
 */
function installerArtifacts(installer) {
  if (!installer?.path) return {}
  return { [path.extname(installer.path).slice(1)]: installer }
}

function installResult(installer) {
  const installerPath = installer?.path
  if (!installerPath || !fs.existsSync(installerPath)) {
    throw new Error('installer artifact is missing; cannot install')
  }
  if (process.platform === 'darwin') {
    const mountPoint = path.join(os.tmpdir(), `scholarseed-install-${process.pid}`)
    fs.mkdirSync(mountPoint, { recursive: true })
    try {
      console.log(`[package] mounting ${installerPath}`)
      execFileSync('hdiutil', ['attach', installerPath, '-mountpoint', mountPoint, '-nobrowse'])
      const apps = fs.readdirSync(mountPoint).filter(name => name.endsWith('.app'))
      if (apps.length === 0) throw new Error('no .app found in DMG')
      if (apps.length > 1) throw new Error('multiple .app found in DMG; cannot decide which to install')
      const source = path.join(mountPoint, apps[0])
      const target = path.join('/Applications', apps[0])
      if (fs.existsSync(target)) {
        console.log(`[package] removing existing ${target}`)
        fs.rmSync(target, { recursive: true, force: true })
      }
      console.log(`[package] installing ${apps[0]} to /Applications`)
      execFileSync('cp', ['-R', source, target])
    } finally {
      execFileSync('hdiutil', ['detach', mountPoint, '-force'])
      fs.rmSync(mountPoint, { recursive: true, force: true })
    }
  } else if (process.platform === 'win32') {
    console.log(`[package] running installer: ${installerPath}`)
    execFileSync(installerPath, ['/S'])
  } else {
    throw new Error(`automatic installation is not supported on ${process.platform}`)
  }
  console.log('[package] install completed')
}

function help() {
  console.log(`Usage: node apps/desktop/scripts/build.cjs [options]

  --type dev|preview|release
  --stage backend|dir|installer
  --platform darwin|win32
  --arch arm64|x86_64
  --version X.Y.Z
  --build-number YYYYMMDDHHMM   (default: HEAD commit time, Beijing)
  --candidate
  --install
  --result NEW_PATH

preview/release require --update-base-url.
signed macOS preview/release additionally require --team-id.`)
}

function assertCleanWorktree() {
  if (command('git', ['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('package requires a clean worktree')
  }
}

function provenance() {
  const commit = command('git', ['rev-parse', 'HEAD'])
  const currentBranch = command('git', ['branch', '--show-current'])
  const branch = currentBranch || 'unknown'
  const remote = DEFAULT_REMOTE
  return { branch, commit, remote }
}

/**
 * Resolve this build's `YYYYMMDDHHMM` Beijing stamp.
 *
 * Derived from the commit time rather than the wall clock so rebuilding the same
 * commit yields the same build number: CI stays idempotent, and the release helper
 * can predict the exact `<version>-<build_number>` folder to poll for before the
 * build has finished.
 */
function buildNumberOf(args, commit) {
  const explicit = args['build-number']
  if (explicit) return explicit
  // Windows 的 git（MSYS/MinGW）不解析 IANA 时区名，format-local 配合
  // TZ=Asia/Shanghai 会落到不可靠偏移。改用 epoch 秒在进程内加 8h 偏移，
  // 与测试的独立推导一致且跨平台稳定。
  const epoch = command('git', ['show', '-s', '--format=%ct', commit]).trim()
  if (!/^\d+$/.test(epoch)) {
    throw new Error(`git produced an unusable commit epoch: ${epoch}`)
  }
  const stamp = new Date((Number(epoch) + BUILD_NUMBER_OFFSET_SECONDS) * 1000)
    .toISOString()
    .slice(0, 16)
    .replace(/[-T:]/g, '')
  if (!BUILD_NUMBER.test(stamp)) {
    throw new Error(`git produced an unusable build number: ${stamp}`)
  }
  return stamp
}

function assertSource(source) {
  if (command('git', ['rev-parse', 'HEAD']) !== source.commit) {
    throw new Error('source checkout changed during build')
  }
}

function credentialFreeEnv(environment, prefixes = CREDENTIAL_ENV_PREFIXES) {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if (prefixes.some(prefix => key.startsWith(prefix))) delete result[key]
  }
  return result
}

async function freezeFile(source, destination) {
  const { verify } = loadDependencies()
  const expected = await verify.sha256(source)
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  if (await verify.sha256(destination) !== expected || await verify.sha256(source) !== expected) {
    throw new Error('build input changed while frozen')
  }
  return expected
}

async function runtimeBinaries(selected) {
  const { resolveVendoredCodex, verify } = loadDependencies()
  const codex = await resolveVendoredCodex(DESKTOP, selected.platform,
    selected.arch === 'x86_64' ? 'x64' : selected.arch, console.log)
  const ripgrep = await ensureRipgrep(REPO, selected.platform, selected.arch)
  const rg = ripgrep.executable
  const rows = {
    codex: { path: codex.path, root: codex.root, files: codex.files,
      sha256: await verify.sha256(codex.path), executable_sha256: await verify.sha256(codex.path),
      reported_version: codex.reported_version, source: codex.source },
    rg: { path: rg, sha256: await verify.sha256(rg), executable_sha256: await executableDigest(rg) }
  }
  const version = command(codex.path, ['--version']).match(VERSION_PATTERN)?.[0]
  if (!version || version !== codex.reported_version) throw new Error('Codex runtime version is unavailable')
  return rows
}

function frozenProductConfiguration(args, binaries) {
  const product = JSON.parse(fs.readFileSync(PRODUCT_SOURCE, 'utf8'))
  if (product.product_id !== 'scholarseed' || product.bundle_id !== PACKAGE.build.appId) {
    throw new Error('desktop product policy and package identity differ')
  }
  product.release_lane = args.lane
  product.update_channel = args.channel
  // app.getVersion() only carries the SemVer, so the build stamp has to travel in
  // the frozen policy for the client to rank builds of the same version.
  product.build_number = args.buildNumber
  if (args.lane === DISTRIBUTION_LANE) {
    product.update_base_url = args['update-base-url'].replace(/\/$/, '')
    product.expected_team_id = args['team-id'] || ''
    product.expected_windows_publisher = args['windows-publisher'] || ''
  }
  const profile = product.credential_profiles?.[args.lane]
  if (!profile || profile.key_provider !== CREDENTIAL_PROVIDERS[args.lane]) {
    throw new Error('desktop credential policy is missing or invalid')
  }
  const runtime = product.runtimes?.[product.default_runtime]
  if (!runtime?.enabled || !/^[a-f0-9]{64}$/.test(binaries.codex.executable_sha256) ||
      binaries.codex.source?.package !== '@openai/codex' ||
      binaries.codex.source?.distribution !== 'verified-download') {
    throw new Error('default runtime lacks verified official release evidence')
  }
  runtime.executable_sha256 = binaries.codex.executable_sha256
  runtime.reported_version = binaries.codex.reported_version
  runtime.source = binaries.codex.source
  return product
}

function cachedElectronDistribution(context, args) {
  if (!args.platform || !args.arch) return null
  const version = PACKAGE.devDependencies.electron.replace(/^[^\d]*/, '')
  const platform = args.platform === 'win32' ? 'win32' : args.platform
  const arch = args.arch === 'x86_64' ? 'x64' : args.arch
  const filename = `electron-v${version}-${platform}-${arch}.zip`
  const checksums = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'node_modules', 'electron', 'checksums.json')))
  const expected = checksums[filename]
  if (!expected) throw new Error(`Electron checksum is unavailable for ${platform}/${arch}`)
  for (const directory of ELECTRON_CACHE_DIRECTORIES) {
    if (!fs.existsSync(directory)) continue
    const candidate = findCachedElectron(directory, filename)
    if (!candidate) continue
    const actual = crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')
    if (actual !== expected) continue
    const destination = path.join(context.runDirectory, filename)
    try { fs.linkSync(candidate, destination) } catch { fs.copyFileSync(candidate, destination) }
    return context.runDirectory
  }
  return null
}

function findCachedElectron(directory, filename) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) return candidate
    if (entry.isDirectory()) {
      const nested = findCachedElectron(candidate, filename)
      if (nested) return nested
    }
  }
  return null
}

function writeBuilderConfiguration(context, args) {
  const { verify } = loadDependencies()
  const selected = args.target
  const mac = { ...PACKAGE.build.mac }
  if (selected.platform === 'darwin') {
    if (args.signed) {
      // Distribution signing owns its nested pass so it can skip the thousands of
      // non-Mach-O resources @electron/osx-sign would otherwise timestamp.
      mac.sign = path.join(__dirname, 'signer.cjs')
    } else {
      mac.identity = null
    }
  }
  const extraResources = PACKAGE.build.extraResources.map(entry =>
    ['resources/backend', 'resources/defaults', 'resources/product.json', 'resources/notices'].includes(entry.from)
      ? { ...entry, from: path.join(context.resourceRoot, path.basename(entry.from)) }
      : entry)
  const filename = path.join(context.runDirectory, 'electron-builder.json')
  const nsisConfiguration = resolveNsisConfiguration(PACKAGE.build)
  const config = {
    ...PACKAGE.build,
    nsis: nsisConfiguration,
    electronDist: cachedElectronDistribution(context, args)
      || path.join(DESKTOP, 'node_modules', 'electron', 'dist'),
    mac,
    directories: { ...PACKAGE.build.directories, output: context.output },
    extraMetadata: { version: args.version },
    extraResources,
    artifactName: `${ARTIFACT_BASENAME}-${args.version}-${selected.archType}.\${ext}`,
    afterPack: path.join(__dirname, 'sign.cjs'),
    afterAllArtifactBuild: path.join(__dirname, 'verify.cjs'),
    afterSign: path.join(__dirname, 'notarize.cjs')
  }
  if (selected.platform === 'win32') {
    config.win = args.signed
      ? { ...PACKAGE.build.win, icon: selected.icon,
          signtoolOptions: { sign: path.join(__dirname, 'windows-sign.cjs'),
            signingHashAlgorithms: ['sha256'], publisherName: [args['windows-publisher']] } }
      : { ...PACKAGE.build.win, icon: selected.icon }
  }
  fs.accessSync(path.join(DESKTOP, selected.icon), fs.constants.R_OK)
  verify.atomicJSON(filename, config)
  context.nsis = nsisConfiguration
  return filename
}

function acquireMutex() {
  const mutex = path.join(DESKTOP, '.package-lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(mutex, String(process.pid), { flag: 'wx' })
      return mutex
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = Number.parseInt(fs.readFileSync(mutex, 'utf8').trim(), 10)
      try {
        if (!Number.isInteger(owner) || owner <= 0) throw new Error('invalid lock owner')
        process.kill(owner, 0)
        throw new Error(`another packaging process holds this worktree (pid=${owner})`)
      } catch (ownerError) {
        if (ownerError.message.startsWith('another packaging process')) throw ownerError
        fs.unlinkSync(mutex)
      }
    }
  }
  throw new Error('could not acquire the packaging lock')
}

function buildRunDirectory(releaseRoot, args) {
  return path.join(releaseRoot, `${args.type}-${args.platform}-${args.arch}`)
}

async function main(argv = process.argv.slice(2)) {
  checkToolchain(REPO)
  if (argv.includes('--help') || argv.includes('-h')) {
    help()
    return null
  }
  // The build input must be clean before any step that writes files: dependency
  // installation and packaging both adjust lockfiles and generated artifacts.
  assertCleanWorktree()
  const mutex = acquireMutex()
  try {
    // Locked npm dependencies are installed before any third-party module is loaded,
    // because this entry is also reached on a checkout without node_modules.
    ensureNodeDependencies()
    const { build, bundle, packWindowsComponents, prepareBrowser, targets, verify,
      verifyBuiltClosure, verifyOfficeAssets } = loadDependencies()
    const { hostArch } = targets
    const args = options(argv)
    if (args.platform !== process.platform || args.target.arch !== hostArch()) {
      throw new Error('build on the matching native platform and architecture')
    }
    const source = provenance()
    args.buildNumber = buildNumberOf(args, source.commit)
    const releaseRoot = path.join(DESKTOP, 'release')
    fs.mkdirSync(releaseRoot, { recursive: true })
    const runDirectory = buildRunDirectory(releaseRoot, args)
    fs.rmSync(runDirectory, { recursive: true, force: true })
    fs.mkdirSync(runDirectory)
    const runtime = await verifyPythonArchive(pythonRelease(REPO, args.platform, args.arch))
    const configSource = path.resolve(process.env.SCHOLARSEED_BUNDLE_CONFIG_SOURCE ||
      process.env.SCHOLARSEED_DESKTOP_CONFIG_SOURCE ||
      path.join(REPO, 'apps/serve/service/settings/default.json'))
    const resourceRoot = path.join(runDirectory, 'resources')
    const notices = stageNotices(REPO, resourceRoot)
    const backend = path.join(resourceRoot, 'backend')
    fs.mkdirSync(backend, { recursive: true })
    run(nativeTar(), ['-xzf', runtime.archive, '-C', backend])
    const python = resourcePath(backend, args.target.pythonRelative)
    const binaries = await runtimeBinaries(args.target)
    const context = {
      schema: CONTEXT_SCHEMA, file: path.join(runDirectory, 'context.json'), repo: REPO,
      runDirectory, source, stage: args.stage, version: args.version, type: args.type,
      candidate: args.candidate, lane: args.lane,
      signingRequired: args.signed, platform: args.platform, arch: args.arch,
      archType: args.target.archType, installer: args.target.installer,
      appId: PACKAGE.build.appId, productName: PACKAGE.build.productName,
      icon: path.join(DESKTOP, args.target.icon), runtime, binaries,
      config: { path: configSource, sha256: await verify.sha256(configSource) },
      resourceRoot, notices, output: path.join(runDirectory, 'artifacts'),
      lock: path.join(runDirectory, 'skills.lock.json'),
      dependencies: path.join(runDirectory, 'dependencies.json'),
      skillSource: path.join(REPO, 'skills', 'community'),
      result: path.resolve(args.result || path.join(runDirectory, 'release-result.json')),
      target: verifyPython(python, runtime)
    }
    if (context.target.platform !== args.platform) throw new Error('product Python differs from target platform')
    const productPath = path.join(resourceRoot, 'product.json')
    verify.atomicJSON(productPath, frozenProductConfiguration(args, binaries))
    context.product = { path: productPath, sha256: await verify.sha256(productPath),
      config: JSON.parse(fs.readFileSync(productPath)) }
    verify.atomicJSON(context.file, context)
    const pythonBinDir = command(python, ['-I', '-B', '-c',
      'import sysconfig; print(sysconfig.get_path("scripts"))'])
    const environment = credentialFreeEnv({
      ...process.env,
      PATH: `${pythonBinDir}${path.delimiter}${process.env.PATH}`,
      [CONTEXT_ENV]: context.file,
      SCHOLARSEED_BUNDLE_RESOURCE_ROOT: resourceRoot,
      SCHOLARSEED_BUNDLE_TARGET_ARCH: args.arch,
      SCHOLARSEED_BUNDLE_CONFIG_SOURCE: configSource,
      SCHOLARSEED_PRODUCT_MANIFEST: productPath,
      SCHOLARSEED_BUNDLE_CODEX_EXECUTABLE: binaries.codex.path
    })
    await bundle(context, args.target, environment)
    // win32 组件化（proposal 108 §7.1）：产品代码在 backend/pylibs，凡是要 import 产品模块的
    // 构建步骤都从 -I（isolated 会忽略 PYTHONPATH）换成 -s（关用户 site）+ 显式 PYTHONPATH；
    // 其它平台保持 -I 不变。
    const productLibs = path.join(backend, PYLIBS_DIRNAME)
    const productFlags = args.platform === 'win32' ? ['-s', '-B'] : ['-I', '-B']
    // 技能依赖门禁（prebundle --provision/verify）用 shutil.which 解析产品 console script
    // （如 scholarseed-bridge）。P2a 组件化后这些 launcher 在 backend/bin，不在宿主 PATH
    // （CI 不激活仓库 venv），故把产品自有 launcher 目录前置进门禁 PATH，不依赖宿主环境。
    const productBinDir = path.join(backend, 'bin')
    const productPathEnv = `${productBinDir}${path.delimiter}${environment.PATH}`
    const productEnv = args.platform === 'win32'
      ? { ...environment, PYTHONPATH: productLibs, SCHOLARSEED_PRODUCT_LIBS: productLibs,
          PATH: productPathEnv }
      : { ...environment, PATH: productPathEnv }
    run(python, [...productFlags, '-m', 'service.cli.prebundle', '--build', '--source', context.skillSource,
      '--lock', context.lock], { env: productEnv })
    context.lockSha256 = await verify.sha256(context.lock)
    run(python, [...productFlags, '-m', 'service.cli.prebundle', '--provision', '--source', context.skillSource,
      '--lock', context.lock, '--report', context.dependencies,
      '--toolchain-root', context.texlive.binDirectory], { env: productEnv })
    // Compile oracle: prove the staged toolchain compiles what the bundled skill
    // actually emits. The preambles are read from the skill source, which
    // prebundle verifies byte-for-byte against the staged pack, so a package
    // added to a preamble fails the build here instead of a user's survey.
    const oracleScript = path.join(context.skillSource, 'literature-review', 'scripts',
      'smoke_publication.py')
    const oracleResult = spawnSync(python, [...productFlags, oracleScript], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...productEnv,
        PATH: `${context.texlive.binDirectory}${path.delimiter}${productEnv.PATH}` }
    })
    const oracleOutput = (oracleResult.stdout || '').trim()
    if (oracleResult.error || oracleResult.status !== 0) {
      throw new Error(`bundled TeX Live oracle failed: ${oracleOutput || oracleResult.stderr || oracleResult.error}`)
    }
    const oracle = JSON.parse(oracleOutput)
    const foreignEngine = Object.entries(oracle.engines || {})
      .find(([, resolved]) => !String(resolved).startsWith(context.texlive.binDirectory))
    if (!oracle.ok || foreignEngine) {
      throw new Error(`bundled TeX Live oracle failed: ${oracleOutput.slice(0, 2000)}`)
    }
    context.texlive.oracle = oracle
    run(python, [...productFlags, path.join(backend, VERIFIER_FILENAME), 'verify',
      '--manifest', path.join(backend, INVENTORY_FILENAME),
      '--requirements', path.join(backend, REQUIREMENTS_FILENAME)], { env: productEnv })
    fs.copyFileSync(context.lock, path.join(backend, 'skills.lock.json'))
    fs.copyFileSync(context.dependencies, path.join(backend, 'dependencies.json'))
    if (args.platform === 'win32') {
      // 所有需要松散 python/texlive 树的验证都已跑完；现在冻结证据、打组件 zip、删松散树。
      context.components = packWindowsComponents(context, args, environment)
    }
    if (args.platform === 'darwin') context.browser = await prepareBrowser(resourceRoot, args.arch)
    verify.atomicJSON(context.file, context)
    if (args.stage !== 'backend') {
      await verifyOfficeAssets(DESKTOP)
      const vite = path.join(DESKTOP, 'node_modules', '.bin',
        process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite')
      run(vite, ['build'], { env: environment })
      context.closure = verifyBuiltClosure(DESKTOP)
      process.env[CONTEXT_ENV] = context.file
      context.builderConfig = writeBuilderConfiguration(context, args)
      verify.atomicJSON(context.file, context)
      if (args.stage === 'dmg') process.env.CUSTOM_DMGBUILD_PATH = installedDmgbuild()
      await build({ projectDir: DESKTOP, publish: 'never',
        targets: args.target.builderPlatform.createTarget([args.stage], args.target.builderArch),
        config: context.builderConfig })
    }
    assertSource(source)
    const app = args.stage === 'backend' ? null : JSON.parse(fs.readFileSync(path.join(runDirectory, 'app.json')))
    const installer = ['backend', 'dir'].includes(args.stage)
      ? null : JSON.parse(fs.readFileSync(path.join(runDirectory, 'installer.json')))
    const trustLevel = args.stage === 'backend' ? 'not-applicable'
      : args.candidate ? `${args.type}-candidate-unsigned`
        : args.type === 'dev' ? (args.platform === 'darwin' ? 'ad-hoc-local-only' : 'unsigned-dev')
          : args.platform === 'darwin' ? 'developer-id-notarized' : 'signed-windows'
    const builder = await builderEvidence(context.nsis || resolveNsisConfiguration(PACKAGE.build))
    const result = {
      schema: CONTEXT_SCHEMA, status: 'passed', stage: args.stage,
      product: { product_id: context.product.config.product_id,
        product_name: context.product.config.product_name, bundle_id: context.product.config.bundle_id,
        policy_sha256: context.product.sha256,
        credential_profile: context.product.config.credential_profiles[args.lane] },
      source,
      release: { version: args.version, build_number: args.buildNumber,
        type: args.type, channel: args.channel,
        candidate: args.candidate, lane: args.lane,
        platform: args.platform, arch: args.arch, arch_type: args.target.archType },
      artifacts: { app, ...installerArtifacts(installer) },
      publishable: !args.candidate && args.type !== 'dev',
      trust: { level: trustLevel, ...(app?.trust || {}) }, target: context.target, skills: {
        source: context.skillSource, lock: context.lock, lock_sha256: context.lockSha256
      }, runtime, python_dependencies: context.pythonDependencies,
      builder, payload: payloadStatistics(context, args),
      ...(context.components
        ? { components: {
            target: context.components.target,
            app_components_sha256: context.components.appComponentsSha256,
            content_ids: Object.fromEntries(
              context.components.components.map(item => [item.kind, item.contentId]))
          } }
        : {})
    }
    verify.atomicJSON(context.result, result)
    console.log(`[package] verified installer: ${installer?.path || 'not requested'}`)
    console.log(`[package] exact build evidence: ${context.result}`)
    if (args.install) installResult(installer)
    return result
  } finally {
    if (fs.existsSync(mutex) && fs.readFileSync(mutex, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(mutex)
    }
  }
}

module.exports = { BUILD_TYPES, buildNumberOf, buildRunDirectory, credentialFreeEnv, freezeFile,
  frozenProductConfiguration, acquireMutex, installerArtifacts, options, provenance,
  writeBuilderConfiguration, localDmgbuild, resolveNsisConfiguration, payloadStatistics }

if (require.main === module) {
  main().catch(error => { console.error(`[package] ERROR ${error.message}`); process.exitCode = 1 })
}
