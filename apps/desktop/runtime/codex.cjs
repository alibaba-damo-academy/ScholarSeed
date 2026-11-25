// Product-owned fixed Codex runtime. Reviewed archives are downloaded on demand.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { withMacRuntimeCache } = require('./codex-cache.cjs')
const { promisify } = require('node:util')
const { nativeTar } = require('../../../scripts/shared/python.cjs')
const { ensureArtifact } = require('../../../scripts/shared/artifacts.cjs')
const state = require('../scripts/shared/build-state.cjs')
const CACHE_RECEIPT = 'resolve-receipt.json'
const SOURCE_PACKAGE = '@openai/codex'
const SOURCE_DISTRIBUTION = 'verified-download'
const PACKAGING_POLICIES = Object.freeze({
  darwin: Object.freeze({
    id: 'darwin-without-voice-v1',
    reason: 'voice_not_supported_by_product',
    excludedDirectories: Object.freeze(['codex-resources/voice'])
  }),
  win32: null
})

const run = promisify(execFile)
const VENDOR_RELATIVE = path.join('scripts', 'vendor', 'codex')
const MANIFEST_NAME = 'manifest.json'
const CACHE_DIRECTORY = 'node_modules/.cache/scholarseed/codex'
const CACHE_ROOT_ENV = 'SCHOLARSEED_BUILD_CACHE_ROOT'
const RUNTIME_CACHE_ENV = 'SCHOLARSEED_CODEX_RUNTIME_CACHE'
const PERSISTENT_CACHE_DIRECTORY = 'codex-runtime'
const PROBE_TIMEOUT_MS = 15_000
const PROBE_BOOTSTRAP_TIMEOUT_MS = 60_000
const METADATA_LIMIT = 8 * 1024 * 1024
const RUNTIME_FILE_MODE = 0o755
const WINDOWS_PLATFORM = 'win32'
const WINDOWS_PUBLISH_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000, 8000])
const WINDOWS_TRANSIENT_FILESYSTEM_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 1000
const CACHE_VALIDATION = Object.freeze({ execution: 'execution', integrity: 'integrity' })
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/

async function digest(filename, algorithm, encoding) {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest(encoding)
}

async function verifyArchive(filename, integrity) {
  if (!INTEGRITY_PATTERN.test(integrity) ||
      `sha512-${await digest(filename, 'sha512', 'base64')}` !== integrity) {
    throw new Error('Vendored Codex archive integrity mismatch')
  }
}

async function extractBinary(archive, member, destination) {
  const fd = fs.openSync(destination, 'wx', RUNTIME_FILE_MODE)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(nativeTar(), ['-xzOf', archive, member], { stdio: ['ignore', fd, 'pipe'],
        env: { ...process.env, COPYFILE_DISABLE: '1' } })
      let error = ''
      child.stderr.on('data', chunk => { error += chunk })
      child.once('error', reject)
      child.once('close', code => code === 0
        ? resolve()
        : reject(new Error(`Codex extraction failed: ${error}`)))
    })
    fs.fchmodSync(fd, RUNTIME_FILE_MODE)
  } finally {
    fs.closeSync(fd)
  }
}

async function publishRuntime(source, destination, options = {}) {
  const platform = options.platform || process.platform
  const rename = options.rename || fs.renameSync
  const delay = options.delay || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  let retryIndex = 0
  while (true) {
    try {
      rename(source, destination)
      return
    } catch (error) {
      const retryable = platform === WINDOWS_PLATFORM
        && WINDOWS_TRANSIENT_FILESYSTEM_ERRORS.has(error.code)
        && retryIndex < WINDOWS_PUBLISH_RETRY_DELAYS_MS.length
      if (!retryable) throw error
      await delay(WINDOWS_PUBLISH_RETRY_DELAYS_MS[retryIndex])
      retryIndex += 1
    }
  }
}

function vendorRoot(desktopRoot) {
  return path.resolve(desktopRoot, '..', '..', VENDOR_RELATIVE)
}

function artifact(desktopRoot, platform, arch) {
  const root = vendorRoot(desktopRoot)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8'))
  const key = `${platform}-${arch}`
  const selected = manifest.artifacts?.[key]
  const version = selected?.version ?? manifest.version
  const reviewedReceipt = platform !== 'darwin' ||
    (typeof selected?.receiptSha256 === 'string' && SHA256_PATTERN.test(selected.receiptSha256))
  if (manifest.package !== '@openai/codex' || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      !/^\d+\.\d+\.\d+$/.test(version) ||
      !selected || !reviewedReceipt || !INTEGRITY_PATTERN.test(selected.integrity) ||
      !SHA256_PATTERN.test(selected.sha256) || typeof selected.url !== 'string' ||
      !Number.isSafeInteger(selected.bytes) || selected.bytes <= 0) {
    throw new Error(`Unsupported vendored Codex platform: ${key}`)
  }
  const archive = path.join(root, selected.file)
  return { ...selected, archive, key, root, version }
}

