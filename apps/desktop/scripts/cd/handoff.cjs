// Build only the independent Velopack handoff target with the reviewed Go SDK.
// The historical updater store and command graph are not build dependencies.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { withCompiler } = require('./compiler.cjs')
const windows = require('./windows-sign.cjs')
const { timed } = require('../../../../scripts/shared/timing.cjs')
const { createPackageCheckDirectory } = require('./verification-directory.cjs')
const toolchain = require('../../updater/toolchain.json')

const MODULE = path.resolve(__dirname, '../../updater')
const EXECUTABLE = 'handoff.exe'
const LICENSE = 'HANDOFF-GO-LICENSE.txt'
const LAUNCHER = 'ScholarSeed.exe'
const UNINSTALLER = 'Uninstall.exe'
const LAUNCHER_LICENSE = 'LAUNCHER-GO-LICENSE.txt'
const VELOPACK_LIBRARY = 'libvelopack.dll'
const NATIVE_LANGUAGES = ['en', 'zh']
const RECOVERY_MESSAGE_SECTION = 'updateInterrupted'
const RECOVERY_MESSAGE_FIELDS = ['title', 'stopped', 'unconfirmed']
const DEPENDENCIES = new Set([
  'scholarseed.local/desktop/updater/handoff',
  'scholarseed.local/desktop/updater/cmd/handoff',
  'scholarseed.local/desktop/updater/internal/security',
])
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const fileHash = (filename) => hash(fs.readFileSync(filename))

function policyFor(context) {
  if (!context.runtime?.manifestSha256 || !context.runtime?.keys)
    throw new Error('handoff requires frozen component manifest and signing keys')
  return {
    schema: 1,
    product_id: context.product.config.product_id,
    bundle_id: context.product.config.bundle_id,
    app_id: context.appId,
    target: 'win32-x86_64',
    channel: context.product.config.update_channel,
    pack_version: `${context.version}-build.${context.product.config.build_number}`,
    executable: `${context.productName}.exe`,
    runtime_sha256: context.runtime.manifestSha256,
    recovery_messages: recoveryMessages(),
    update_messages: updateMessages(),
    keys: context.runtime.keys,
    signing: context.signingRequired
      ? { mode: 'authenticode', publisher: context.product.config.expected_windows_publisher }
      : { mode: 'unsigned-dev' },
  }
}

