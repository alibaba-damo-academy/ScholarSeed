// Verifies the exact unpacked application and installer emitted by electron-builder.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')

const { target } = require('./target.cjs')
const { executableDigest } = require('./digest.cjs')
const { verify: verifyWindowsSignature } = require('./windows-sign.cjs')
const { verifyBrowser } = require('./browser.cjs')
const { verifyAsarClosure } = require('./closure.cjs')
const { verifyNotices } = require('./notices.cjs')
const { REQUIREMENTS_FILENAME, INVENTORY_FILENAME, VERIFIER_FILENAME } = require('./bundle.cjs')
const {
  APP_COMPONENTS_FILENAME,
  COMPONENTS_DIRNAME,
  PYTHON_TREE_DIRNAME,
  TEXLIVE_TREE_DIRNAME,
  parseAppComponents
} = require('../runtime/components.cjs')
const { verifyPython } = require('../../../scripts/python.cjs')
const { skillPythonLauncherPath } = require('../runtime/python.cjs')
const { probe: probeTexlive, stagedEngines } = require('../runtime/texlive.cjs')

const CONTEXT_ENV = 'SCHOLARSEED_BUILD_CONTEXT'
const EXPECTED_SCHEME = 'scholarseed'
const EXPECTED_PRODUCT_NAME = 'ScholarSeed'
const EXPECTED_SEARCH_ALIAS = '书深'
const LOCALIZED_PRODUCT_NAME = '书深'
const LOCALIZED_PRODUCT_NAMES = {
  en: EXPECTED_PRODUCT_NAME,
  zh_CN: LOCALIZED_PRODUCT_NAME
}
// win32 组件化后 package-check 首启要在隔离 home 里 provision 组件（~2.5GiB 解压 + 探测），
// 600s 不够；上限放宽到 30min，仍远小于「卡死无上限」。
const CHECK_TIMEOUT_MS = 1_800_000
const DARWIN_SHORT_TEMP_ROOT = '/tmp'
const DARWIN_UNIX_SOCKET_PATH_BYTES = 104
const PACKAGE_CHECK_LOG_PREFIX = 'package-check'
const NSIS_SILENT_INSTALL = '/S'
const NSIS_DIRECTORY_PREFIX = '/D='
const SYSTEM_PATHS = process.platform === 'win32'
  ? String(process.env.PATH || '').split(path.delimiter)
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const { RUNTIME_PROBE_SCRIPT } = require('./probe.cjs')

function artifactTemporaryRoot(platform = process.platform) {
  return platform === 'darwin' ? DARWIN_SHORT_TEMP_ROOT : os.tmpdir()
}

function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, filename)
}

async function digest(filename, algorithm) {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

const sha256 = filename => digest(filename, 'sha256')
const sha512 = filename => digest(filename, 'sha512')

function command(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: 'utf8', ...options }).trim()
}

function packageCheckLog(frozen, label, executable, child) {
  const filename = path.join(frozen.runDirectory, `${PACKAGE_CHECK_LOG_PREFIX}-${label}.log`)
  fs.writeFileSync(filename, [
    `executable: ${executable}`,
    `status: ${child.status}`,
    `signal: ${child.signal || ''}`,
    `error: ${child.error ? String(child.error) : ''}`,
    '',
    'stdout:',
    child.stdout || '',
    '',
    'stderr:',
    child.stderr || ''
  ].join('\n'))
  return filename
}

function productPath(pythonBin, runtimeBin) {
  return [pythonBin, runtimeBin, ...SYSTEM_PATHS].filter(Boolean).join(path.delimiter)
}

function resourcePath(root, relative) {
  return path.join(root, ...relative.split('/'))
}

function context() {
  const filename = process.env[CONTEXT_ENV]
  if (!filename) throw new Error('use scripts/build.cjs: a frozen build context is required')
  const result = JSON.parse(fs.readFileSync(filename))
  if (result.schema !== 3 || result.file !== filename || !/^[a-f0-9]{64}$/.test(result.lockSha256 || '')) {
    throw new Error('invalid or unfinished build context')
  }
  return result
}