async function probeVersion(executable, version) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], {
      timeout: PROBE_BOOTSTRAP_TIMEOUT_MS,
      env: { ...process.env, TMPDIR: os.tmpdir() }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.once('error', error => reject(new Error(`Codex runtime probe failed: ${error.message}`)))
    child.once('close', (code, signal) => (code === 0
      ? resolve(out)
      : reject(new Error(`Codex runtime probe failed: ${err || signal || code}`))))
  })
  const reported = stdout.trim()
  if (reported !== `codex-cli ${version}`) {
    throw new Error(`Codex version mismatch: expected codex-cli ${version}, got ${reported}`)
  }
}

function sourceRecord(selected) {
  return { package: SOURCE_PACKAGE, distribution: SOURCE_DISTRIBUTION,
    archive_sha256: selected.sha256, integrity: selected.integrity }
}

function cachedRuntime(directory, selected) {
  let receipt
  try {
    const filename = path.join(directory, CACHE_RECEIPT)
    if (state.regular(filename).size > METADATA_LIMIT) return null
    const bytes = fs.readFileSync(filename)
    if (selected.receiptSha256 && crypto.createHash('sha256').update(bytes).digest('hex') !== selected.receiptSha256) return null
    receipt = JSON.parse(bytes)
  } catch (error) {
    return null
  }
  if (receipt.archive_sha256 !== selected.sha256 ||
      receipt.reported_version !== selected.version ||
      typeof receipt.entrypoint !== 'string' ||
      !Array.isArray(receipt.files) ||
      !receipt.files.every(file => file && typeof file.path === 'string' &&
        file.path.length > 0 && !path.isAbsolute(file.path) &&
        !file.path.includes('\\') && !file.path.split('/').some(part => !part || part === '.' || part === '..') &&
        SHA256_PATTERN.test(file.sha256) && file.mode === RUNTIME_FILE_MODE) ||
      !receipt.files.some(file => file.path === receipt.entrypoint)) {
    return null
  }
  for (const file of receipt.files) {
    if (!fs.existsSync(path.join(directory, file.path))) return null
  }
  return {
    executable: path.join(directory, receipt.entrypoint),
    entrypoint: receipt.entrypoint,
    files: receipt.files
  }
}

function verifyCachedFiles(directory, cached) {
  const actual = state.inventory(directory).filter(file => file.path !== CACHE_RECEIPT)
    .map(file => ({ path: file.path, sha256: file.sha256 }))
  const expected = cached.files.map(file => ({ path: file.path, sha256: file.sha256 }))
  const order = (a, b) => a.path.localeCompare(b.path)
  if (JSON.stringify(actual.sort(order)) !== JSON.stringify(expected.sort(order)))
    throw new Error('Codex runtime cache inventory changed')
}

