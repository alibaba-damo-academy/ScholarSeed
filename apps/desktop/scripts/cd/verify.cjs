const { startStage, timed, timedAsync } = require('../../../../scripts/shared/timing.cjs')
// Verifies the exact unpacked application and installer emitted by electron-builder.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')

const { removeTemporary, TIMEOUT_MS: TEMP_CLEANUP_TIMEOUT_MS } = require('../shared/temporary-cleanup.cjs')
const { target } = require('../shared/target.cjs')
const { artifactTemporaryRoot, createPackageCheckDirectory, protectWindowsVerificationDirectory } = require('./verification-directory.cjs')
const { executableDigest } = require('../shared/digest.cjs')
const { verify: verifyWindowsSignature } = require('./windows-sign.cjs')
const acceptance = require('./acceptance.cjs')
const { verifyImage } = require('./dmg.cjs')
const { assertCleanInstallation } = require('./registration.cjs')
const { runInstaller, engineEvidence, recordInstallerFailure } = require('./installation.cjs')
const { inspectBrowser, verifyBrowser } = require('./browser.cjs')
const { verifyExecution } = require('./execution.cjs')
const { verifyAsarClosure } = require('./closure.cjs')
const { verifyNotices } = require('./notices.cjs')
const { readNative } = require('./seal.cjs')
const shipit = require('../../native/shipit/artifact.cjs')
const { REQUIREMENTS_FILENAME, INVENTORY_FILENAME, VERIFIER_FILENAME } = require('./bundle.cjs')
const { inspectBytecode } = require('./assembly.cjs')
const {
  COMPONENTS_DIRNAME,
  RUNTIME_MANIFEST_FILENAME,
  readRuntimeManifest,
  bundledWindowsRuntime,
  WINDOWS_BUNDLED_RUNTIME_DIRS,
} = require('../../runtime/components.cjs')
const { verifyPython } = require('../../../../scripts/shared/python.cjs')
const { skillPythonLauncherPath } = require('../../runtime/python.cjs')
const { probe: probeTexlive, stagedEngines } = require('../../runtime/texlive.cjs')
const { probe: probePowerShell } = require('../../runtime/powershell.cjs')
const buildState = require('../shared/build-state.cjs')
const { readHandoff, readLauncher } = require('./handoff.cjs')
const COMPONENT_RECEIPT = '.scholarseed-component.json'
// Velopack 1.2.161 allows a 60s hook, then removes shortcuts/files and
// schedules root self-deletion after 3s. The launcher exit is only handoff.
const UNINSTALL_RETIREMENT_TIMEOUT_MS = 120_000
const UNINSTALL_RETIREMENT_POLL_MS = 200
// 引擎的延迟删除只清空内容，目录句柄在外层进程退出后才释放；此时由验收进程回收。
const UNINSTALL_RETIREMENT_RECLAIM_MS = 5_000
const UNINSTALL_RETIREMENT_RECLAIM_INTERVAL_MS = 10_000
const UNINSTALL_REMAINDER_LIMIT = 32

const CONTEXT_ENV = 'SCHOLARSEED_BUILD_CONTEXT'
const WINDOWS_PLATFORM = 'win32'
const PYTHON_DONT_WRITE_BYTECODE_ENV = 'PYTHONDONTWRITEBYTECODE'
const EXPECTED_SCHEME = 'scholarseed'
const EXPECTED_PRODUCT_NAME = 'ScholarSeed'
const EXPECTED_SEARCH_ALIAS = '书深'
const LOCALIZED_PRODUCT_NAME = '书深'
const LOCALIZED_PRODUCT_NAMES = {
  en: EXPECTED_PRODUCT_NAME,
  zh_CN: LOCALIZED_PRODUCT_NAME,
}
// Windows startup also validates the complete bundled runtime; allow cold CI machines.
// 600s 不够；上限放宽到 30min，仍远小于「卡死无上限」。
const CHECK_TIMEOUT_MS = 1_800_000
// Whole-bundle policy assessment is separate from the 30s executable probes.
const MAC_TRUST_TIMEOUT_MS = 300_000
const TRUST_DIAGNOSTIC_BYTES = 4096
const DARWIN_UNIX_SOCKET_PATH_BYTES = 104
const PACKAGE_CHECK_LOG_PREFIX = 'package-check'
const COMPONENT_TIMING_PREFIX = '[component-timing] '
const COMPONENT_TIMING_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/
const COMPONENT_TIMING_STATUSES = new Set(['passed', 'failed', 'reused', 'retained'])
const COMPONENT_TIMING_BYTES = 16 * 1024
const NATIVE_STAGE_PREFIX = '[native-stage] '
const NATIVE_STAGE_NAME = /^native\.[a-z0-9.-]+$/
const NATIVE_STAGE_EVENTS = new Set(['start', 'end'])
const NATIVE_STAGE_STATUSES = new Set(['passed', 'failed'])
const SYSTEM_PATHS =
  process.platform === 'win32'
    ? String(process.env.PATH || '').split(path.delimiter)
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const { RUNTIME_PROBE_SCRIPT } = require('../shared/probe.cjs')

