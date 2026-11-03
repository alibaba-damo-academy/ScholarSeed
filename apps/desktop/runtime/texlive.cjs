// Product-owned TeX Live toolchain for the bundled literature-review skill.
// The archive is a reviewed download; packaging verifies its SHA-256 before
// staging it, and both launch surfaces resolve the platform
// binary directory so the skill's `shutil.which` lookups find the shipped
// engines instead of depending on the host having TeX installed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const reviewedVersions = require('./versions.json')
const reviewedTexlive = require('../../../scripts/vendor/texlive/manifest.json')
const { nativeTar } = require('../../../scripts/shared/python.cjs')
const { artifactCache, ensureArtifact } = require('../../../scripts/shared/artifacts.cjs')

const VENDOR_RELATIVE = path.join('scripts', 'vendor', 'texlive')
const MANIFEST_NAME = 'manifest.json'
const CACHE_DIRECTORY = 'texlive'
const CACHE_COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM'])
const CACHE_RECEIPT = 'archive.sha256'
const BACKEND_DIRECTORY = 'backend'
const TREE_DIRECTORY = 'texlive'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PROBE_TIMEOUT_MS = 60_000
const PREPARATION_KILL_SIGNAL = 'SIGKILL'
const ARCH_ALIASES = { x86_64: 'x64' }
// A packaged app carries no repository checkout, so the staged layout is
// resolved here. Packaging asserts this map against the vendor manifest's
// `bin_relative`, which keeps the manifest authoritative without shipping it.
const PLATFORM_DIRECTORY = { darwin: 'universal-darwin', win32: 'windows' }
const WINDOWS_PLATFORM = 'win32'
const RUNTIME_CACHE_DIRNAME = 'cache'
const TEXLIVE_CACHE_DIRNAME = 'texlive'
const FONT_DIRECTORIES = ['opentype', 'truetype', 'type1']

const CACHE_VERSION_PATTERN = /^20[0-9]{2}(?:-[a-z0-9]+)*$/
const CACHE_IDENTITY_FILENAME = 'identity.json'
const CACHE_IDENTITY_SCHEMA = 1
const CACHE_FILES = ['identity.json', 'fonts.conf', 'fontconfig', 'texmf-var', 'texmf-config',
  'identity-00000000-0000-0000-0000-000000000000.tmp', 'fonts-00000000-0000-0000-0000-000000000000.tmp']
const CACHE_TEMPORARY_PATTERN = /^identity-[a-f0-9-]{36}\.tmp$/

function reviewedTexliveVersion(platform = process.platform) {
  return platform === WINDOWS_PLATFORM ? reviewedVersions.components.texlive.version : String(reviewedTexlive.texlive)
}

function reviewedTexliveArchive(platform = process.platform, arch = process.arch) {
  return platform === WINDOWS_PLATFORM ? reviewedVersions.components.texlive.archiveSha256 :
    reviewedTexlive.targets[`${platform}-${ARCH_ALIASES[arch] || arch}`]?.sha256
}

function validateCacheVersion(version) {
  if (typeof version !== 'string' || !CACHE_VERSION_PATTERN.test(version)) throw new Error('invalid TeX cache version')
}

function texliveStateRoot(runtimeRoot, version) {
  validateCacheVersion(version)
  return path.join(runtimeRoot, RUNTIME_CACHE_DIRNAME, TEXLIVE_CACHE_DIRNAME, version)
}