function run(executable, args, environment, cwd = MODULE) {
  const result = spawnSync(executable, args, {
    cwd, env: environment, windowsHide: true, encoding: 'utf8',
    timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0)
    throw new Error(`handoff build failed: ${result.error || result.stderr || result.stdout || result.status}`)
  return result.stdout.trim()
}

function testHandoff(executable, environment, frozen, launcher = false) {
  // Go's t.TempDir adds the test name. Keep fixtures out of the deep CI build
  // tree while retaining the same private directory policy as app verification.
  const temporary = createPackageCheckDirectory(frozen)
  try {
    run(executable, ['test', '-count=1', '-timeout=5m', './handoff', './cmd/handoff', ...(launcher ? ['./cmd/launcher', './cmd/uninstall'] : [])], {
      ...environment, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    })
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

function sourceDigest(folders = ['handoff', 'cmd/handoff']) {
  const files = []
  for (const folder of new Set([...folders, 'internal/security'])) {
    for (const name of fs.readdirSync(path.join(MODULE, folder)).sort()) {
      if (name.endsWith('.go') || name.endsWith('.json') || (folder === 'handoff' && name === 'logo.png')) files.push([`${folder}/${name}`, fileHash(path.join(MODULE, folder, name))])
    }
  }
  files.push(['go.mod', fileHash(path.join(MODULE, 'go.mod'))])
  files.push(['toolchain.json', fileHash(path.join(MODULE, 'toolchain.json'))])
  return hash(Buffer.from(JSON.stringify(files)))
}

function assertDependencies(output) {
  const actual = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (actual.length !== DEPENDENCIES.size || actual.some((name) => !DEPENDENCIES.has(name)))
    throw new Error(`handoff must depend only on stdlib and its own package: ${actual.join(', ')}`)
}

function validatePolicy(policy) {
  if (Object.keys(policy.update_messages || {}).sort().join(',') !== 'en,zh')
    throw new Error('invalid frozen update languages')
  for (const language of ['en', 'zh']) {
    const messages = policy.update_messages[language]
    if (!messages || Object.values(messages).some(value => typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) ||
        ['title', 'brand', 'elapsed', 'preparing', 'failed', 'exit', 'checking', 'publishing', 'ready', 'installing', 'restarting'].some(key => !messages[key]) ||
        ['{{name}}', '{{percent}}', '{{count}}', '{{total}}'].some(key => !messages.extracting?.includes(key)))
      throw new Error('invalid frozen update messages')
  }
  if (policy.schema !== 1 || policy.app_id !== 'scholarseed' || policy.target !== 'win32-x86_64' ||
      policy.executable !== 'ScholarSeed.exe' || !/^[a-f0-9]{64}$/.test(policy.runtime_sha256) ||
      !/^\d+\.\d+\.\d+-build\.\d{12}$/.test(policy.pack_version) ||
      !policy.product_id || !policy.bundle_id || !policy.channel ||
      !policy.keys || typeof policy.keys !== 'object' || Array.isArray(policy.keys) ||
      Object.keys(policy.keys).length > 8 || !policy.signing ||
      !['unsigned-dev', 'authenticode'].includes(policy.signing.mode) ||
      (policy.signing.mode === 'authenticode' && !policy.signing.publisher))
    throw new Error('invalid frozen handoff policy')
  if (!policy.recovery_messages || Object.keys(policy.recovery_messages).length !== NATIVE_LANGUAGES.length ||
      NATIVE_LANGUAGES.some(language => RECOVERY_MESSAGE_FIELDS.some(field =>
        typeof policy.recovery_messages[language]?.[field] !== 'string' ||
        !policy.recovery_messages[language][field].trim() || policy.recovery_messages[language][field].includes('\0'))))
    throw new Error('invalid frozen handoff recovery messages')
  for (const [id, key] of Object.entries(policy.keys)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || typeof key !== 'string' ||
        Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key)
      throw new Error('invalid handoff signing key')
  }
  return policy
}

/** outputDirectory is a build-owned standalone-resource directory, not LIBRARIES. */
async function prepareHandoff({ runDirectory, verificationRoot, repo, outputDirectory, policy, goArchive, signing,
  environment = process.env, launcher }) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('handoff packaging requires Windows x64')
  validatePolicy(policy)
  if (!signing || !['unsigned-dev', 'authenticode'].includes(signing.mode) ||
      (signing.mode === 'authenticode' && (!signing.publisher || !Object.keys(policy.keys).length)))
    throw new Error('explicit handoff signing policy required')
  if (policy.signing.mode !== signing.mode ||
      (signing.mode === 'authenticode' && policy.signing.publisher !== signing.publisher))
    throw new Error('compiled and executable signing policy differ')
  return withCompiler({runDirectory, goArchive, environment}, async ({temporary, goRoot, go, env, selected}) => {
    assertDependencies(run(go, ['list', '-deps', '-f', '{{if not .Standard}}{{.ImportPath}}{{end}}', './cmd/handoff'], env))
    timed('handoff.vet', () => run(go, ['vet', './handoff', './cmd/handoff', ...(launcher ? ['./cmd/launcher', './cmd/uninstall'] : [])], env))
    timed('handoff.test', () => testHandoff(go, env, { platform: 'win32', runDirectory, verificationRoot, repo }, Boolean(launcher)))
    const raw = Buffer.from(JSON.stringify(policy))
    const original = path.join(MODULE, 'cmd', 'handoff', 'main.go')
    const marker = 'var buildPolicy string'
    const source = fs.readFileSync(original, 'utf8')
    if (source.split(marker).length !== 2) throw new Error('unexpected handoff policy declaration')
    const replacement = path.join(temporary, 'main.go')
    fs.writeFileSync(replacement, source.replace(marker, `var buildPolicy = "${raw.toString('base64')}"`))
    const overlay = path.join(temporary, 'overlay.json')
    fs.writeFileSync(overlay, JSON.stringify({ Replace: { [original]: replacement } }))
    const compiled = path.join(temporary, EXECUTABLE)
    const sourceSha256 = sourceDigest()
    timed('handoff.compile', () => run(go, ['build', '-trimpath', '-buildvcs=false', '-overlay', overlay,
      '-ldflags', '-s -w', '-o', compiled, './cmd/handoff'], env))
    const checked = JSON.parse(run(compiled, ['--check-policy'], env))
    if (checked.schema !== 1 || checked.event !== 'policy' || checked.policy_sha256 !== hash(raw))
      throw new Error('compiled handoff policy differs')
    const unsignedSha256 = fileHash(compiled)
    if (signing.mode === 'authenticode') {
      await windows.signFile(compiled)
      windows.verify(compiled, signing.publisher)
    }
    if (sourceDigest() !== sourceSha256) throw new Error('handoff sources changed during compilation')
    fs.mkdirSync(outputDirectory, { recursive: true })
    const executable = path.join(outputDirectory, EXECUTABLE)
    fs.copyFileSync(compiled, executable, fs.constants.COPYFILE_EXCL)
    fs.copyFileSync(path.join(goRoot, 'LICENSE'), path.join(outputDirectory, LICENSE), fs.constants.COPYFILE_EXCL)
    const builtLauncher = launcher ? await prepareLauncher({ ...launcher, policy, signing,
      compiler: { executable: go, environment: env, root: goRoot, archiveSha256: selected.sha256 },
      temporary }) : undefined
    return Object.freeze({ schema: 1, file: EXECUTABLE, path: executable, sha256: fileHash(executable),
      bytes: fs.statSync(executable).size, unsignedSha256, sourceSha256,
      policySha256: hash(raw), compiler: { version: toolchain.version, archiveSha256: selected.sha256 },
      license: { file: LICENSE, sha256: fileHash(path.join(outputDirectory, LICENSE)) }, signing,
      ...(builtLauncher ? { launcher: builtLauncher } : {}) })
  })
}

function launcherMessages() {
  return Object.fromEntries(NATIVE_LANGUAGES.map(language => {
    const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/localization/locales', language, 'native.json'), 'utf8'))
    const text = source.startup
    return [language, { title: text.title, brand: text.brand, elapsed: text.elapsed, preparing: text.stages.components,
      verifying: text.stages.verifying, downloading: text.componentDownloading, extracting: text.componentExpanding,
      failed: text.componentFailed, retry: text.retry, exit: text.exit,
      stopping: text.stopping, cancel: source.tray.cancel }]
  }))
}

function updateMessages() {
  return Object.fromEntries(Object.entries(launcherMessages()).map(([language, startup]) => {
    const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/localization/locales', language, 'native.json'), 'utf8'))
    return [language, { ...startup, ...source.updateProgress, checking: source.startup.componentChecking,
      extracting: source.startup.componentExtracting, publishing: source.startup.componentPublishing,
      ready: source.startup.componentReady }]
  }))
}

function recoveryMessages() {
  return Object.fromEntries(NATIVE_LANGUAGES.map(language => {
    const filename = path.join(__dirname, '../../src/localization/locales', language, 'native.json')
    const location = `${filename}#${RECOVERY_MESSAGE_SECTION}`
    let source
    try {
      source = JSON.parse(fs.readFileSync(filename, 'utf8'))
    } catch (cause) {
      throw new Error(`invalid native handoff recovery messages: ${location}`, { cause })
    }
    const messages = source?.[RECOVERY_MESSAGE_SECTION]
    if (!messages || typeof messages !== 'object' || Array.isArray(messages))
      throw new Error(`invalid native handoff recovery messages: ${location}`)
    return [language, Object.fromEntries(RECOVERY_MESSAGE_FIELDS.map(field => {
      const message = messages[field]
      if (typeof message !== 'string' || !message.trim() || message.includes('\0'))
        throw new Error(`invalid native handoff recovery messages: ${location}.${field}`)
      return [field, message]
    }))]
  }))
}

/** Shares prepareHandoff's already-verified compiler/test session. */
async function prepareLauncher({ compiler, temporary, outputDirectory, policy, signing,
  componentBaseUrl, velopackLibrary, icon, version, productName, companyName, branding }) {
  validatePolicy(policy)
  if (!compiler?.executable || !compiler.root || !temporary)
    throw new Error('launcher requires the reviewed handoff compiler session')
  if (typeof branding !== 'function') throw new Error('launcher requires the prepared branding dependency')
  const base = new URL(componentBaseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('launcher component source must be HTTPS')
  if (!velopackLibrary?.path || !/^[a-f0-9]{64}$/.test(velopackLibrary.sha256) ||
      fs.statSync(velopackLibrary.path).size !== velopackLibrary.bytes ||
      fileHash(velopackLibrary.path) !== velopackLibrary.sha256)
    throw new Error('official Velopack library differs from reviewed toolchain')
  const own = run(compiler.executable, ['list', '-deps', '-f', '{{if not .Standard}}{{.ImportPath}}{{end}}', './cmd/launcher'], compiler.environment)
    .split(/\r?\n/).filter(Boolean)
  if (own.length !== 3 || own.some(name => !['scholarseed.local/desktop/updater/handoff',
    'scholarseed.local/desktop/updater/cmd/launcher', 'scholarseed.local/desktop/updater/internal/security'].includes(name)))
    throw new Error('launcher must depend only on stdlib and the existing handoff package')
  const raw = Buffer.from(JSON.stringify({ schema: 1, policy,
    component_base_url: componentBaseUrl, velopack_dll_sha256: velopackLibrary.sha256,
    messages: launcherMessages() }))
  const original = path.join(MODULE, 'cmd/launcher/main.go')
  const source = fs.readFileSync(original, 'utf8')
  const marker = 'var buildPolicy string'
  if (source.split(marker).length !== 2) throw new Error('unexpected launcher policy declaration')
  const replacement = path.join(temporary, 'launcher-main.go')
  fs.writeFileSync(replacement, source.replace(marker, `var buildPolicy = "${raw.toString('base64')}"`))
  const overlay = path.join(temporary, 'launcher-overlay.json')
  fs.writeFileSync(overlay, JSON.stringify({ Replace: { [original]: replacement } }))
  const executable = path.join(temporary, LAUNCHER)
  const sourceSha256 = sourceDigest(['handoff', 'cmd/launcher', 'cmd/uninstall'])
  timed('launcher.compile', () => run(compiler.executable, ['build', '-trimpath', '-buildvcs=false', '-overlay', overlay,
    '-ldflags', '-s -w -H=windowsgui', '-o', executable, './cmd/launcher'], compiler.environment))
  timed('launcher.policy-check', () => {
    const checked = JSON.parse(run(executable, ['--check-policy'], compiler.environment))
    if (checked.schema !== 1 || checked.event !== 'policy' || checked.policy_sha256 !== hash(raw))
      throw new Error('compiled launcher policy differs')
  })
  timed('launcher.branding', () => branding(executable, { icon, version, productName, companyName }))
  const uninstall = path.join(temporary, UNINSTALLER)
  timed('uninstaller.compile', () => run(compiler.executable, ['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w -H=windowsgui',
    '-o', uninstall, './cmd/uninstall'], compiler.environment))
  timed('uninstaller.branding', () => branding(uninstall, { icon, version, productName, companyName, originalFilename: UNINSTALLER }))
  const unsignedSha256 = fileHash(executable)
  if (signing.mode === 'authenticode') {
    await windows.signFile(executable)
    windows.verify(executable, signing.publisher)
    await windows.signFile(uninstall)
    windows.verify(uninstall, signing.publisher)
  }
  if (sourceDigest(['handoff', 'cmd/launcher', 'cmd/uninstall']) !== sourceSha256)
    throw new Error('launcher sources changed during compilation')
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.copyFileSync(executable, path.join(outputDirectory, LAUNCHER), fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(uninstall, path.join(outputDirectory, UNINSTALLER), fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(velopackLibrary.path, path.join(outputDirectory, VELOPACK_LIBRARY), fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(path.join(compiler.root, 'LICENSE'), path.join(outputDirectory, LAUNCHER_LICENSE), fs.constants.COPYFILE_EXCL)
  return Object.freeze({ schema: 1, file: LAUNCHER, path: path.join(outputDirectory, LAUNCHER),
    directory: outputDirectory, sha256: fileHash(executable), bytes: fs.statSync(executable).size,
    unsignedSha256, sourceSha256, policySha256: hash(raw),
    compiler: { version: toolchain.version, archiveSha256: compiler.archiveSha256 }, signing,
    uninstaller: { file: UNINSTALLER, sha256: fileHash(uninstall), bytes: fs.statSync(uninstall).size },
    library: { file: VELOPACK_LIBRARY, sha256: velopackLibrary.sha256, bytes: velopackLibrary.bytes },
    license: { file: LAUNCHER_LICENSE, sha256: fileHash(path.join(outputDirectory, LAUNCHER_LICENSE)) } })
}

function readLauncher(directory, frozen) {
  if (frozen?.schema !== 1 || frozen.uninstaller?.file !== UNINSTALLER || frozen.file !== LAUNCHER || frozen.library?.file !== VELOPACK_LIBRARY ||
      frozen.license?.file !== LAUNCHER_LICENSE) throw new Error('missing frozen launcher')
  for (const artifact of [frozen, frozen.library, frozen.license, frozen.uninstaller]) {
    const filename = path.join(directory, artifact.file)
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || (artifact.bytes && stat.size !== artifact.bytes) ||
        fileHash(filename) !== artifact.sha256) throw new Error('packaged launcher differs from frozen bytes')
  }
  const executable = path.join(directory, LAUNCHER)
  if (frozen.signing.mode === 'authenticode') {
    windows.verify(executable, frozen.signing.publisher)
    windows.verify(path.join(directory, UNINSTALLER), frozen.signing.publisher)
  }
  return { ...frozen, path: executable }
}

function readHandoff(directory, frozen) {
  if (frozen?.schema !== 1 || frozen.file !== EXECUTABLE || frozen.license?.file !== LICENSE)
    throw new Error('missing frozen handoff')
  const executable = path.join(directory, EXECUTABLE)
  for (const [name, digest] of [[executable, frozen.sha256], [path.join(directory, LICENSE), frozen.license.sha256]]) {
    const stat = fs.lstatSync(name)
    if (!stat.isFile() || stat.isSymbolicLink() || fileHash(name) !== digest)
      throw new Error('packaged handoff differs from frozen bytes')
  }
  if (frozen.signing.mode === 'authenticode') windows.verify(executable, frozen.signing.publisher)
  return { ...frozen, path: executable }
}

module.exports = { prepareHandoff, readHandoff, prepareLauncher, readLauncher, launcherMessages, updateMessages,
  policyFor, validatePolicy, assertDependencies, testHandoff }