function layout(application, frozen) {
  const selected = target(frozen.platform, frozen.arch)
  const resources = frozen.platform === 'darwin'
    ? path.join(application, 'Contents', 'Resources')
    : path.join(application, 'resources')
  return {
    selected,
    resources,
    python: resourcePath(path.join(resources, 'backend'), selected.pythonRelative),
    skillPython: skillPythonLauncherPath(path.join(resources, 'backend', 'bin'), frozen.platform),
    codex: resourcePath(path.join(resources, 'backend'), selected.codexRelative),
    rg: path.join(resources, 'backend', 'bin', selected.ripgrepName),
    executable: frozen.platform === 'darwin'
      ? path.join(application, 'Contents', 'MacOS', frozen.productName)
      : path.join(application, `${frozen.productName}.exe`)
  }
}

function verifyIdentity(application, frozen) {
  if (frozen.platform === 'darwin') {
    const plist = path.join(application, 'Contents', 'Info.plist')
    for (const [field, expected] of Object.entries({ CFBundleIdentifier: frozen.appId,
      CFBundleShortVersionString: frozen.version,
      CFBundleDevelopmentRegion: 'en',
      CFBundleDisplayName: EXPECTED_PRODUCT_NAME,
      CFBundleSpokenName: EXPECTED_SEARCH_ALIAS,
      LSHasLocalizedDisplayName: 'true',
      'MDItemKeywords.0': EXPECTED_SEARCH_ALIAS,
      'CFBundleURLTypes.0.CFBundleURLSchemes.0': EXPECTED_SCHEME })) {
      if (command('plutil', ['-extract', field, 'raw', plist]) !== expected) {
        throw new Error(`app identity differs: ${field}`)
      }
    }
    for (const [locale, expected] of Object.entries(LOCALIZED_PRODUCT_NAMES)) {
      const localizedPlist = path.join(application, 'Contents', 'Resources', `${locale}.lproj`, 'InfoPlist.strings')
      if (command('plutil', ['-extract', 'CFBundleDisplayName', 'raw', localizedPlist]) !== expected ||
          command('plutil', ['-extract', 'CFBundleName', 'raw', localizedPlist]) !== expected) {
        throw new Error(`localized app identity differs: ${locale}`)
      }
    }
  }
}

function verifySignedRuntime(filename, teamId) {
  const result = spawnSync('codesign', ['-d', '--verbose=4', filename], { encoding: 'utf8' })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.status !== 0 || spawnSync('codesign', ['--verify', '--strict', filename]).status !== 0 ||
      !output.includes('flags=0x10000(runtime)') || !/^Timestamp=.+$/m.test(output) ||
      !/^Authority=Developer ID Application:.+$/m.test(output) ||
      output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() !== teamId) {
    throw new Error('packaged runtime Developer ID signature is incomplete')
  }
}