// Use the same directory factory and native policy before expensive bundling,
// compilation, signing and notarization. Final artifact startup is still required.
function preflightDirectories(frozen, python) {
  const started = Date.now()
  const directory = createPackageCheckDirectory(frozen)
  try {
    const home = path.join(directory, 'home')
    const workspace = path.join(directory, 'workspace')
    fs.mkdirSync(home, { mode: 0o700 })
    fs.mkdirSync(workspace, { mode: 0o700 })
    const result = command(path.toNamespacedPath(python), [
      '-I',
      '-B',
      path.join(__dirname, 'verification-directories.py'),
      fs.realpathSync(frozen.runDirectory),
      home,
      workspace,
    ])
    console.log(`[package] directory preflight passed (${Date.now() - started}ms): ${result}`)
    return JSON.parse(result)
  } finally {
    bestEffortRemoveTemporary(directory)
  }
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

const sha256 = (filename) => digest(filename, 'sha256')
const sha512 = (filename) => digest(filename, 'sha512')

function command(executable, args, options = {}) {
  return execFileSync(executable, args, { encoding: 'utf8', ...options }).trim()
}

// Forward only structured timing fields; raw child diagnostics remain in the file.
function nativeStageRecords(child, label) {
  const records = []
  for (const line of `${child.stdout || ''}\n${child.stderr || ''}`.split(/\r?\n/)) {
    if (!line.startsWith(NATIVE_STAGE_PREFIX)) continue
    let value
    try { value = JSON.parse(line.slice(NATIVE_STAGE_PREFIX.length)) } catch { continue }
    if (!value || !NATIVE_STAGE_NAME.test(value.stage) || !NATIVE_STAGE_EVENTS.has(value.event)) continue
    const record = { check: label, stage: value.stage, event: value.event }
    if (value.event === 'end') {
      if (!NATIVE_STAGE_STATUSES.has(value.status) || !Number.isFinite(value.seconds) || value.seconds < 0) continue
      record.status = value.status
      record.seconds = value.seconds
      if (Number.isSafeInteger(value.operations) && value.operations >= 0) record.operations = value.operations
    }
    records.push(record)
  }
  return records
}

// Only structured, bounded diagnostics reach the CI console. Raw output stays local.
function componentTimingRecords(child, label) {
  const records = []
  for (let line of `${child.stdout || ''}\n${child.stderr || ''}`.split(/\r?\n/)) {
    if (line.startsWith('[runtime] ')) line = line.slice('[runtime] '.length)
    if (!line.startsWith(COMPONENT_TIMING_PREFIX) || Buffer.byteLength(line) > COMPONENT_TIMING_BYTES) continue
    let value
    try { value = JSON.parse(line.slice(COMPONENT_TIMING_PREFIX.length)) } catch { continue }
    if (!value || !['kind', 'operation'].every(key => typeof value[key] === 'string' && COMPONENT_TIMING_TOKEN.test(value[key])) ||
      typeof value.version !== 'string' || (value.version !== '' && !COMPONENT_TIMING_TOKEN.test(value.version)) ||
      typeof value.last_phase !== 'string' || (value.last_phase !== '' && !COMPONENT_TIMING_TOKEN.test(value.last_phase)) ||
      !COMPONENT_TIMING_STATUSES.has(value.status) || !Number.isFinite(value.elapsed_ms) || value.elapsed_ms < 0 ||
      !['pid', 'files', 'bytes'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
      !value.metrics || typeof value.metrics !== 'object' || Array.isArray(value.metrics)) continue
    const metrics = Object.fromEntries(Object.entries(value.metrics).filter(([name, metric]) =>
      COMPONENT_TIMING_TOKEN.test(name) && metric && Number.isSafeInteger(metric.calls) && metric.calls >= 0 &&
      Number.isFinite(metric.elapsed_ms) && metric.elapsed_ms >= 0
    ).map(([name, metric]) => [name, { calls: metric.calls, elapsed_ms: metric.elapsed_ms }]))
    const flush = Object.fromEntries(['flush_workers', 'flush_peak'].filter(key =>
      Number.isSafeInteger(value[key]) && value[key] >= 0
    ).map(key => [key, value[key]]))
    records.push({ check: label, kind: value.kind, version: value.version, operation: value.operation,
      pid: value.pid, status: value.status, last_phase: value.last_phase, elapsed_ms: value.elapsed_ms,
      files: value.files, bytes: value.bytes, ...flush, metrics })
  }
  return records
}

function packageCheckLog(frozen, label, executable, child) {
  const filename = path.join(frozen.runDirectory, `${PACKAGE_CHECK_LOG_PREFIX}-${label}.log`)
  fs.writeFileSync(
    filename,
    [
      `executable: ${executable}`,
      `status: ${child.status}`,
      `signal: ${child.signal || ''}`,
      `error: ${child.error ? String(child.error) : ''}`,
      '',
      'stdout:',
      child.stdout || '',
      '',
      'stderr:',
      child.stderr || '',
    ].join('\n')
  )
  for (const record of nativeStageRecords(child, label))
    console.log(`${NATIVE_STAGE_PREFIX}${JSON.stringify(record)}`)
  for (const record of componentTimingRecords(child, label))
    console.log(`${COMPONENT_TIMING_PREFIX}${JSON.stringify(record)}`)
  return filename
}

// The startup receipt precedes app.quit(). A zero Electron exit alone does not
// distinguish graceful backend cleanup from the force-kill timeout fallback.
function packageShutdownReceipt(log) {
  const records = log.split(/\r?\n/).flatMap((line) => {
    const match = /^(\S+) pid=(\d+) \[shell\] (.*)$/.exec(line)
    return match ? [{ at: Date.parse(match[1]), parent: match[2], event: match[3] }] : []
  })
  const ready = records.filter((record) => record.event.startsWith('backend ready '))
  const stops = records.filter((record) => record.event.startsWith('backend stop requested '))
  const exits = records.filter((record) => record.event.startsWith('backend exited '))
  const quits = records.filter((record) => record.event === 'will quit; draining log writes')
  if (ready.length !== 1 || stops.length !== 1 || exits.length !== 1 || quits.length !== 1)
    throw new Error('packaged backend shutdown receipt missing or ambiguous')
  const sequence = [ready[0], stops[0], exits[0], quits[0]]
  const identity = /^backend ready pid=(\d+) port=(\d+)$/.exec(ready[0].event)
  if (
    !identity ||
    !stops[0].event.startsWith(`backend stop requested pid=${identity[1]} port=${identity[2]} `) ||
    exits[0].event !== 'backend exited code=0 signal=null' ||
    sequence.some(
      (record, index) =>
        record.parent !== ready[0].parent ||
        !Number.isFinite(record.at) ||
        (index > 0 &&
          (record.at < sequence[index - 1].at ||
            records.indexOf(record) <= records.indexOf(sequence[index - 1])))
    )
  )
    throw new Error('packaged backend did not exit normally before Electron')
  return { code: 0, signal: null, elapsed_ms: exits[0].at - stops[0].at }
}

// Reopening shares HOME and therefore an append-only window log. Bind the
// receipt to the bytes appended by this invocation, retaining prior evidence.
function packageShutdownLogDelta(previous, current) {
  if (!Buffer.isBuffer(previous) || !Buffer.isBuffer(current) ||
      current.length < previous.length ||
      !current.subarray(0, previous.length).equals(previous))
    throw new Error('packaged backend shutdown log was truncated or changed')
  return current.subarray(previous.length).toString('utf8')
}

function productPath(pythonBin, runtimeBin) {
  return [pythonBin, runtimeBin, ...SYSTEM_PATHS].filter(Boolean).join(path.delimiter)
}

function resourcePath(root, relative) {
  return path.join(root, ...relative.split('/'))
}

function context() {
  const filename = process.env[CONTEXT_ENV]
  if (!filename) throw new Error('use scripts/cd/build.cjs: a frozen build context is required')
  const result = JSON.parse(fs.readFileSync(filename))
  if (
    result.schema !== 3 ||
    result.file !== filename ||
    !/^[a-f0-9]{64}$/.test(result.lockSha256 || '')
  ) {
    throw new Error('invalid or unfinished build context')
  }
  return result
}

function layout(application, frozen) {
  const selected = target(frozen.platform, frozen.arch)
  const resources =
    frozen.platform === 'darwin'
      ? path.join(application, 'Contents', 'Resources')
      : path.join(application, 'resources')
  return {
    selected,
    resources,
    python: frozen.platform === 'win32' ? bundledWindowsRuntime(application).python : resourcePath(path.join(resources, 'backend'), selected.pythonRelative),
    skillPython: skillPythonLauncherPath(path.join(resources, 'backend', 'bin'), frozen.platform),
    codex: frozen.platform === 'win32' ? bundledWindowsRuntime(application).codex : resourcePath(path.join(resources, 'backend'), selected.codexRelative),
    rg: path.join(resources, 'backend', 'bin', selected.ripgrepName),
    executable:
      frozen.platform === 'darwin'
        ? path.join(application, 'Contents', 'MacOS', frozen.productName)
        : path.join(application, `${frozen.productName}.exe`),
  }
}

function verifyIdentity(application, frozen) {
  if (frozen.platform === 'darwin') {
    const plist = path.join(application, 'Contents', 'Info.plist')
    for (const [field, expected] of Object.entries({
      CFBundleIdentifier: frozen.appId,
      CFBundleShortVersionString: frozen.version,
      CFBundleDevelopmentRegion: 'en',
      CFBundleDisplayName: EXPECTED_PRODUCT_NAME,
      CFBundleSpokenName: EXPECTED_SEARCH_ALIAS,
      LSHasLocalizedDisplayName: 'true',
      'MDItemKeywords.0': EXPECTED_SEARCH_ALIAS,
      'CFBundleURLTypes.0.CFBundleURLSchemes.0': EXPECTED_SCHEME,
    })) {
      if (command('plutil', ['-extract', field, 'raw', plist]) !== expected) {
        throw new Error(`app identity differs: ${field}`)
      }
    }
    for (const [locale, expected] of Object.entries(LOCALIZED_PRODUCT_NAMES)) {
      const localizedPlist = path.join(
        application,
        'Contents',
        'Resources',
        `${locale}.lproj`,
        'InfoPlist.strings'
      )
      if (
        command('plutil', ['-extract', 'CFBundleDisplayName', 'raw', localizedPlist]) !==
          expected ||
        command('plutil', ['-extract', 'CFBundleName', 'raw', localizedPlist]) !== expected
      ) {
        throw new Error(`localized app identity differs: ${locale}`)
      }
    }
  }
}

function verifySignedRuntime(filename, teamId) {
  const result = spawnSync('codesign', ['-d', '--verbose=4', filename], { encoding: 'utf8' })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (
    result.status !== 0 ||
    spawnSync('codesign', ['--verify', '--strict', filename]).status !== 0 ||
    !output.includes('flags=0x10000(runtime)') ||
    !/^Timestamp=.+$/m.test(output) ||
    !/^Authority=Developer ID Application:.+$/m.test(output) ||
    output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() !== teamId
  ) {
    throw new Error('packaged runtime Developer ID signature is incomplete')
  }
}

async function verifyContent(application, frozen, signed = false, execute = true) {
  await shipit.verify(application, frozen, signed)
  const current = layout(application, frozen)
  verifyNotices(current.resources, frozen.notices)
  const closure = verifyAsarClosure(current.resources, frozen.native)
  const { asar_bytes, ...compiledClosure } = closure
  if (JSON.stringify(compiledClosure) !== JSON.stringify(frozen.closure)) {
    throw new Error('artifact JavaScript differs from frozen compiled entries')
  }
  if (!frozen.native) throw new Error('application has no frozen native libraries')
  readNative(
    path.join(current.resources, 'native'),
    frozen.native,
    path.join(current.resources, 'app.asar.unpacked', 'out', 'main')
  )
  if (frozen.components) {
    readHandoff(path.join(current.resources, 'handoff'), frozen.handoff)
    readLauncher(application, frozen.launcher)
    return await verifyComponentArchives(application, frozen, current, closure)
  }
  const inventory = frozen.platform === 'darwin'
    ? await inspectBrowser(current.resources, frozen.browser, signed)
    : null
  const required = [
    current.executable,
    current.python,
    current.codex,
    current.rg,
    path.join(current.resources, 'renderer', 'index.html'),
    path.join(current.resources, 'defaults', 'config.json'),
    path.join(current.resources, 'product.json'),
    path.join(current.resources, 'backend', 'skills.lock.json'),
    current.skillPython,
  ]
  for (const filename of required) fs.accessSync(filename, fs.constants.R_OK)
  if (
    (await sha256(required[5])) !== frozen.config.sha256 ||
    (await sha256(required[6])) !== frozen.product.sha256 ||
    (await sha256(required[7])) !== frozen.lockSha256 ||
    (await sha256(current.codex)) !== frozen.binaries.codex.sha256 ||
    (signed && frozen.platform === 'darwin'
      ? (await executableDigest(current.rg)) !== frozen.binaries.rg.executable_sha256
      : (await sha256(current.rg)) !== frozen.binaries.rg.sha256)
  ) {
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
  const backend = path.join(current.resources, 'backend')
  for (const [filename, checksum] of [
    [REQUIREMENTS_FILENAME, frozen.pythonDependencies.requirements_sha256],
    [INVENTORY_FILENAME, frozen.pythonDependencies.inventory_sha256],
    [VERIFIER_FILENAME, frozen.pythonDependencies.verifier_sha256],
  ]) {
    if ((await sha256(path.join(backend, filename))) !== checksum) {
      throw new Error(`packaged Python dependency evidence changed: ${filename}`)
    }
  }
  const bytecode = frozen.pythonDependencies.bytecode
  if (!bytecode) throw new Error('frozen build context carries no Python bytecode evidence')
  // afterPack verifies immutable inputs only. Executing inside the incomplete
  // bundle can trigger macOS first-exec scanning before signing/notarization.
  if (!execute) return { current, imports: null, browser: inventory, closure }
  const browser = frozen.platform === 'darwin'
    ? await verifyBrowser(current.resources, frozen.arch, frozen.browser, signed)
    : null
  const reportedEngines = await probeTexlive(
    path.dirname(engines[0]),
    frozen.texlive.executables,
    frozen.texlive.texlive,
    frozen.platform
  )
  if (JSON.stringify(reportedEngines) !== JSON.stringify(frozen.texlive.reported)) {
    throw new Error('packaged TeX Live engines differ from the staged toolchain')
  }
  const imports = JSON.parse(
    command(current.python, ['-I', '-B', '-c', RUNTIME_PROBE_SCRIPT], {
      env: { ...process.env, SCHOLARSEED_PRODUCT_MANIFEST: required[6] },
    })
  )
  imports.runtime = verifyPython(current.python, frozen.runtime)
  command(current.python, [
    '-I',
    '-B',
    path.join(backend, VERIFIER_FILENAME),
    'verify',
    '--manifest',
    path.join(backend, INVENTORY_FILENAME),
    '--requirements',
    path.join(backend, REQUIREMENTS_FILENAME),
  ])
  const observedBytecode = inspectBytecode({backend, python: current.python,
    compilerSha256: bytecode.compiler_sha256}, process.env)
  if (JSON.stringify(observedBytecode) !== JSON.stringify(bytecode))
    throw new Error('packaged Python bytecode differs from the frozen inventory')
  imports.bytecode = observedBytecode
  return { current, imports, browser, closure }
}

/** Static checks must run before Electron prepares any persistent runtime. */
async function verifyComponentArchives(application, frozen, current, closure) {
  const backend = path.join(current.resources, 'backend')
  for (const tree of Object.values(WINDOWS_BUNDLED_RUNTIME_DIRS)) {
    if (fs.existsSync(path.join(backend, tree))) throw new Error(`duplicate bundled runtime tree: ${tree}`)
  }
  if (fs.existsSync(path.join(current.resources, 'renderer', 'office'))) throw new Error('duplicate bundled Office runtime')
  const directory = path.join(current.resources, COMPONENTS_DIRNAME)
  const manifestFile = path.join(directory, RUNTIME_MANIFEST_FILENAME)
  if (await sha256(manifestFile) !== frozen.runtime.manifestSha256) throw new Error('runtime envelope differs from frozen build')
  const manifest = readRuntimeManifest(application)
  if (JSON.stringify(manifest.components) !== JSON.stringify(frozen.components.components)) throw new Error('runtime manifest differs from frozen components')
  const expectedFiles = [RUNTIME_MANIFEST_FILENAME]
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expectedFiles)) throw new Error('unexpected bundled component material')
  const required = [
    current.executable,
    current.rg,
    path.join(current.resources, 'renderer', 'index.html'),
    path.join(current.resources, 'defaults', 'config.json'),
    path.join(current.resources, 'product.json'),
    path.join(current.resources, 'backend', 'skills.lock.json'),
    current.skillPython,
  ]
  for (const filename of required) fs.accessSync(filename, fs.constants.R_OK)
  if (
    (await sha256(required[3])) !== frozen.config.sha256 ||
    (await sha256(required[4])) !== frozen.product.sha256 ||
    (await sha256(required[5])) !== frozen.lockSha256 ||
    (await sha256(current.rg)) !== frozen.binaries.rg.sha256
  ) {
    throw new Error('packaged resources differ from frozen build inputs')
  }
  for (const [filename, checksum] of [
    [REQUIREMENTS_FILENAME, frozen.pythonDependencies.requirements_sha256],
    [INVENTORY_FILENAME, frozen.pythonDependencies.inventory_sha256],
    [VERIFIER_FILENAME, frozen.pythonDependencies.verifier_sha256],
  ]) {
    if ((await sha256(path.join(backend, filename))) !== checksum) {
      throw new Error(`packaged Python dependency evidence changed: ${filename}`)
    }
  }
  return { current, imports: null, browser: null, closure }
}

function verifyComponentInventory(directory, component) {
  // The signed manifest orders complete relative paths; the private build-state
  // walker uses depth-first directory order, which differs for foo/ and foo-bar.
  const actual = buildState.inventory(directory).filter(file => file.path !== COMPONENT_RECEIPT)
    .map(({path: relative, bytes, sha256: digest}) => ({path: relative, size: bytes, sha256: digest}))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  if (JSON.stringify(actual) !== JSON.stringify(component.files)) throw new Error(`prepared runtime inventory differs: ${component.kind}`)
  buildState.regular(path.join(directory, COMPONENT_RECEIPT))
}

// Runtime observations come from the actual packaged Electron process after the
// existing backend/renderer check. Static signatures and inventories remain
// independent gates; a matching version string alone is not acceptance.
function sameRuntimePath(actual, expected, paths = path) {
  return typeof actual === 'string' &&
    paths.toNamespacedPath(paths.resolve(actual)).toLowerCase() === paths.toNamespacedPath(paths.resolve(expected)).toLowerCase()
}

function verifyEngineEvidence(application, frozen, evidence) {
  if (frozen.platform !== 'win32') return
  const manifest = readRuntimeManifest(application)
  const component = manifest.components.find(item => item.kind === 'electron')
  if (!component || !frozen.electron?.version || !evidence || evidence.packaged !== true ||
      evidence.version !== frozen.electron.version || evidence.appVersion !== frozen.version ||
      typeof evidence.node !== 'string' || !/^\d+\.\d+\.\d+$/.test(evidence.node) ||
      typeof evidence.modules !== 'string' || !/^\d+$/.test(evidence.modules) ||
      typeof evidence.napi !== 'string' || !/^\d+$/.test(evidence.napi) || !Array.isArray(evidence.nativeModules))
    throw new Error('packaged Electron runtime identity differs from frozen engine')
  const resources = path.join(application, 'resources')
  const engine = path.join(path.dirname(application), 'runtime', component.kind, component.version)
  const same = sameRuntimePath
  for (const [field, expected] of Object.entries({
    appPath: path.join(resources, 'app.asar'),
    applicationResources: resources,
    launcher: path.join(application, `${frozen.productName}.exe`),
    executable: resourcePath(engine, component.entry),
    resources: path.join(path.dirname(resourcePath(engine, component.entry)), 'resources'),
  })) if (!same(evidence[field], expected)) throw new Error(`packaged Electron runtime path differs: ${field}`)
  const libraries = frozen.native?.libraries
  if (!Array.isArray(libraries) || evidence.nativeModules.length !== libraries.length)
    throw new Error('packaged Electron native module closure differs')
  const observed = new Set()
  for (const library of libraries) {
    const virtual = resourcePath(path.join(resources, 'app.asar'), library.path)
    const physical = resourcePath(path.join(resources, 'app.asar.unpacked'), library.path)
    const matches = evidence.nativeModules.filter(item => same(item?.path, virtual) || same(item?.path, physical))
    if (matches.length !== 1 || matches[0].loaded !== true || observed.has(matches[0]))
      throw new Error(`packaged Electron did not load the frozen native module: ${library.path}`)
    observed.add(matches[0])
  }
  return evidence
}

function verifyNativeExports(application, frozen, modules) {
  const libraries = frozen.native?.libraries
  if (!Array.isArray(libraries) || !Array.isArray(modules) || modules.length !== libraries.length)
    throw new Error('prepared Electron native export closure differs')
  for (const library of libraries) {
    const expected = resourcePath(path.join(application, 'resources', 'app.asar.unpacked'), library.path)
    const matches = modules.filter(item => sameRuntimePath(item?.path, expected))
    if (matches.length !== 1 || !Array.isArray(matches[0].exports) || !matches[0].exports.length ||
        !matches[0].exports.every(name => typeof name === 'string' && name.length > 0))
      throw new Error(`prepared Electron native exports unavailable: ${library.path}`)
  }
}

/** Product probes run only after real first-start preparation. */
async function verifyComponentContent(application, frozen, current, closure) {
  const backend = path.join(current.resources, 'backend')
  const runtime = bundledWindowsRuntime(application)
  const manifest = readRuntimeManifest(application)
  for (const component of manifest.components) {
    const directory = path.join(path.dirname(application), 'runtime', component.kind, component.version)
    verifyComponentInventory(directory, component)
  }
  if (await sha256(runtime.codex) !== frozen.binaries.codex.sha256) throw new Error('prepared Codex differs from frozen build')
  const pylibs = path.join(backend, 'pylibs')
  const imports = JSON.parse(command(runtime.python, ['-s', '-B', '-c', RUNTIME_PROBE_SCRIPT], {
    env: { ...process.env, PYTHONPATH: pylibs, SCHOLARSEED_PRODUCT_LIBS: pylibs,
      SCHOLARSEED_PRODUCT_MANIFEST: path.join(current.resources, 'product.json') },
  }))
  imports.runtime = verifyPython(runtime.python, frozen.runtime)
  command(runtime.python, ['-I', '-B', path.join(backend, VERIFIER_FILENAME), 'verify',
    '--manifest', path.join(backend, INVENTORY_FILENAME), '--requirements', path.join(backend, REQUIREMENTS_FILENAME)], {
    env: { ...process.env, SCHOLARSEED_PRODUCT_LIBS: pylibs },
  })
  const texlive = await probeTexlive(runtime.texlive, frozen.texlive.executables, frozen.texlive.texlive, frozen.platform)
  if (JSON.stringify(texlive) !== JSON.stringify(frozen.texlive.reported)) throw new Error('packaged TeX Live engines differ from the staged toolchain')
  const powershell = await probePowerShell(runtime.powershell, frozen.powershell.version)
  if (JSON.stringify(powershell) !== JSON.stringify(frozen.powershell.reported)) throw new Error('packaged PowerShell differs from the staged toolchain')
  const engine = manifest.components.find(component => component.kind === 'electron')
  if (!engine || !frozen.electron?.version) throw new Error('prepared Electron component is missing')
  const executable = resourcePath(path.join(path.dirname(application), 'runtime', engine.kind, engine.version), engine.entry)
  // Each require below is a static literal of a frozen, verified native path;
  // the product's observations remain independent of this ABI/export probe.
  const native = frozen.native.libraries.map(library => {
    const filename = JSON.stringify(resourcePath(path.join(application, 'resources', 'app.asar.unpacked'), library.path))
    return `{path:${filename},exports:Object.getOwnPropertyNames(require(${filename})).sort()}`
  }).join(',')
  const probe = `JSON.stringify({electron:process.versions.electron,node:process.versions.node,modules:process.versions.modules,executable:process.execPath,nativeModules:[${native}]})`
  const node = JSON.parse(command(executable, ['-p', probe], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
  }))
  if (node.electron !== frozen.electron.version || !/^\d+\.\d+\.\d+$/.test(node.node) || !/^\d+$/.test(node.modules) ||
      !sameRuntimePath(node.executable, executable))
    throw new Error('prepared Electron cannot provide the expected Node runtime')
  verifyNativeExports(application, frozen, node.nativeModules)
  imports.electronNode = node
  return { current, imports, browser: null, closure }
}

