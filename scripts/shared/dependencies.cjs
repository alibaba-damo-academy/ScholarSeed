// Private immutable installation snapshots. Never caches product acceptance.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const state = require('../../apps/desktop/scripts/shared/build-state.cjs')
const crypto = require('node:crypto')
const { timed } = require('./timing.cjs')
const SCHEMA = 1
const ARCHIVE = 'installation.bin'
const RECEIPT = 'receipt.json'
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024
const MAX_ENTRIES = 200_000
const MAX_BYTES = 4 * 1024 * 1024 * 1024
const RECIPE = ['package.json', 'pyproject.toml', '.node-version', 'scripts/pre/toolchain.cjs',
  'scripts/shared/python.cjs', 'scripts/shared/dependencies.cjs', 'apps/desktop/package.json',
  'apps/desktop/.node-version', 'apps/desktop/package-lock.json']
const CONFIG_ENV = ['npm_config_registry', 'npm_config_ignore_scripts', 'npm_config_omit',
  'npm_config_include', 'npm_config_install_strategy', 'npm_config_legacy_peer_deps',
  'npm_config_strict_peer_deps', 'npm_config_bin_links', 'npm_config_install_links',
  'npm_config_platform', 'npm_config_arch', 'npm_config_build_from_source',
  'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH', 'ELECTRON_MIRROR', 'NODE_ENV',
  'npm_config_optional', 'npm_config_production', 'ELECTRON_CUSTOM_DIR',
  'ELECTRON_CUSTOM_FILENAME', 'ELECTRON_SKIP_BINARY_DOWNLOAD', 'ESBUILD_BINARY_PATH']