async function verifyContent(application, frozen, signed = false) {
  const current = layout(application, frozen)
  verifyNotices(current.resources, frozen.notices)
  const closure = verifyAsarClosure(current.resources)
  const { asar_bytes, ...compiledClosure } = closure
  if (JSON.stringify(compiledClosure) !== JSON.stringify(frozen.closure)) {
    throw new Error('artifact JavaScript differs from frozen compiled entries')
  }
  if (frozen.components) {
    return await verifyComponentContent(application, frozen, current, closure)
  }
  const browser = frozen.platform === 'darwin'
    ? await verifyBrowser(current.resources, frozen.arch, frozen.browser, true)
    : null
  const required = [current.executable, current.python, current.codex, current.rg,
    path.join(current.resources, 'renderer', 'index.html'),
    path.join(current.resources, 'defaults', 'config.json'),
    path.join(current.resources, 'product.json'),
    path.join(current.resources, 'backend', 'skills.lock.json'),
    current.skillPython]
  for (const filename of required) fs.accessSync(filename, fs.constants.R_OK)
  if (await sha256(required[5]) !== frozen.config.sha256 ||
      await sha256(required[6]) !== frozen.product.sha256 ||
      await sha256(required[7]) !== frozen.lockSha256 ||
      await sha256(current.codex) !== frozen.binaries.codex.sha256 ||
      (signed && frozen.platform === 'darwin'
        ? await executableDigest(current.rg) !== frozen.binaries.rg.executable_sha256
        : await sha256(current.rg) !== frozen.binaries.rg.sha256)) {
    throw new Error('packaged resources differ from frozen build inputs')
  }
  if (signed && frozen.platform === 'darwin' && frozen.signingRequired) {
    verifySignedRuntime(current.rg, frozen.product.config.expected_team_id)
  }
  // The bundled skill's PDF path is only real if the staged engines survived
  // packaging: check they are executable in the artifact and still report the
  // versions the build staged.
  if (!frozen.texlive) throw new Error('frozen build context carries no TeX Live evidence')
  const engines = stagedEngines(current.resources, frozen.platform, frozen.texlive.executables)
  for (const engine of engines) fs.accessSync(engine, fs.constants.X_OK)
  const reportedEngines = await probeTexlive(path.dirname(engines[0]), frozen.texlive.executables,
    frozen.texlive.texlive, frozen.platform)
  if (JSON.stringify(reportedEngines) !== JSON.stringify(frozen.texlive.reported)) {
    throw new Error('packaged TeX Live engines differ from the staged toolchain')
  }
  const imports = JSON.parse(command(current.python, ['-I', '-B', '-c', RUNTIME_PROBE_SCRIPT], {
    env: { ...process.env, SCHOLARSEED_PRODUCT_MANIFEST: required[6] }
  }))
  imports.runtime = verifyPython(current.python, frozen.runtime)
  const backend = path.join(current.resources, 'backend')
  for (const [filename, checksum] of [
    [REQUIREMENTS_FILENAME, frozen.pythonDependencies.requirements_sha256],
    [INVENTORY_FILENAME, frozen.pythonDependencies.inventory_sha256],
    [VERIFIER_FILENAME, frozen.pythonDependencies.verifier_sha256]
  ]) {
    if (await sha256(path.join(backend, filename)) !== checksum) {
      throw new Error(`packaged Python dependency evidence changed: ${filename}`)
    }
  }
  command(current.python, ['-I', '-B', path.join(backend, VERIFIER_FILENAME), 'verify',
    '--manifest', path.join(backend, INVENTORY_FILENAME),
    '--requirements', path.join(backend, REQUIREMENTS_FILENAME)])
  return { current, imports, browser, closure }
}

/**
 * win32 组件化包内验证（proposal 108 §7.3）：python/texlive 以组件 zip 交付，包内没有
 * 松散树也没有可执行解释器，运行探针在构建期（打包前）执行并冻结进 context.components.buildTime。
 * 这里的验证退化为摘要链：manifest 冻结哈希 → 每个 zip 的 sha256/字节数 → 通用资源哈希 →
 * 松散树必须不存在（不保留重复组件树）。安装后的真实运行验证由 package-check 首启
 * provision（真解压 + 真探测 + 真 serve 健康检查）承担。
 */