function verifyMacSeal(application) {
  if (spawnSync('codesign', ['--verify', '--deep', '--strict', application]).status !== 0) {
    throw new Error('artifact failed structural codesign verification')
  }
}

function trustCommand(stage, executable, args) {
  const started = Date.now()
  console.log(`[mac-trust] ${JSON.stringify({stage, status: 'start', timeout_ms: MAC_TRUST_TIMEOUT_MS})}`)
  try {
    const output = command(executable, args, {timeout: MAC_TRUST_TIMEOUT_MS})
    console.log(`[mac-trust] ${JSON.stringify({stage, status: 'passed', seconds: (Date.now() - started) / 1000})}`)
    return output
  } catch (error) {
    console.error(`[mac-trust] ${JSON.stringify({stage, status: 'failed', seconds: (Date.now() - started) / 1000,
      code: error.code, exit_code: error.status, signal: error.signal, pid: error.pid,
      stderr: String(error.stderr || '').slice(-TRUST_DIAGNOSTIC_BYTES)})}`)
    throw error
  }
}

function macTrust(application, frozen) {
  const result = spawnSync('codesign', ['-d', '--verbose=4', application], { encoding: 'utf8' })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  trustCommand('seal', 'codesign', ['--verify', '--deep', '--strict', application])
  if (!frozen.signingRequired) return { signature: 'ad-hoc' }
  trustCommand('staple', 'xcrun', ['stapler', 'validate', application])
  trustCommand('gatekeeper', 'spctl', ['--assess', '--type', 'execute', '--verbose=4', application])
  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || ''
  const developerId = output.match(/^Authority=(Developer ID Application:.+)$/m)?.[1]?.trim() || ''
  const receipt = JSON.parse(fs.readFileSync(path.join(frozen.runDirectory, 'notary.json')))
  if (
    !developerId ||
    teamId !== frozen.product.config.expected_team_id ||
    receipt.status !== 'Accepted'
  ) {
    throw new Error('Developer ID or notarization evidence is incomplete')
  }
  return {
    developer_id: developerId,
    team_id: teamId,
    notarization: receipt,
    stapled: true,
    gatekeeper: 'accepted',
  }
}