function stageVendoredCodex(runtime, destination, platform = process.platform) {
  if (!Object.hasOwn(PACKAGING_POLICIES, platform)) throw new Error('Unsupported Codex packaging platform')
  if (runtime.source?.package !== SOURCE_PACKAGE || runtime.source?.distribution !== SOURCE_DISTRIBUTION ||
      !SHA256_PATTERN.test(runtime.source.archive_sha256)) throw new Error('Invalid Codex source receipt')
  const source = path.resolve(runtime.root), target = path.resolve(destination)
  if (target === source || target.startsWith(source + path.sep) || source.startsWith(target + path.sep))
    throw new Error('Codex packaging destination overlaps source')
  if (fs.existsSync(target)) throw new Error('Codex packaging destination already exists')
  state.noLinks(source)
  state.noLinks(path.dirname(target))
  const receiptPath = path.join(source, CACHE_RECEIPT)
  state.regular(receiptPath)
  const receiptBytes = fs.readFileSync(receiptPath)
  const receipt = JSON.parse(receiptBytes)
  const cached = cachedRuntime(source, { sha256: runtime.source.archive_sha256, version: runtime.reported_version })
  if (!cached || receipt.packaging ||
      cached.entrypoint !== path.relative(source, runtime.path).split(path.sep).join('/') ||
      JSON.stringify(cached.files) !== JSON.stringify(runtime.files)) throw new Error('Codex source receipt differs from frozen input')
  verifyCachedFiles(source, cached)
  const policy = PACKAGING_POLICIES[platform]
  const excluded = file => policy && policy.excludedDirectories.some(directory => file.path.startsWith(directory + '/'))
  const files = cached.files.filter(file => !excluded(file))
  if (!files.some(file => file.path === cached.entrypoint)) throw new Error('Codex packaging excludes its entrypoint')
  const packaging = policy ? {
    schema: 1,
    policy: policy.id,
    reason: policy.reason,
    source_receipt_sha256: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
    excluded_files: cached.files.filter(excluded).map(file => ({
      ...file, bytes: state.regular(path.join(source, file.path)).size
    }))
  } : null
  fs.mkdirSync(target)
  for (const file of files) {
    const filename = path.join(target, file.path)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.copyFileSync(path.join(source, file.path), filename, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(filename, file.mode)
  }
  fs.writeFileSync(path.join(target, CACHE_RECEIPT), packaging
    ? JSON.stringify({ ...receipt, files, packaging }) : receiptBytes, { flag: 'wx' })
  verifyCachedFiles(target, { files })
  verifyCachedFiles(source, cached)
  if (!fs.readFileSync(receiptPath).equals(receiptBytes)) throw new Error('Codex source receipt changed during packaging')
  return packaging
}

async function completeRuntime(directory, selected, runtime, options = {}) {
  const probe = options.probe || probeVersion
  const receipt = JSON.stringify({
    archive_sha256: selected.sha256,
    reported_version: selected.version,
    entrypoint: runtime.entrypoint,
    files: runtime.files
  })
  if (selected.receiptSha256 && crypto.createHash('sha256').update(receipt).digest('hex') !== selected.receiptSha256)
    throw new Error('Vendored Codex runtime receipt differs from the reviewed archive')
  verifyCachedFiles(directory, runtime)
  await probe(path.join(directory, runtime.entrypoint), selected.version)
  verifyCachedFiles(directory, runtime)
  fs.writeFileSync(path.join(directory, CACHE_RECEIPT), receipt, { flag: 'wx' })
}

async function resolveVendoredCodex(
  desktopRoot,
  platform = process.platform,
  arch = process.arch,
  log = () => {},
  cachedValidation = CACHE_VALIDATION.execution
) {
  if (!Object.values(CACHE_VALIDATION).includes(cachedValidation)) {
    throw new Error('Unknown Codex cache validation policy')
  }
  const selected = artifact(desktopRoot, platform, arch)
  const persistent = process.env[RUNTIME_CACHE_ENV] ||
    (process.env[CACHE_ROOT_ENV] && path.join(process.env[CACHE_ROOT_ENV], PERSISTENT_CACHE_DIRECTORY))
  const cache = persistent
    ? state.ensurePrivateDirectory(persistent)
    : path.join(desktopRoot, CACHE_DIRECTORY)
  fs.mkdirSync(cache, { recursive: true })
  const directory = path.join(cache, `${selected.version}-${selected.key}-${selected.sha256}`)
  const resolve = registry => resolveRuntime({ platform, selected, cache, directory, log, persistent, cachedValidation, registry })
  if (platform === 'darwin' && (persistent || process.env.SCHOLARSEED_CODEX_REGISTRY_COMMAND)) {
    if (!persistent) throw new Error('Shared Codex runtime caching requires a private local cache directory')
    return withMacRuntimeCache(directory, selected, resolve, log)
  }
  return resolve(null)
}

function resolvedRuntime(directory, selected, runtime) {
  return {
    path: path.join(directory, runtime.entrypoint),
    root: directory,
    files: runtime.files,
    reported_version: selected.version,
    sha256: runtime.files.find(file => file.path === runtime.entrypoint).sha256,
    source: sourceRecord(selected)
  }
}

async function extractRuntime(selected, runtime) {
  await ensureArtifact(selected.archive, selected)
  if (await digest(selected.archive, 'sha256', 'hex') !== selected.sha256) {
    throw new Error('Vendored Codex archive SHA-256 mismatch')
  }
  await verifyArchive(selected.archive, selected.integrity)
  const prefix = `package/vendor/${selected.target}/`
  const members = (await run(nativeTar(), ['-tzf', selected.archive], {
    maxBuffer: METADATA_LIMIT
  })).stdout.trim().split(/\r?\n/)
  const files = []
  for (const member of members.filter(name => name.startsWith(prefix) && !name.endsWith('/'))) {
    const relative = member.slice(prefix.length)
    if (!relative || relative.split('/').some(part => !part || part === '..' || part === '.') ||
        path.isAbsolute(relative)) {
      throw new Error('Unsafe Codex package member')
    }
    const destination = path.join(runtime, relative)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    await extractBinary(selected.archive, member, destination)
    files.push({ path: relative, sha256: await digest(destination, 'sha256', 'hex'),
      mode: RUNTIME_FILE_MODE })
  }
  const packageManifest = JSON.parse(fs.readFileSync(path.join(runtime, 'codex-package.json')))
  if (packageManifest.target !== selected.target || typeof packageManifest.entrypoint !== 'string') {
    throw new Error('Codex runtime package manifest differs from its target')
  }
  for (const file of files) {
    const cached = path.join(runtime, file.path)
    if (await digest(cached, 'sha256', 'hex') !== file.sha256) {
      throw new Error(`Cached Codex runtime was modified: ${file.path}`)
    }
    fs.chmodSync(cached, file.mode)
  }
  return { entrypoint: packageManifest.entrypoint, files }
}

async function resolveRuntime({ platform, selected, cache, directory, log, persistent, cachedValidation, registry }) {
  const checkInventory = Boolean(selected.receiptSha256 || persistent || cachedValidation === CACHE_VALIDATION.integrity)
  if (checkInventory && fs.existsSync(directory)) state.noLinks(directory)
  let cached = cachedRuntime(directory, selected)
  if (cached) {
    try {
      if (checkInventory) verifyCachedFiles(directory, cached)
      for (const file of cached.files) fs.chmodSync(path.join(directory, file.path), file.mode)
      if (cachedValidation === CACHE_VALIDATION.execution) await probeVersion(cached.executable, selected.version)
    } catch {
      cached = null
    }
  }
  if (cached) {
    if (registry) await registry.confirmLocal(directory)
    log(`Vendored Codex ${selected.version} (cached): ${cached.executable}`)
    return resolvedRuntime(directory, selected, cached)
  }

  // Remove an invalid entry before building its replacement. A new entry that
  // appears during extraction belongs to a concurrent publisher.
  if (fs.existsSync(directory)) {
    fs.rmSync(directory, { recursive: true, force: true,
      maxRetries: platform === WINDOWS_PLATFORM ? WINDOWS_PUBLISH_RETRY_DELAYS_MS.length : 0,
      retryDelay: WINDOWS_CLEANUP_RETRY_DELAY_MS })
  }
  const stage = fs.mkdtempSync(path.join(cache, 'resolve-'))
  const runtime = path.join(stage, 'runtime')
  try {
    const restored = registry && await registry.fetch(runtime)
    let prepared
    if (restored) {
      state.noLinks(runtime)
      prepared = cachedRuntime(runtime, selected)
      if (!prepared) throw new Error('Shared Codex runtime receipt differs from the reviewed archive')
      verifyCachedFiles(runtime, prepared)
      fs.unlinkSync(path.join(runtime, CACHE_RECEIPT))
    } else {
      prepared = await extractRuntime(selected, runtime)
    }
    let published = false
    try {
      await publishRuntime(runtime, directory, { platform })
      published = true
    } catch (error) {
      // A concurrent build may have published the same fully verified input.
      const winner = cachedRuntime(directory, selected)
      if (!winner || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error
      verifyCachedFiles(directory, prepared)
      await probeVersion(winner.executable, selected.version)
    }
    if (published) await completeRuntime(directory, selected, prepared)
    if (registry) {
      if (restored) registry.recordPublication()
      else await registry.publish(directory)
    }
    const result = resolvedRuntime(directory, selected, prepared)
    log(`Vendored Codex ${selected.version}: ${result.path}`)
    return result
  } catch (error) {
    log(`Vendored Codex resolution failed before cleanup: ${error.stack || error}`)
    throw error
  } finally {
    fs.rmSync(stage, { recursive: true, force: true,
      maxRetries: platform === WINDOWS_PLATFORM ? WINDOWS_PUBLISH_RETRY_DELAYS_MS.length : 0,
      retryDelay: WINDOWS_CLEANUP_RETRY_DELAY_MS })
  }
}

function bundledCodex(resourcesRoot, platform = process.platform) {
  const executable = path.join(resourcesRoot, 'backend', 'codex-runtime', 'bin',
    platform === 'win32' ? 'codex.exe' : 'codex')
  fs.accessSync(executable, fs.constants.X_OK)
  return executable
}

module.exports = { artifact, bundledCodex, CACHE_VALIDATION, completeRuntime, publishRuntime, resolveVendoredCodex, stageVendoredCodex, verifyArchive }