async function verifyComponentContent(application, frozen, current, closure) {
  const backend = path.join(current.resources, 'backend')
  const componentsDirectory = path.join(backend, COMPONENTS_DIRNAME)
  const manifestPath = path.join(componentsDirectory, APP_COMPONENTS_FILENAME)
  if (await sha256(manifestPath) !== frozen.components.appComponentsSha256) {
    throw new Error('packaged app-components manifest differs from frozen build evidence')
  }
  const manifest = parseAppComponents(fs.readFileSync(manifestPath, 'utf8'))
  if (!manifest ||
      JSON.stringify(manifest.components) !== JSON.stringify(frozen.components.components)) {
    throw new Error('packaged component manifest differs from frozen build evidence')
  }
  for (const component of manifest.components) {
    const archive = path.join(componentsDirectory, component.archive)
    fs.accessSync(archive, fs.constants.R_OK)
    if (await sha256(archive) !== component.archiveSha256 ||
        fs.statSync(archive).size !== component.archiveBytes) {
      throw new Error(`packaged component archive differs from manifest: ${component.archive}`)
    }
  }
  for (const tree of [PYTHON_TREE_DIRNAME, TEXLIVE_TREE_DIRNAME]) {
    if (fs.existsSync(path.join(backend, tree))) {
      throw new Error(`componentized payload must not keep a loose ${tree} tree`)
    }
  }
  const required = [current.executable, current.codex, current.rg,
    path.join(current.resources, 'renderer', 'index.html'),
    path.join(current.resources, 'defaults', 'config.json'),
    path.join(current.resources, 'product.json'),
    path.join(current.resources, 'backend', 'skills.lock.json'),
    current.skillPython]
  for (const filename of required) fs.accessSync(filename, fs.constants.R_OK)
  if (await sha256(required[4]) !== frozen.config.sha256 ||
      await sha256(required[5]) !== frozen.product.sha256 ||
      await sha256(required[6]) !== frozen.lockSha256 ||
      await sha256(current.codex) !== frozen.binaries.codex.sha256 ||
      await sha256(current.rg) !== frozen.binaries.rg.sha256) {
    throw new Error('packaged resources differ from frozen build inputs')
  }
  for (const [filename, checksum] of [
    [REQUIREMENTS_FILENAME, frozen.pythonDependencies.requirements_sha256],
    [INVENTORY_FILENAME, frozen.pythonDependencies.inventory_sha256],
    [VERIFIER_FILENAME, frozen.pythonDependencies.verifier_sha256]
  ]) {
    if (await sha256(path.join(backend, filename)) !== checksum) {
      throw new Error(`packaged Python dependency evidence changed: ${filename}`)
    }
  }
  const imports = { ...frozen.components.buildTime.imports }
  imports.runtime = frozen.components.buildTime.python
  return { current, imports, browser: null, closure }
}

function macTrust(application, frozen) {
  const result = spawnSync('codesign', ['-d', '--verbose=4', application], { encoding: 'utf8' })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (spawnSync('codesign', ['--verify', '--deep', '--strict', application]).status !== 0) {
    throw new Error('artifact failed structural codesign verification')
  }
  if (!frozen.signingRequired) return { signature: 'ad-hoc' }
  command('spctl', ['--assess', '--type', 'execute', application])
  command('xcrun', ['stapler', 'validate', application])
  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || ''
  const developerId = output.match(/^Authority=(Developer ID Application:.+)$/m)?.[1]?.trim() || ''
  const receipt = JSON.parse(fs.readFileSync(path.join(frozen.runDirectory, 'notary.json')))
  if (!developerId || teamId !== frozen.product.config.expected_team_id || receipt.status !== 'Accepted') {
    throw new Error('Developer ID or notarization evidence is incomplete')
  }
  return { developer_id: developerId, team_id: teamId, notarization: receipt,
    stapled: true, gatekeeper: 'accepted' }
}

function unsignedPackageCheck(frozen) {
  return frozen.platform === 'darwin' && frozen.stage === 'dir' && frozen.candidate && !frozen.signingRequired
}

const TEMP_CLEANUP_RETRY_DELAY_MS = 250
const TEMP_CLEANUP_TIMEOUT_MS = 60_000
const TEMP_CLEANUP_BACKGROUND_RETRY_MS = 5_000
const TEMP_CLEANUP_BACKGROUND_ATTEMPTS = 12

function removeTemporary(directory, timeoutMs = TEMP_CLEANUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TEMP_CLEANUP_RETRY_DELAY_MS)
    }
  }
}

