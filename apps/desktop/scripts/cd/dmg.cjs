// Final-image acceptance. Never borrow the unpacked application's trust evidence.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')

const TIMEOUT_MS = 180_000
const PREFIX = '[dmg-verification]'
const DIAGNOSTIC_TIMEOUT_MS = 10_000
const DIAGNOSTIC_BYTES = 8192
const DIAGNOSTIC_BUFFER_BYTES = 1024 * 1024

function inventory(root, details = []) {
  const digest = crypto.createHash('sha256')
  let files = 0
  const buffer = Buffer.alloc(1024 * 1024)
  function visit(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const key = relative ? `${relative}/${name}` : name
      const filename = path.join(directory, name)
      const stat = fs.lstatSync(filename)
      const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unsupported'
      if (type === 'unsupported') throw new Error(`unsupported DMG member: ${key}`)
      const record = [key, type, stat.mode & 0o777]
      digest.update(JSON.stringify(record))
      if (type === 'link') {
        const target = fs.readlinkSync(filename)
        digest.update(JSON.stringify(target))
        record.push(target)
      }
      if (type === 'directory') visit(filename, key)
      if (type === 'file') {
        const member = crypto.createHash('sha256')
        const fd = fs.openSync(filename, 'r')
        try {
          let count
          while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) member.update(buffer.subarray(0, count))
        } finally { fs.closeSync(fd) }
        const hash = member.digest()
        digest.update(hash)
        record.push(hash.toString('hex'))
        files += 1
      }
      details.push(record)
    }
  }
  visit(root)
  return { sha256: digest.digest('hex'), files }
}

function mountUsers(directory) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '+f', '--', directory], {
    encoding: 'utf8', timeout: DIAGNOSTIC_TIMEOUT_MS, maxBuffer: DIAGNOSTIC_BUFFER_BYTES,
  })
  return {exit_code: result.status, signal: result.signal, code: result.error?.code,
    output: String(result.stdout || '').slice(-DIAGNOSTIC_BYTES),
    stderr: String(result.stderr || '').slice(-DIAGNOSTIC_BYTES)}
}

async function verifyImage(installer, source, frozen, verifyApplication, dependencies = {}) {
  const command = dependencies.command || ((args) => execFileSync('hdiutil', args, {encoding: 'utf8', timeout: TIMEOUT_MS}))
  const inspect = dependencies.inventory || inventory
  const diagnose = dependencies.mountUsers || mountUsers
  const log = dependencies.log || (record => console.log(`${PREFIX} ${JSON.stringify(record)}`))
  const directory = fs.mkdtempSync(path.join(frozen.runDirectory, 'image-'))
  let mounted = false
  let failure
  let checked
  let members
  try {
    log({stage: 'mount', status: 'start'})
    command(['attach', '-readonly', '-nobrowse', '-mountpoint', directory, installer])
    mounted = true
    const entries = fs.readdirSync(directory).filter(name => name.endsWith('.app'))
    if (entries.length !== 1 || entries[0] !== path.basename(source)) throw new Error('DMG must contain exactly the expected application')
    const application = path.join(directory, entries[0])
    if (!fs.lstatSync(application).isDirectory() || fs.lstatSync(application).isSymbolicLink()) throw new Error('DMG application must be a directory')
    const actualDetails = []
    const expectedDetails = []
    members = inspect(application, actualDetails)
    const expected = inspect(source, expectedDetails)
    if (members.sha256 !== expected.sha256 || members.files !== expected.files) {
      const actual = new Map(actualDetails.map(record => [record[0], JSON.stringify(record)]))
      const expectedMap = new Map(expectedDetails.map(record => [record[0], JSON.stringify(record)]))
      const changed = [...new Set([...actual.keys(), ...expectedMap.keys()])].filter(key => actual.get(key) !== expectedMap.get(key))
      log({stage: 'inventory', status: 'failed', differences: changed.slice(0, 20), total: changed.length})
      throw new Error(`DMG application differs from signed source: expected=${expected.sha256}/${expected.files} actual=${members.sha256}/${members.files}`)
    }
    log({stage: 'inventory', status: 'passed', ...members})
    checked = await verifyApplication(application, frozen, true)
    if (!checked.signature_valid || checked.package_check?.ok !== true) throw new Error('mounted DMG signature or startup verification failed')
    log({stage: 'application', status: 'passed'})
  } catch (error) {
    failure = error
    log({stage: 'verification', status: 'failed', error: error.message, code: error.code, exit_code: error.status, signal: error.signal, pid: error.pid})
  } finally {
    // Even a failed attach may have mounted the image before returning an error.
    if (mounted || fs.readdirSync(directory).length > 0) {
      try {
        command(['detach', directory])
        log({stage: 'detach', status: 'passed'})
      } catch (error) {
        log({stage: 'detach', status: 'failed', mountpoint: directory, error: error.message, code: error.code, exit_code: error.status, signal: error.signal})
        // Observation only: never kill a process or force-unmount a busy volume.
        try { log({stage: 'mount-users', ...diagnose(directory)}) }
        catch (diagnosticError) { log({stage: 'mount-users', error: diagnosticError.message}) }
        failure = failure ? new AggregateError([failure, error], 'DMG verification and detach failed') : error
        mounted = true
        throw failure
      }
    }
    fs.rmdirSync(directory)
  }
  if (failure) throw failure
  return {checked, installed_check: {schema: 1, status: 'passed', source: 'mounted-dmg', inventory: members, signature_valid: true, package_check: checked.package_check, detached: true}}
}

module.exports = {inventory, verifyImage}