function inputs(repo, tools, command, environment = process.env) {
  const desktop = path.join(repo, 'apps', 'desktop')
  const lock = JSON.parse(fs.readFileSync(path.join(desktop, 'package-lock.json')))
  // Local dependencies and external Electron overrides are not relocatable snapshots.
  if (environment.ELECTRON_OVERRIDE_DIST_PATH || Object.values(lock.packages || {}).some(p =>
    p.link || /^(file:|link:|\.\.\/)/.test(p.resolved || ''))) return null
  const config = execFileSync(command.executable, [...command.args, 'config', 'get', 'globalconfig'],
    { cwd: desktop, encoding: 'utf8', windowsHide: true, env: environment }).trim()
  const files = [...RECIPE.map(f => path.join(repo, f)), path.join(repo, '.npmrc'),
    path.join(desktop, '.npmrc'), environment.npm_config_userconfig || path.join(os.homedir(), '.npmrc'), config]
  return { schema: SCHEMA, platform: process.platform, arch: process.arch, abi: process.versions.modules,
    node: tools.node.version, npm: tools.npm.version,
    files: files.map(f => fs.existsSync(f) ? state.hashFile(f) : null),
    // Hash configuration values; credentials/configuration contents never enter receipts/logs.
    environment: state.identity(Object.entries(environment).filter(([k]) =>
      (CONFIG_ENV.includes(k) || /^npm_config_/i.test(k)) && !['npm_config_cache', 'npm_config_local_prefix', 'npm_config_global_prefix', 'npm_config_prefix'].includes(k.toLowerCase())).sort(([a], [b]) => a.localeCompare(b))) }
}
function tree(directory) {
  state.noLinks(directory)
  const entries = []
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  function digest(filename) {
    const hash = crypto.createHash('sha256'), fd = fs.openSync(filename, 'r')
    try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)) }
    finally { fs.closeSync(fd) }
    return hash.digest('hex')
  }
  let bytes = 0
  function scan(current, prefix) {
    for (const name of fs.readdirSync(current).sort()) {
      if (/[\r\n\\]/.test(name)) throw new Error('unsupported npm cache filename')
      const filename = path.join(current, name), stat = fs.lstatSync(filename)
      const relative = prefix + name
      if (stat.isSymbolicLink()) throw new Error('npm cache links are not supported')
      if (stat.isDirectory()) {
        entries.push({ path: relative + '/', directory: true })
        scan(filename, relative + '/')
      } else {
        state.regular(filename)
        bytes += stat.size
        entries.push({ path: relative, bytes: stat.size, sha256: digest(filename) })
      }
      if (entries.length > MAX_ENTRIES || bytes > MAX_BYTES) throw new Error('npm cache exceeds budget')
    }
  }
  scan(directory, 'node_modules/')
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}
// A flat data file contains only file bytes in receipt order. No archive headers,
// links, executable metadata or extraction library can redirect writes.
function copyBytes(input, output, bytes, expected, buffer) {
  const hash = crypto.createHash('sha256')
  let remaining = bytes
  while (remaining) {
    const n = fs.readSync(input, buffer, 0, Math.min(buffer.length, remaining), null)
    if (!n) throw new Error('truncated npm snapshot')
    hash.update(buffer.subarray(0, n))
    let written = 0
    while (written < n) written += fs.writeSync(output, buffer, written, n - written)
    remaining -= n
  }
  if (hash.digest('hex') !== expected) throw new Error('npm snapshot file changed')
}
function writeSnapshot(desktop, filename, entries) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  const output = fs.openSync(filename, 'wx', 0o600)
  try {
    for (const e of entries) {
      if (e.directory) continue
      const source = path.join(desktop, ...e.path.split('/'))
      const before = state.regular(source), input = fs.openSync(source, 'r')
      try {
        const opened = fs.fstatSync(input)
        if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev)
          throw new Error('npm snapshot source replaced')
        copyBytes(input, output, e.bytes, e.sha256, buffer)
      } finally { fs.closeSync(input) }
    }
    fs.fsyncSync(output)
  } finally { fs.closeSync(output) }
}
function readSnapshot(entry, directory) {
  fs.mkdirSync(path.join(directory, 'node_modules'))
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  const input = fs.openSync(entry.archive, 'r')
  try {
    for (const e of entry.receipt.entries) {
      const destination = path.join(directory, ...e.path.split('/').filter(Boolean))
      if (e.directory) { fs.mkdirSync(destination, { recursive: true }); continue }
      // The complete sorted inventory creates each parent before its files.
      // Missing parents are invalid snapshots and trigger the full npm ci path.
      const output = fs.openSync(destination, 'wx', 0o600)
      try { copyBytes(input, output, e.bytes, e.sha256, buffer) }
      finally { fs.closeSync(output) }
    }
  } finally { fs.closeSync(input) }
}
function validate(root, keyInputs) {
  const entry = path.join(root, state.identity(keyInputs))
  if (!fs.existsSync(entry)) return null
  state.assertPrivateDirectory(entry)
  if (JSON.stringify(fs.readdirSync(entry).sort()) !== JSON.stringify([ARCHIVE, RECEIPT])) throw new Error('incomplete npm cache')
  const receiptFile = path.join(entry, RECEIPT), archive = path.join(entry, ARCHIVE)
  state.assertPrivateFile(receiptFile)
  if (state.regular(receiptFile).size > MAX_RECEIPT_BYTES) throw new Error('oversized npm cache receipt')
  const receipt = JSON.parse(fs.readFileSync(receiptFile))
  if (receipt.schema !== SCHEMA || state.identity(receipt.inputs) !== state.identity(keyInputs) ||
      !Array.isArray(receipt.entries) || receipt.entries.length > MAX_ENTRIES) throw new Error('npm cache input mismatch')
  const names = new Set(['node_modules'])
  let bytes = 0
  for (const e of receipt.entries) {
    if (typeof e.path !== 'string' || !e.path.startsWith('node_modules/') || /[\\\r\n:]/.test(e.path) ||
        e.path.split('/').filter(Boolean).some(p => p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p)) ||
        /\/\//.test(e.path) || (e.directory === true) !== e.path.endsWith('/') || names.has(e.path.replace(/\/$/, '').toLowerCase())) throw new Error('invalid npm cache path')
    names.add(e.path.replace(/\/$/, '').toLowerCase())
    if (e.directory !== true) {
      if (!Number.isSafeInteger(e.bytes) || e.bytes < 0 || !state.SHA256.test(e.sha256)) throw new Error('invalid npm cache file')
      bytes += e.bytes
    }
  }
  if (bytes > MAX_BYTES) throw new Error('npm cache exceeds budget')
  state.assertPrivateFile(archive)
  if (state.regular(archive).size !== receipt.bytes || state.hashFile(archive) !== receipt.sha256) throw new Error('npm cache archive changed')
  if (receipt.bytes !== bytes) throw new Error('npm snapshot data length differs')
  return { archive, receipt }
}
function restore(root, keyInputs, desktop, verify) {
  root = state.ensurePrivateDirectory(root)
  let temporary
  try {
    const entry = timed('npm.cache-lookup', () => validate(root, keyInputs))
    if (!entry) { console.log('[npm-cache] miss'); return false }
    const scratch = state.ensurePrivateDirectory(path.join(desktop, '..', '..', 'tmp', 'npm-installation'))
    temporary = fs.mkdtempSync(path.join(scratch, 'restore-'))
    timed('npm.cache-restore', () => readSnapshot(entry, temporary))
    const candidate = path.join(temporary, 'node_modules')
    timed('npm.cache-inventory', () => {
      if (JSON.stringify(tree(candidate)) !== JSON.stringify(entry.receipt.entries) ||
          state.hashFile(entry.archive) !== entry.receipt.sha256) throw new Error('restored npm cache differs')
    })
    const target = path.join(desktop, 'node_modules')
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(candidate, target)
    timed('npm.cache-probes', verify)
    console.log('[npm-cache] hit; inventory and installed tools verified')
    return true
  } catch (error) {
    // The caller runs a complete npm ci, which removes any partially restored installation.
    console.warn(`[npm-cache] rejected; falling back to npm ci (${error.code || 'validation failed'})`)
    return false
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }) }
}
function publish(root, keyInputs, desktop) {
  root = state.ensurePrivateDirectory(root)
  const entry = path.join(root, state.identity(keyInputs))
  // Bad entries are not replaced or silently blessed by a successful fallback install.
  if (fs.existsSync(entry)) return
  const temporary = fs.mkdtempSync(path.join(root, '.publish-'))
  try {
    const entries = tree(path.join(desktop, 'node_modules'))
    const archive = path.join(temporary, ARCHIVE)
    writeSnapshot(desktop, archive, entries)
    const receipt = { schema: SCHEMA, inputs: keyInputs, entries,
      bytes: fs.statSync(archive).size, sha256: state.hashFile(archive) }
    fs.writeFileSync(path.join(temporary, RECEIPT), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    try { fs.renameSync(temporary, entry) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !fs.existsSync(entry)) throw error
      validate(root, keyInputs)
    }
    console.log('[npm-cache] stored verified installation')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
module.exports = { inputs, tree, validate, restore, publish }