function retryRemoveTemporary(directory, attempts) {
  if (attempts <= 0) return
  setTimeout(() => {
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch {
      retryRemoveTemporary(directory, attempts - 1)
    }
  }, TEMP_CLEANUP_BACKGROUND_RETRY_MS).unref()
}

function bestEffortRemoveTemporary(directory, timeoutMs = TEMP_CLEANUP_TIMEOUT_MS) {
  try {
    removeTemporary(directory, timeoutMs)
  } catch (error) {
    console.warn(`[package] warning: could not remove temporary directory ${directory}: ${error.message}`)
    retryRemoveTemporary(directory, TEMP_CLEANUP_BACKGROUND_ATTEMPTS)
  }
}

function runPackageCheck(application, frozen, label = 'unpacked') {
  if (frozen.skipCheck === true) {
    console.log(`[package] ${label} 启动验收: skipped (--skip-check)`)
    return { status: 'skipped', reason: '--skip-check' }
  }
  const current = layout(application, frozen)
  const temporaryDirectory = artifactTemporaryRoot(frozen.platform)
  const directory = fs.mkdtempSync(path.join(temporaryDirectory, 'scholarseed-package-check-'))
  const result = path.join(directory, 'result.json')
  const home = path.join(directory, 'home')
  const workspace = path.join(directory, 'workspace')
  fs.mkdirSync(home)
  fs.mkdirSync(workspace)
  // Windows Electron 通过 USERPROFILE\AppData\Roaming 解析 appData，
  // 隔离 home 必须补齐该结构，否则主进程在 whenReady 前即抛异常。
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')
  if (frozen.platform === 'win32') {
    fs.mkdirSync(appData, { recursive: true })
    fs.mkdirSync(localAppData, { recursive: true })
  }
  const child = spawnSync(current.executable, [
    '--enable-logging=file', '--log-file', path.join(directory, 'electron.log'),
    '--package-check', result
  ], {
    cwd: directory,
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: directory, TEMP: directory,
      TMP: directory, SCHOLARSEED_HOME: home, SCHOLARSEED_PROJECT_DIRNAME: '.scholarseed',
      APPDATA: appData, LOCALAPPDATA: localAppData, SCHOLARSEED_DEFAULT_WORKSPACE: workspace },
    timeout: CHECK_TIMEOUT_MS,
    encoding: 'utf8'
  })
  const log = packageCheckLog(frozen, label, current.executable, child)
  try {
    if (child.error || child.status !== 0 || !fs.existsSync(result)) {
      if (child.stdout) process.stdout.write(child.stdout)
      if (child.stderr) process.stderr.write(child.stderr)
      const failure = child.error ? String(child.error) : `exit status ${child.status}`
      throw new Error(`packaged Electron check failed: ${failure}; log: ${log}`)
    }
    const payload = JSON.parse(fs.readFileSync(result))
    if (payload.schema !== 1 || payload.ok !== true || !payload.backend || !payload.renderer ||
        payload.platform !== frozen.platform) {
      throw new Error('packaged Electron check returned an invalid result')
    }
    return payload
  } finally {
    bestEffortRemoveTemporary(directory)
  }
}

async function verifyInstalledWindows(installer, frozen) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarseed-nsis-'))
  try {
    const installed = path.join(directory, 'app')
    const result = spawnSync(installer, [NSIS_SILENT_INSTALL, `${NSIS_DIRECTORY_PREFIX}${installed}`], {
      timeout: CHECK_TIMEOUT_MS, encoding: 'utf8'
    })
    if (result.error || result.status !== 0) {
      throw new Error(`NSIS installation failed: ${result.error || result.stderr || result.status}`)
    }
    const application = fs.readdirSync(installed, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(installed, entry.name))
      .find(candidate => fs.existsSync(path.join(candidate, `${frozen.productName}.exe`))) || installed
    await verifyApplication(application, frozen, false)
    return runPackageCheck(application, frozen, 'installed')
  } finally {
    bestEffortRemoveTemporary(directory)
  }
}