// Publish complete files without replacing another process's winning identity.
function publishCacheFile(root, name, content, prefix) {
  const file = path.join(root, name)
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== content) throw new Error('TeX cache configuration identity conflict')
    return
  }
  const temporary = path.join(root, `${prefix}-${crypto.randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' })
    try { fs.linkSync(temporary, file) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { fs.rmSync(temporary, { force: true }) }
  if (fs.readFileSync(file, 'utf8') !== content) throw new Error('TeX cache configuration identity conflict')
}

function texliveCacheRelativePaths(version) {
  validateCacheVersion(version)
  return CACHE_FILES.map(name => path.posix.join(RUNTIME_CACHE_DIRNAME, TEXLIVE_CACHE_DIRNAME, version, name))
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

// Callers must acquire the writable directory before preparing the environment.
// No vendor/system includes: they can introduce additional writable cachedirs.
function texliveFontDirectories({ binDirectory, environment = process.env, platform = process.platform, systemFonts = true }) {
  const tree = path.resolve(binDirectory, '..', '..')
  const fonts = FONT_DIRECTORIES.map(name => path.join(tree, 'texmf-dist', 'fonts', name))
  if (systemFonts && platform === 'win32') {
    if (environment.SystemRoot) fonts.push(path.join(environment.SystemRoot, 'Fonts'))
    if (environment.LOCALAPPDATA) fonts.push(path.join(environment.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
  } else if (systemFonts && platform === 'darwin') {
    fonts.push('/System/Library/Fonts', '/Library/Fonts')
    if (environment.HOME) fonts.push(path.join(environment.HOME, 'Library', 'Fonts'))
  }
  return fonts
}

function texliveExecutionResources(options) {
  const { version, archiveSha256 } = options
  validateCacheVersion(version)
  if (!SHA256_PATTERN.test(archiveSha256 || '')) throw new Error('invalid TeX archive identity')
  return Object.freeze({ version, archiveSha256,
    fontDirectories: Object.freeze(texliveFontDirectories(options)),
  })
}

function texliveConfiguration({ binDirectory, writableRoot, environment = process.env, platform = process.platform, systemFonts = true, version = reviewedTexliveVersion(platform), archiveSha256 = reviewedTexliveArchive(platform) }) {
  validateCacheVersion(version)
  if (!SHA256_PATTERN.test(archiveSha256 || '')) throw new Error('invalid TeX archive identity')
  const fonts = texliveFontDirectories({ binDirectory, environment, platform, systemFonts })
  const cache = path.join(writableRoot, 'fontconfig')
  const variable = path.join(writableRoot, 'texmf-var')
  const config = path.join(writableRoot, 'texmf-config')
  const file = path.join(writableRoot, 'fonts.conf')
  const content = '<?xml version="1.0"?>\n<fontconfig>\n' + fonts.map(dir => `<dir>${xml(dir)}</dir>`).join('\n') +
    `\n<cachedir>${xml(cache)}</cachedir>\n<alias><family>sans</family><prefer><family>sans-serif</family></prefer></alias>\n</fontconfig>\n`
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    schema: CACHE_IDENTITY_SCHEMA, version, archiveSha256, bin: path.resolve(binDirectory), platform, content,
  })).digest('hex')
  const identity = JSON.stringify({ schema: CACHE_IDENTITY_SCHEMA, version, fingerprint }) + '\n'
  return { identity, content, file, cache, variable, config, writableRoot }
}

// Read-only revalidation after Serve has acquired its long-lived data domains.
function texliveEnvironmentCurrent(options) {
  const expected = texliveConfiguration(options)
  try {
    return fs.readFileSync(path.join(expected.writableRoot, CACHE_IDENTITY_FILENAME), 'utf8') === expected.identity &&
      fs.readFileSync(expected.file, 'utf8') === expected.content
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Requires exclusive data-domain maintenance, including every running consumer.
// Keep the version root inode stable: its native identity is the lock anchor.
function rebuildTexliveEnvironment(options) {
  if ((options.platform || process.platform) !== 'darwin') throw new Error('TeX startup rebuild is macOS-only')
  texliveConfiguration(options) // Validate inputs before destructive work.
  const root = options.writableRoot
  const names = fs.readdirSync(root)
  const recognized = name => CACHE_FILES.includes(name) || CACHE_TEMPORARY_PATTERN.test(name) ||
    /^fonts-[a-f0-9-]{36}\.tmp$/.test(name) || SHA256_PATTERN.test(name)
  const inspect = file => {
    const entry = fs.lstatSync(file)
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || (entry.isFile() && entry.nlink !== 1))
      throw new Error('unsafe TeX cache member; refusing to rebuild')
    if (entry.isDirectory()) for (const name of fs.readdirSync(file)) inspect(path.join(file, name))
  }
  if (names.some(name => !recognized(name))) throw new Error('unknown TeX cache member; refusing to rebuild')
  inspect(root)
  // Inspect the entire tree before removing anything. A stopped partial rebuild
  // is safe to retry under the same exclusive qualification on the next launch.
  for (const name of names) fs.rmSync(path.join(root, name), { recursive: true, force: true })
  return prepareTexliveEnvironment(options)
}

function prepareTexliveEnvironment(options) {
  const { identity, content, file, cache, variable, config, writableRoot } = texliveConfiguration(options)
  fs.mkdirSync(writableRoot, { recursive: true })
  const receipt = path.join(writableRoot, CACHE_IDENTITY_FILENAME)
  // Never claim pre-existing, unidentifiable compiler state. Concurrent initial
  // publishers may have installed their receipt since our first observation.
  if (!fs.existsSync(receipt) && fs.readdirSync(writableRoot).some(name => !CACHE_TEMPORARY_PATTERN.test(name)) &&
      !fs.existsSync(receipt)) throw new Error('unidentified TeX cache; refusing to overwrite existing state')
  publishCacheFile(writableRoot, CACHE_IDENTITY_FILENAME, identity, 'identity')
  for (const directory of [cache, variable, config]) fs.mkdirSync(directory, { recursive: true })
  publishCacheFile(writableRoot, 'fonts.conf', content, 'fonts')
  return { FONTCONFIG_FILE: file, FONTCONFIG_PATH: writableRoot,
    TEXMFVAR: variable, TEXMFCONFIG: config, TEXMFCACHE: variable }
}

function texliveTreeDigest(binDirectory) {
  const tree = path.resolve(binDirectory, '..', '..')
  const hash = crypto.createHash('sha256')
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(directory, entry.name)
      hash.update(path.relative(tree, file).split(path.sep).join('/') + '\0')
      if (entry.isDirectory()) { hash.update('directory\0'); visit(file) }
      else if (entry.isFile()) { hash.update('file\0'); hash.update(crypto.createHash('sha256').update(fs.readFileSync(file)).digest()) }
      else if (entry.isSymbolicLink()) { hash.update('link\0' + fs.readlinkSync(file)) }
      else throw new Error('unsupported TeX tree member')
    }
  }
  visit(tree)
  return hash.digest('hex')
}

function executableName(name, platform = process.platform) {
  return platform === WINDOWS_PLATFORM ? `${name}.exe` : name
}

async function digest(filename, signal) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

function vendorRoot(desktopRoot) {
  return path.resolve(desktopRoot, '..', '..', VENDOR_RELATIVE)
}

// `desktopRoot` is apps/desktop, so the vendor directory is reachable in
// development and during packaging.
function artifact(desktopRoot, platform = process.platform, arch = process.arch) {
  const document = JSON.parse(
    fs.readFileSync(path.join(vendorRoot(desktopRoot), MANIFEST_NAME), 'utf8'))
  const key = `${platform}-${ARCH_ALIASES[arch] || arch}`
  const selected = document.targets?.[key]
  if (!selected || !/^\d{4}$/.test(String(document.texlive))) {
    throw new Error(`no bundled TeX Live distribution for ${key}`)
  }
  const executables = document.executables
  if (!Array.isArray(executables) || executables.length === 0 ||
      !executables.every(name => typeof name === 'string' && name.length > 0)) {
    throw new Error('TeX Live manifest declares no executables')
  }
  const archive = path.join(vendorRoot(desktopRoot), selected.archive)
  if (!SHA256_PATTERN.test(selected.sha256) || typeof selected.url !== 'string' ||
      !Number.isSafeInteger(selected.bytes) || selected.bytes <= 0) {
    throw new Error('TeX Live archive metadata is invalid')
  }
  const platformDirectory = selected.bin_relative.split('/').slice(-2).join('/')
  if (platformDirectory !== `bin/${PLATFORM_DIRECTORY[platform]}`) {
    throw new Error(`TeX Live manifest layout differs from the product layout: ${selected.bin_relative}`)
  }
  return { ...selected, archive, key, texlive: document.texlive, executables }
}

function binDirectory(treeRoot, selected, platform = process.platform) {
  const directory = path.join(treeRoot, ...selected.bin_relative.split('/'))
  for (const name of selected.executables) {
    fs.accessSync(path.join(directory, executableName(name, platform)), fs.constants.X_OK)
  }
  return directory
}

function probeEngine(binDir, name, platform, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(binDir, executableName(name, platform)), ['--version'], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      signal, killSignal: PREPARATION_KILL_SIGNAL,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    let failure
    child.once('error', error => { failure = error })
    child.once('close', (code, signal) => (failure
      ? reject(new Error(`TeX Live probe failed: ${name} (${failure.message})`))
      : code === 0
      ? resolve((out || err).split(/\r?\n/)[0].trim())
      : reject(new Error(`TeX Live probe failed: ${name} (${signal || code})`))))
  })
}

// Engines are probed in parallel: each probe is exec + page-in latency, so a
// sequential loop would multiply that latency by the engine count.
async function probe(binDir, executables, texlive, platform = process.platform, signal) {
  signal?.throwIfAborted()
  const results = await Promise.allSettled(executables.map(name => probeEngine(binDir, name, platform, signal)))
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
  const lines = results.map(result => result.value)
  const reported = {}
  executables.forEach((name, index) => { reported[name] = lines[index] })
  const expected = `TeX Live ${texlive}`
  if (!Object.values(reported).some(line => line.includes(expected))) {
    throw new Error(`TeX Live version mismatch: expected ${expected}, got ${JSON.stringify(reported)}`)
  }
  return reported
}

function cacheDirectory(selected, environment = process.env, platform = process.platform) {
  return path.join(artifactCache(environment, platform), CACHE_DIRECTORY, selected.sha256)
}

function publishCache(stage, directory, expectedDigest) {
  try {
    fs.renameSync(stage, directory)
  } catch (error) {
    const receipt = path.join(directory, CACHE_RECEIPT)
    if (!CACHE_COLLISION_CODES.has(error.code) || !fs.existsSync(receipt) ||
        fs.readFileSync(receipt, 'utf8').trim() !== expectedDigest) throw error
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

function vendoredTexliveLocation(desktopRoot, platform = process.platform,
  arch = process.arch, environment = process.env) {
  const selected = artifact(desktopRoot, platform, arch)
  const root = cacheDirectory(selected, environment, platform)
  return { selected, root, sha256: selected.sha256,
    binDirectory: path.join(root, ...selected.bin_relative.split('/')) }
}

async function resolveVendoredTexlive(desktopRoot, platform = process.platform,
  arch = process.arch, log = () => {}, signal) {
  signal?.throwIfAborted()
  const { selected, root: directory } = vendoredTexliveLocation(desktopRoot, platform, arch)
  const cache = path.dirname(directory)
  const receipt = path.join(directory, CACHE_RECEIPT)
  if (fs.existsSync(directory)) {
    if (!fs.existsSync(receipt) || fs.readFileSync(receipt, 'utf8').trim() !== selected.sha256) {
      throw new Error(`TeX Live cache is incomplete or does not match its archive. Stop Desktop, move ${directory} aside, then relaunch.`)
    }
    const binDir = binDirectory(directory, selected, platform)
    const reported = await probe(binDir, selected.executables, selected.texlive, platform, signal)
    log(`Vendored TeX Live ${selected.texlive} (cached): ${binDir}`)
    return { binDirectory: binDir, root: directory, reported, sha256: selected.sha256,
      texlive: selected.texlive }
  }
  await ensureArtifact(selected.archive, selected, { signal })
  // The cache key and the receipt already bind a cached tree to the reviewed
  // archive checksum, so the full archive digest is only paid on a cache miss.
  if (await digest(selected.archive, signal) !== selected.sha256) {
    throw new Error('TeX Live archive SHA-256 mismatch')
  }
  fs.mkdirSync(cache, { recursive: true })
  const stage = fs.mkdtempSync(path.join(cache, 'resolve-'))
  try {
    await extractArchive(nativeTar(platform), selected.archive, stage, signal)
    signal?.throwIfAborted()
    fs.writeFileSync(path.join(stage, CACHE_RECEIPT), `${selected.sha256}\n`, { flag: 'wx' })
    publishCache(stage, directory, selected.sha256)
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
  const binDir = binDirectory(directory, selected, platform)
  const reported = await probe(binDir, selected.executables, selected.texlive, platform, signal)
  log(`Vendored TeX Live ${selected.texlive}: ${binDir}`)
  return { binDirectory: binDir, root: directory, reported, sha256: selected.sha256,
    texlive: selected.texlive }
}

function extractArchive(executable, archive, destination, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-xzf', archive, '-C', destination], {
      windowsHide: true, signal, killSignal: PREPARATION_KILL_SIGNAL, stdio: 'ignore'
    })
    let failure
    child.once('error', error => { failure = error })
    child.once('close', (code, stopped) => failure ? reject(failure)
      : code === 0 ? resolve() : reject(new Error(`TeX extraction failed (${stopped || code})`)))
  })
}

// Packaging: stage the tree into resources/backend so it lands at
// backend/texlive/, matching the archive's top-level member.
function stageTexlive(backendDirectory, selected) {
  fs.mkdirSync(backendDirectory, { recursive: true })
  execFileSync(nativeTar(), ['-xzf', selected.archive, '-C', backendDirectory], { stdio: 'pipe' })
  return binDirectory(backendDirectory, selected)
}

// The single packaging entry point: verify the reviewed archive digest, stage
// it, assert every declared engine is executable, and probe their versions so a
// corrupt or foreign tree fails the build instead of the user's first survey.
async function stageVerifiedTexlive(backendDirectory, desktopRoot, platform = process.platform,
  arch = process.arch) {
  const selected = artifact(desktopRoot, platform, arch)
  await ensureArtifact(selected.archive, selected)
  if (await digest(selected.archive) !== selected.sha256) {
    throw new Error('TeX Live archive SHA-256 mismatch')
  }
  const binDir = stageTexlive(backendDirectory, selected)
  const reported = await probe(binDir, selected.executables, selected.texlive, platform)
  return { binDirectory: binDir, reported, sha256: selected.sha256, texlive: selected.texlive,
    executables: selected.executables }
}

// Packaged launcher: the tree is already staged under resources/backend/texlive.
function stagedBinDirectory(resourcesRoot, platform = process.platform) {
  const directory = PLATFORM_DIRECTORY[platform]
  if (!directory) throw new Error(`no bundled TeX Live layout for ${platform}`)
  return path.join(resourcesRoot, BACKEND_DIRECTORY, TREE_DIRECTORY, 'bin', directory)
}

function stagedEngines(resourcesRoot, platform, executables) {
  const binDir = stagedBinDirectory(resourcesRoot, platform)
  return executables.map(name => path.join(binDir, executableName(name, platform)))
}

function bundledTexlive(resourcesRoot, platform = process.platform) {
  const binDir = stagedBinDirectory(resourcesRoot, platform)
  fs.accessSync(path.join(binDir, executableName('xelatex', platform)), fs.constants.X_OK)
  return binDir
}

module.exports = { texliveExecutionResources, texliveEnvironmentCurrent, rebuildTexliveEnvironment, texliveCacheRelativePaths, reviewedTexliveArchive, reviewedTexliveVersion, prepareTexliveEnvironment, texliveTreeDigest, texliveStateRoot, RUNTIME_CACHE_DIRNAME, TEXLIVE_CACHE_DIRNAME, PLATFORM_DIRECTORY, TREE_DIRECTORY, artifact, binDirectory, bundledTexlive,
  cacheDirectory, publishCache,
  digest, executableName, probe, extractArchive, resolveVendoredTexlive, vendoredTexliveLocation, stagedBinDirectory, stagedEngines,
  stageTexlive, stageVerifiedTexlive }
