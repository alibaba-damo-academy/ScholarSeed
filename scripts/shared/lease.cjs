const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { assertWindowsPermissions, protectWindowsDirectory } = require('./permissions.cjs')

const MODES = new Set(['read', 'write'])
const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const UNSAFE_PERMISSIONS = 0o077
const WRITABLE_PERMISSIONS = 0o022
const STICKY_PERMISSION = 0o1000
const ADMISSION = 'admission'
const REGISTRY_PARTS = ['.ss-debug', 'leases']
const RECEIPT_SUFFIX = '.json'
const SCHEMA = 1
const WAIT_MS = 10
const ADMISSION_TIMEOUT_MS = 1000
const WINDOWS_ADMISSION_TIMEOUT_MS = 30000
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const DIGEST = /^[a-f0-9]{64}$/
const sleeper = new Int32Array(new SharedArrayBuffer(4))

function failure(code, message, directory) {
  const error = new Error(`${message}${directory ? `; inspect retained lease state at ${directory}` : ''}`)
  error.code = code
  return error
}

function assertPrivate(filename, directory = false) {
  const stat = fs.lstatSync(filename)
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
    throw failure('LEASE_DIRECTORY_UNSAFE', 'lease state must be private, owned and not redirected', filename)
  }
  if (process.platform === 'win32') {
    try { assertWindowsPermissions(filename) }
    catch { throw failure('LEASE_DIRECTORY_UNSAFE', 'cannot establish private Windows ACL and non-reparse ancestry', filename) }
  } else if (stat.uid !== process.getuid() || (stat.mode & UNSAFE_PERMISSIONS) !== 0) {
    throw failure('LEASE_DIRECTORY_UNSAFE', 'lease state must be private and owned', filename)
  }
  return stat
}

function registry(selected) {
  if (selected) {
    if (!path.isAbsolute(selected)) throw failure('LEASE_ARGUMENT_INVALID', 'lease directory must be absolute')
    assertPrivate(selected, true)
    const directory = fs.realpathSync(selected)
    assertAncestors(directory)
    return directory
  }
  let directory = fs.realpathSync(os.homedir())
  for (const component of REGISTRY_PARTS) {
    directory = path.join(directory, component)
    try {
      if (process.platform === 'win32') assertWindowsPermissions(path.dirname(directory))
      fs.mkdirSync(directory, { mode: DIRECTORY_MODE })
      if (process.platform === 'win32') protectWindowsDirectory(directory)
    }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    assertPrivate(directory, true)
  }
  assertAncestors(directory)
  return directory
}

function assertAncestors(directory) {
  if (process.platform === 'win32') return assertWindowsPermissions(directory)
  let parent = path.dirname(directory)
  for (;;) {
    const stat = fs.lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        ![0, process.getuid()].includes(stat.uid) ||
        ((stat.mode & WRITABLE_PERMISSIONS) !== 0 && (stat.mode & STICKY_PERMISSION) === 0)) {
      throw failure('LEASE_DIRECTORY_UNSAFE', 'lease directory has an unsafe ancestor', parent)
    }
    const next = path.dirname(parent)
    if (next === parent) return
    parent = next
  }
}

function canonical(filename) {
  try { return fs.realpathSync(filename) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    try {
      if (fs.lstatSync(filename).isSymbolicLink()) {
        throw failure('LEASE_RESOURCE_UNSAFE', 'cannot identify a dangling resource link')
      }
    } catch (missing) { if (missing.code !== 'ENOENT') throw missing }
    const parent = path.dirname(filename)
    if (parent === filename) throw error
    return path.join(canonical(parent), path.basename(filename))
  }
}

function identities(resources) {
  const values = resources.flatMap(filename => [
    path.join(canonical(path.dirname(filename)), path.basename(filename)),
    canonical(filename)
  ])
  return [...new Set(values.map(filename => process.platform === 'darwin'
    || process.platform === 'win32' ? filename.normalize('NFC').toLowerCase() : filename))].sort()
}