function unsignedPackageCheck(frozen) {
  return (
    frozen.platform === 'darwin' &&
    frozen.stage === 'dir' &&
    frozen.candidate &&
    !frozen.signingRequired
  )
}

function bestEffortRemoveTemporary(directory, timeoutMs = TEMP_CLEANUP_TIMEOUT_MS) {
  try {
    timed('verification.cleanup', () => removeTemporary(directory, timeoutMs))
  } catch (error) {
    console.warn(
      `[package] warning: could not remove temporary directory ${directory}: ${error.message}`
    )
  }
}

function packageCheckEnvironment(directory) {
  const home = path.join(directory, 'home')
  return {
    ...process.env,
    HOME: home,
    ...(process.platform === WINDOWS_PLATFORM ? {} : { USERPROFILE: home }),
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
    [PYTHON_DONT_WRITE_BYTECODE_ENV]: '1',
    SCHOLARSEED_HOME: home,
    SCHOLARSEED_PROJECT_DIRNAME: '.scholarseed',
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    SCHOLARSEED_DEFAULT_WORKSPACE: path.join(directory, 'workspace'),
  }
}

function packageCheckArguments(directory, result) {
  return [
    '--enable-logging=file',
    '--log-file',
    path.join(directory, 'electron.log'),
    `--user-data-dir=${path.join(directory, 'home', 'userData')}`,
    '--package-check',
    result,
  ]
}