async function verifyApplication(application, frozen, runtimeCheck) {
  verifyIdentity(application, frozen)
  const signed = !unsignedPackageCheck(frozen)
  const { current, imports, browser, closure } = await verifyContent(application, frozen, signed)
  const trust = frozen.platform === 'darwin' && signed
    ? macTrust(application, frozen)
    : frozen.signingRequired
      ? verifyWindowsSignature(current.executable, frozen.product.config.expected_windows_publisher)
      : null
  return { path: application, content: 'passed', imports, browser, closure,
    package_check: runtimeCheck ? runPackageCheck(application, frozen) : null,
    signature_valid: signed && (frozen.platform === 'darwin' || frozen.signingRequired), trust }
}

async function verify(builderContext) {
  const frozen = context()
  if (builderContext.appOutDir) {
    const application = frozen.platform === 'darwin'
      ? path.join(builderContext.appOutDir, `${frozen.productName}.app`)
      : builderContext.appOutDir
    verifyIdentity(application, frozen)
    const { imports } = await verifyContent(application, frozen)
    const result = { path: application, content: 'passed', imports,
      package_check: null, signature_valid: false, trust: null }
    atomicJSON(path.join(frozen.runDirectory, 'app.json'), result)
    return
  }
  if (!Array.isArray(builderContext.artifactPaths)) throw new Error('unknown builder verification event')
  if (frozen.stage === 'dir') {
    const application = JSON.parse(fs.readFileSync(path.join(frozen.runDirectory, 'app.json')))
    const checked = await verifyApplication(application.path, frozen, true)
    atomicJSON(path.join(frozen.runDirectory, 'app.json'), checked)
    return []
  }
  const extension = frozen.installer === 'dmg' ? '.dmg' : '.exe'
  const installers = builderContext.artifactPaths.filter(filename => filename.endsWith(extension))
  if (installers.length !== 1) throw new Error('build did not produce exactly one installer')
  const installer = installers[0]
  if (frozen.installer === 'dmg') command('hdiutil', ['verify', installer])
  if (frozen.platform === 'win32' && frozen.signingRequired) {
    verifyWindowsSignature(installer, frozen.product.config.expected_windows_publisher)
  }
  const application = JSON.parse(fs.readFileSync(path.join(frozen.runDirectory, 'app.json')))
  const checked = await verifyApplication(application.path, frozen, true)
  // sha512 is unconditional: the update service imports a build from this digest and
  // the client verifies its download against it, so a build without one can never be
  // distributed. The bytes were already streamed once for sha256.
  const evidence = { path: installer, sha256: await sha256(installer), sha512: await sha512(installer),
    size: fs.statSync(installer).size,
    package_check: checked.package_check,
    installed_check: frozen.platform === 'win32' ? await verifyInstalledWindows(installer, frozen) : null,
    signature_valid: checked.signature_valid, trust: checked.trust }
  atomicJSON(path.join(frozen.runDirectory, 'app.json'), checked)
  atomicJSON(path.join(frozen.runDirectory, 'installer.json'), evidence)
  return []
}

module.exports = verify
module.exports.atomicJSON = atomicJSON
module.exports.packageCheckLog = packageCheckLog
module.exports.productPath = productPath
module.exports.RUNTIME_PROBE_SCRIPT = RUNTIME_PROBE_SCRIPT
module.exports.sha256 = sha256
module.exports.sha512 = sha512
module.exports.verifyApplication = verifyApplication
module.exports.unsignedPackageCheck = unsignedPackageCheck
module.exports.runPackageCheck = runPackageCheck
module.exports.verifyInstalledWindows = verifyInstalledWindows
module.exports.artifactTemporaryRoot = artifactTemporaryRoot
module.exports.bestEffortRemoveTemporary = bestEffortRemoveTemporary
module.exports.removeTemporary = removeTemporary
module.exports.DARWIN_UNIX_SOCKET_PATH_BYTES = DARWIN_UNIX_SOCKET_PATH_BYTES