function overlaps(first, second) {
  return first === second || first.startsWith(`${second}${path.sep}`) ||
    second.startsWith(`${first}${path.sep}`) || first === path.parse(first).root || second === path.parse(second).root
}

function admitted(directory, action) {
  const gate = path.join(directory, ADMISSION)
  const deadline = Date.now() + (process.platform === 'win32' ? WINDOWS_ADMISSION_TIMEOUT_MS : ADMISSION_TIMEOUT_MS)
  for (;;) {
    assertPrivate(directory, true)
    try {
      fs.mkdirSync(gate, { mode: DIRECTORY_MODE })
      assertPrivate(gate, true)
      break
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      assertPrivate(gate, true)
      if (Date.now() >= deadline) throw failure('LEASE_ADMISSION_BUSY', 'lease admission is busy or abandoned; no automatic recovery', directory)
      Atomics.wait(sleeper, 0, 0, WAIT_MS)
    }
  }
  try { return action() }
  finally { fs.rmdirSync(gate) }
}

function readReceipt(directory, filename) {
  const absolute = path.join(directory, filename)
  try {
    assertPrivate(absolute)
    const descriptor = fs.openSync(absolute, process.platform === 'win32'
      ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let receipt
    try { receipt = JSON.parse(fs.readFileSync(descriptor, 'utf8')) }
    finally { fs.closeSync(descriptor) }
    if (receipt.schema !== SCHEMA || !UUID.test(receipt.id) || filename !== `${receipt.id}${RECEIPT_SUFFIX}` ||
        !MODES.has(receipt.mode) || !DIGEST.test(receipt.owner) || !Number.isSafeInteger(receipt.pid) ||
        receipt.pid <= 0 || !Array.isArray(receipt.resources) || !receipt.resources.length ||
        receipt.resources.some(resource => typeof resource !== 'string' || !path.isAbsolute(resource))) {
      throw new Error('invalid receipt')
    }
    return receipt
  } catch (error) {
    throw failure('LEASE_STATE_INVALID', `invalid or redirected lease receipt (${error.code || error.name}); no automatic recovery`, directory)
  }
}

function acquire(options) {
  if (!options || !MODES.has(options.mode) || !Array.isArray(options.resources) || !options.resources.length ||
      options.resources.some(resource => typeof resource !== 'string' || !path.isAbsolute(resource))) {
    throw failure('LEASE_ARGUMENT_INVALID', 'lease requires read/write mode and absolute resource paths')
  }
  const directory = registry(options.directory)
  const owner = crypto.randomBytes(32).toString('hex')
  const receipt = {
    schema: SCHEMA, id: crypto.randomUUID(), mode: options.mode, pid: process.pid,
    owner: crypto.createHash('sha256').update(owner).digest('hex'), resources: []
  }
  const filename = `${receipt.id}${RECEIPT_SUFFIX}`
  admitted(directory, () => {
    receipt.resources = identities(options.resources)
    for (const entry of fs.readdirSync(directory)) {
      if (entry === ADMISSION) continue
      const existing = readReceipt(directory, entry)
      if ((receipt.mode === 'write' || existing.mode === 'write') &&
          receipt.resources.some(resource => existing.resources.some(other => overlaps(resource, other)))) {
        throw failure('LEASE_CONFLICT', `environment resource is reserved by ${existing.mode} lease ${existing.id} (PID ${existing.pid} is diagnostic only)`, directory)
      }
    }
    fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: FILE_MODE })
  })
  let released = false
  return Object.freeze({
    directory,
    id: receipt.id,
    release() {
      if (released) return
      admitted(directory, () => {
        const existing = readReceipt(directory, filename)
        const expected = crypto.createHash('sha256').update(owner).digest('hex')
        if (existing.owner !== expected || existing.mode !== receipt.mode ||
            JSON.stringify(existing.resources) !== JSON.stringify(receipt.resources)) {
          throw failure('LEASE_STATE_INVALID', 'lease ownership changed; refusing release', directory)
        }
        fs.unlinkSync(path.join(directory, filename))
      })
      released = true
    }
  })
}

module.exports = { acquire }