async function runPackageCheck(application, frozen, label = 'unpacked', sharedDirectory) {
  return acceptance.withVerificationMutex(() =>
    timed(`verification.${label}`, () => packageCheck(application, frozen, label, sharedDirectory)))
}

function packageCheck(application, frozen, label, sharedDirectory) {
  if (frozen.skipCheck === true) {
    console.log(`[package] ${label} 启动验收: skipped (--skip-check)`)
    return { status: 'skipped', reason: '--skip-check' }
  }
  const current = layout(application, frozen)
  const directory = sharedDirectory || createPackageCheckDirectory(frozen)
  const result = path.join(directory, `${label}-result.json`)
  const home = path.join(directory, 'home')
  const workspace = path.join(directory, 'workspace')
  // The verifier must not inherit a CI umask that grants group/other write.
  fs.mkdirSync(home, { mode: 0o700, recursive: true })
  fs.mkdirSync(workspace, { mode: 0o700, recursive: true })
  const appData = path.join(home, 'AppData', 'Roaming')
  const localAppData = path.join(home, 'AppData', 'Local')
  const userData = path.join(home, 'userData')
  fs.mkdirSync(userData, { mode: 0o700, recursive: true })
  if (frozen.platform === 'win32') {
    fs.mkdirSync(appData, { recursive: true })
    fs.mkdirSync(localAppData, { recursive: true })
    fs.mkdirSync(path.join(home, 'Downloads'), { recursive: true })
  }
  const lifecycle = path.join(home, 'logs', 'window.log')
  const previousShutdownLog = fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle) : Buffer.alloc(0)
  if (previousShutdownLog.length > 4 * 1024 * 1024)
    throw new Error('packaged backend shutdown log exceeds limit')
  const finishProcess = startStage(`verification.${label}.process`)
  let child
  try {
    child = spawnSync(
      current.executable,
      packageCheckArguments(directory, result),
      {
        cwd: directory,
        env: packageCheckEnvironment(directory),
        timeout: CHECK_TIMEOUT_MS,
        encoding: 'utf8',
      }
    )
  } finally {
    finishProcess(child && !child.error && child.status === 0 ? 'passed' : 'failed')
  }
  const log = packageCheckLog(frozen, label, current.executable, child)
  try {
    if (child.error || child.status !== 0 || !fs.existsSync(result)) {
      if (child.stdout) process.stdout.write(child.stdout)
      if (child.stderr) process.stderr.write(child.stderr)
      const failure = child.error ? String(child.error) : `exit status ${child.status}`
      throw new Error(`packaged Electron check failed: ${failure}; log: ${log}`)
    }
    const payload = JSON.parse(fs.readFileSync(result))
    if (
      payload.schema !== 1 ||
      payload.ok !== true ||
      !payload.backend ||
      !payload.renderer ||
      payload.workbench !== true ||
      payload.platform !== frozen.platform
    ) {
      throw new Error('packaged Electron check returned an invalid result')
    }
    verifyEngineEvidence(application, frozen, payload.engine)
    if (fs.statSync(lifecycle).size > 4 * 1024 * 1024)
      throw new Error('packaged backend shutdown log exceeds limit')
    const shutdownBytes = fs.readFileSync(lifecycle)
    if (shutdownBytes.length > 4 * 1024 * 1024)
      throw new Error('packaged backend shutdown log exceeds limit')
    const shutdownLog = shutdownBytes.toString('utf8')
    fs.writeFileSync(
      path.join(frozen.runDirectory, `${PACKAGE_CHECK_LOG_PREFIX}-${label}-shutdown.log`),
      shutdownLog
    )
    try {
      return { ...payload, backend_shutdown: packageShutdownReceipt(packageShutdownLogDelta(previousShutdownLog, shutdownBytes)) }
    } catch (error) {
      const shutdownFile = path.join(frozen.runDirectory, `${PACKAGE_CHECK_LOG_PREFIX}-${label}-shutdown.log`)
      const evidence = `${shutdownLog}\n${child.stdout || ''}\n${child.stderr || ''}`
        .split(/\r?\n/)
        .filter((line) => /codex_shutdown|backend (ready|stop requested|exited)|will quit; draining/.test(line))
        .slice(-24)
        .map((line) => line.slice(0, 2048))
        .join('\n')
      console.error(`[package] ${label} shutdown evidence:\n${evidence}`)
      throw new Error(`${error.message}; shutdown log: ${shutdownFile}; process log: ${log}`, { cause: error })
    }
  } finally {
    if (!sharedDirectory) bestEffortRemoveTemporary(directory)
  }
}

async function verifyApplication(application, frozen, runtimeCheck) {
  verifyIdentity(application, frozen)
  const signed = !unsignedPackageCheck(frozen)
  // Assess the whole signed bundle before a short probe triggers first-launch
  // scanning, then wait out the kernel first-exec scan before the runtime probes.
  let trust = frozen.platform === 'darwin' && signed ? macTrust(application, frozen) : null
  // Ad-hoc lanes sign without a Developer ID but still pay the kernel first-exec
  // scan, so the handshake must cover every signed macOS application.
  if (frozen.platform === 'darwin' && signed) {
    trust.execution = await verifyExecution(layout(application, frozen).resources, frozen.browser)
  }
  let { current, imports, browser, closure } = await verifyContent(application, frozen, signed)
  let packageCheck = null
  if (runtimeCheck && frozen.platform === 'win32') {
    const directory = createPackageCheckDirectory(frozen)
    try {
      const first = await runPackageCheck(application, frozen, 'unpacked-first', directory)
      ;({ imports } = await verifyComponentContent(application, frozen, current, closure))
      const before = runtimeReuseEvidence(application)
      const second = await runPackageCheck(application, frozen, 'unpacked-reopen', directory)
      if (JSON.stringify(runtimeReuseEvidence(application)) !== JSON.stringify(before)) throw new Error('reopening replaced persistent runtime files')
      packageCheck = {...second, first_start: first, runtime_reused: true}
    } finally { bestEffortRemoveTemporary(directory) }
  }
  const updater = frozen.platform === 'win32' ? { engine: 'velopack' } : null
  if (frozen.platform === 'win32' && frozen.signingRequired) {
    trust = verifyWindowsSignature(current.executable, frozen.product.config.expected_windows_publisher)
  }
  const checkedPackage = runtimeCheck ? packageCheck || await runPackageCheck(application, frozen) : null
  if (runtimeCheck && frozen.platform === 'darwin' && signed) verifyMacSeal(application)
  return {
    path: application,
    content: 'passed',
    imports,
    browser,
    closure,
    updater,
    package_check: checkedPackage,
    signature_valid: signed && (frozen.platform === 'darwin' || frozen.signingRequired),
    trust,
  }
}

function runtimeReuseEvidence(application) {
  return readRuntimeManifest(application).components.map(component => {
    const directory = path.join(path.dirname(application), 'runtime', component.kind, component.version)
    return [component.kind, component.version, buildState.hashFile(path.join(directory, COMPONENT_RECEIPT)), [...component.files, {path: COMPONENT_RECEIPT}].map(file => {
      const stat = fs.statSync(path.join(directory, ...file.path.split('/')), {bigint: true})
      return [file.path, stat.dev.toString(), stat.ino.toString(), stat.mtimeNs.toString(), stat.birthtimeNs.toString()]
    })]
  })
}

function retirementResidue(directory) {
  let listing
  try { listing = fs.opendirSync(directory) } catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unreadable' }
  try { return listing.readSync() === null ? 'vacant' : 'occupied' } finally { listing.closeSync() }
}

async function waitForRetirement(directory, timeout = UNINSTALL_RETIREMENT_TIMEOUT_MS) {
  const start = Date.now()
  const deadline = start + timeout
  const remains = () => {
    try { fs.lstatSync(directory); return true }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  // 内容已清空说明卸载实质完成，仅目录句柄还被他方占用：由工作目录在安装目录外的本进程回收，
  // 不空等整段预算。内容仍在时保持原判定，交给诊断暴露真实残留。
  let lastReclaim = start
  let reclaimedMs = null
  let reclaimError = null
  const reclaim = () => {
    lastReclaim = Date.now()
    try { removeTemporary(directory, UNINSTALL_RETIREMENT_RECLAIM_MS); reclaimedMs = Date.now() - start; reclaimError = null }
    catch (error) { reclaimError = error.code || error.message }
  }
  while (remains() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, UNINSTALL_RETIREMENT_POLL_MS))
    if (remains() && retirementResidue(directory) === 'vacant' && Date.now() - lastReclaim >= UNINSTALL_RETIREMENT_RECLAIM_INTERVAL_MS) reclaim()
  }
  if (remains() && retirementResidue(directory) === 'vacant') reclaim()
  if (remains()) {
    const error = new Error(`Velopack uninstall left installation/runtime files after ${Date.now() - start}ms; acceptance retained: ${directory}${reclaimError ? `; reclaim failed: ${reclaimError}` : ''}`)
    error.code = 'UNINSTALL_RETIREMENT_TIMEOUT'
    throw error
  }
  return { complete: true, elapsedMs: Date.now() - start, timeoutMs: timeout, reclaimedMs }
}

async function retireVelopack(installed, frozen, environment, directory) {
  const launchLog = path.join(frozen.runDirectory, 'velopack-uninstall.json')
  const retirementLog = path.join(frozen.runDirectory, 'velopack-retirement.json')
  const nativeLog = path.join(environment.LOCALAPPDATA, 'velopack', `velopack_${frozen.appId}.log`)
  let launch
  const start = Date.now()
  return timedAsync('verification.velopack-retirement', async () => {
    try {
      const entry = path.join(installed, 'Uninstall.exe')
      launch = runInstaller(fs.existsSync(entry) ? entry : path.join(installed, 'Update.exe'),
        fs.existsSync(entry) ? ['--silent'] : ['--silent', 'uninstall'],
        { cwd: directory, timeout: CHECK_TIMEOUT_MS, env: environment },
        launchLog, 'Velopack', { operation: 'uninstall-launch' })
      const retirement = await waitForRetirement(installed)
      atomicJSON(retirementLog, { ...launch, phase: 'uninstall-retirement', retirement, engineLog: engineEvidence(nativeLog) })
      return retirement
    } catch (error) {
      const remaining = []
      let listing
      let inspectionError
      try {
        listing = fs.opendirSync(installed)
        for (let entry; remaining.length < UNINSTALL_REMAINDER_LIMIT && (entry = listing.readSync());)
          remaining.push(entry.name)
      } catch (inspection) { inspectionError = inspection.code }
      finally {
        if (listing) {
          try { listing.closeSync() } catch (inspection) { inspectionError ||= inspection.code }
        }
      }
      recordInstallerFailure({ ...launch, schema: 1, engine: 'Velopack',
        recordedAt: new Date().toISOString(), sourceLog: retirementLog, phase: 'uninstall-retirement',
        error: { code: error.code || 'UNINSTALL_FAILED', message: error.message },
        retirement: { complete: false, path: installed, elapsedMs: Date.now() - start,
          remaining, remainingLimit: UNINSTALL_REMAINDER_LIMIT, inspectionError },
        engineLog: engineEvidence(nativeLog),
      }, retirementLog, environment)
      throw error
    }
  })
}

async function verifyVelopackInstaller(installer, frozen) {
  return acceptance.withVerificationMutex(async () => {
    if (frozen.platform !== 'win32' || frozen.updateEngine !== 'velopack') throw new Error('Velopack acceptance requires Windows')
    assertCleanInstallation(frozen.appId)
    const directory = createPackageCheckDirectory(frozen)
    const installed = path.join(directory, 'app')
    const runtimeDirectory = createPackageCheckDirectory(frozen)
    let installedSuccessfully = false
    let evidence
    try {
      const environment = packageCheckEnvironment(runtimeDirectory)
      for (const name of ['APPDATA', 'LOCALAPPDATA']) fs.mkdirSync(environment[name], { recursive: true })
      runInstaller(installer, ['--silent', '--installto', installed],
        { timeout: CHECK_TIMEOUT_MS, env: environment }, path.join(frozen.runDirectory, 'velopack-install.json'), 'Velopack', { nativeLog: true })
      installedSuccessfully = true
      const application = path.join(installed, 'current')
      await verifyApplication(application, frozen, false)
      const uninstall = path.join(installed, frozen.launcher.uninstaller.file)
      if (buildState.hashFile(uninstall) !== frozen.launcher.uninstaller.sha256)
        throw new Error('installed uninstall entry differs from the frozen signed executable')
      if (frozen.signingRequired) verifyWindowsSignature(uninstall, frozen.product.config.expected_windows_publisher)
      const first = await runPackageCheck(application, frozen, 'installed-velopack-first', runtimeDirectory)
      const current = layout(application, frozen)
      const prepared = await verifyComponentContent(application, frozen, current, null)
      const before = runtimeReuseEvidence(application)
      const second = await runPackageCheck(application, frozen, 'installed-velopack-reopen', runtimeDirectory)
      if (JSON.stringify(runtimeReuseEvidence(application)) !== JSON.stringify(before)) throw new Error('reopening replaced persistent runtime files')
      evidence = { ...second, first_start: first, runtime_reused: true, runtime_imports: prepared.imports }
      return {
        path: installer, sha256: await sha256(installer), sha512: await sha512(installer),
        size: fs.statSync(installer).size, package_check: second, installed_check: evidence,
        signature_valid: frozen.signingRequired ? Boolean(verifyWindowsSignature(installer, frozen.product.config.expected_windows_publisher)) : false,
      }
    } finally {
      if (installedSuccessfully || fs.existsSync(path.join(installed, 'Update.exe'))) {
        const retirement = await retireVelopack(installed, frozen, packageCheckEnvironment(runtimeDirectory), directory)
        if (evidence) evidence.retirement = retirement
      }
      removeTemporary(runtimeDirectory)
      removeTemporary(directory)
    }
  })
}

async function verify(builderContext) {
  const frozen = context()
  if (builderContext.appOutDir) {
    const application =
      frozen.platform === 'darwin'
        ? path.join(builderContext.appOutDir, `${frozen.productName}.app`)
        : builderContext.appOutDir
    verifyIdentity(application, frozen)
    const { imports } = await verifyContent(application, frozen, false, false)
    const result = {
      path: application,
      content: 'passed',
      imports,
      package_check: null,
      signature_valid: false,
      trust: null,
    }
    atomicJSON(path.join(frozen.runDirectory, 'app.json'), result)
    return
  }
  if (!Array.isArray(builderContext.artifactPaths))
    throw new Error('unknown builder verification event')
  if (frozen.stage === 'dir' || frozen.buildPhase === 'application') {
    const application = JSON.parse(fs.readFileSync(path.join(frozen.runDirectory, 'app.json')))
    if (frozen.platform === 'win32') {
      const validationRoot = createPackageCheckDirectory(frozen)
      atomicJSON(path.join(frozen.runDirectory, 'app-validation.json'), {directory: validationRoot, purpose: 'unpacked application and persistent runtime acceptance'})
      const current = path.join(validationRoot, 'current')
      fs.renameSync(application.path, current)
      application.path = current
    }
    const checked = await verifyApplication(application.path, frozen, true)
    atomicJSON(path.join(frozen.runDirectory, 'app.json'), checked)
    return []
  }
  const extension = frozen.installer === 'dmg' ? '.dmg' : '.exe'
  const installers = builderContext.artifactPaths.filter((filename) => filename.endsWith(extension))
  if (installers.length !== 1) throw new Error('build did not produce exactly one installer')
  const installer = installers[0]
  if (frozen.installer === 'dmg') command('hdiutil', ['verify', installer])
  if (frozen.platform === 'win32' && frozen.signingRequired) {
    verifyWindowsSignature(installer, frozen.product.config.expected_windows_publisher)
  }
  const application = JSON.parse(fs.readFileSync(path.join(frozen.runDirectory, 'app.json')))
  const image = frozen.platform === 'darwin'
    ? await verifyImage(installer, application.path, frozen, verifyApplication)
    : null
  const checked = image ? image.checked : await verifyApplication(application.path, frozen, true)
  // sha512 is unconditional: the update service imports a build from this digest and
  // the client verifies its download against it, so a build without one can never be
  // distributed. The bytes were already streamed once for sha256.
  const evidence = {
    path: installer,
    sha256: await sha256(installer),
    sha512: await sha512(installer),
    size: fs.statSync(installer).size,
    package_check: checked.package_check,
    installed_check: image?.installed_check || null,
    signature_valid: checked.signature_valid,
    trust: checked.trust,
  }
  if (image) evidence.installed_check.sha256 = evidence.sha256
  atomicJSON(path.join(frozen.runDirectory, 'app.json'), image
    ? await verifyApplication(application.path, frozen, false)
    : checked)
  atomicJSON(path.join(frozen.runDirectory, 'installer.json'), evidence)
  return []
}

module.exports = verify
module.exports.atomicJSON = atomicJSON
module.exports.packageCheckLog = packageCheckLog
module.exports.nativeStageRecords = nativeStageRecords
module.exports.componentTimingRecords = componentTimingRecords
module.exports.packageShutdownReceipt = packageShutdownReceipt
module.exports.productPath = productPath
module.exports.RUNTIME_PROBE_SCRIPT = RUNTIME_PROBE_SCRIPT
module.exports.sha256 = sha256
module.exports.sha512 = sha512
module.exports.verifyApplication = verifyApplication
module.exports.unsignedPackageCheck = unsignedPackageCheck
module.exports.runPackageCheck = runPackageCheck
module.exports.packageCheckEnvironment = packageCheckEnvironment
module.exports.packageCheckArguments = packageCheckArguments
module.exports.artifactTemporaryRoot = artifactTemporaryRoot
module.exports.createPackageCheckDirectory = createPackageCheckDirectory
module.exports.protectWindowsVerificationDirectory = protectWindowsVerificationDirectory
module.exports.preflightDirectories = preflightDirectories
module.exports.bestEffortRemoveTemporary = bestEffortRemoveTemporary
module.exports.removeTemporary = removeTemporary
module.exports.DARWIN_UNIX_SOCKET_PATH_BYTES = DARWIN_UNIX_SOCKET_PATH_BYTES

module.exports.packageShutdownLogDelta = packageShutdownLogDelta


module.exports.verifyVelopackInstaller = verifyVelopackInstaller

module.exports.runtimeReuseEvidence = runtimeReuseEvidence
module.exports.waitForRetirement = waitForRetirement
module.exports.retireVelopack = retireVelopack
module.exports.verifyComponentArchives = verifyComponentArchives
module.exports.verifyComponentInventory = verifyComponentInventory
module.exports.verifyEngineEvidence = verifyEngineEvidence

module.exports.verifyNativeExports = verifyNativeExports
module.exports.sameRuntimePath = sameRuntimePath
