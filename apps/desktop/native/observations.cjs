const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const SCHEMA_VERSION = 1
const PRIVATE_MODE = 0o600
const HASH_CHUNK_BYTES = 64 * 1024
const NANOSECONDS_PER_MILLISECOND = 1_000_000
const ERROR_FIELDS = Object.freeze(['name', 'message', 'code', 'errno', 'syscall', 'path', 'spawnargs'])

function errorFields(error) {
  if (!error) return null
  return Object.fromEntries(
    ERROR_FIELDS.filter((field) => error[field] !== undefined).map((field) => [field, error[field]])
  )
}

function statFields(info) {
  return {
    device: String(info.dev),
    inode: String(info.ino),
    mode: Number(info.mode),
    uid: Number(info.uid),
    gid: Number(info.gid),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  }
}

function executableSnapshot(command) {
  const snapshot = { path: command }
  let descriptor
  try {
    if (!path.isAbsolute(command))
      throw new TypeError('executable identity requires an absolute command path')
    descriptor = fs.openSync(command, 'r')
    const before = fs.fstatSync(descriptor, { bigint: true })
    if (!before.isFile()) throw new TypeError('executable identity requires a regular file')
    snapshot.stat = statFields(before)
    const digest = createHash('sha256')
    const buffer = Buffer.alloc(HASH_CHUNK_BYTES)
    let length
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) !== 0)
      digest.update(buffer.subarray(0, length))
    snapshot.sha256 = digest.digest('hex')
    snapshot.stableDuringRead = JSON.stringify(snapshot.stat) ===
      JSON.stringify(statFields(fs.fstatSync(descriptor, { bigint: true })))
  } catch (error) {
    snapshot.error = errorFields(error)
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch (error) {
        snapshot.closeError = errorFields(error)
      }
    }
  }
  return snapshot
}

function observeSpawn(command, args, options, filename) {
  const descriptor = fs.openSync(filename, 'wx', PRIVATE_MODE)
  let result, observation
  try {
    const before = executableSnapshot(command)
    const calledAt = new Date().toISOString()
    const started = process.hrtime.bigint()
    result = spawnSync(command, args, options)
    const elapsed = process.hrtime.bigint() - started
    const returnedAt = new Date().toISOString()
    const parentUid = process.getuid?.() ?? null
    observation = {
      schema: SCHEMA_VERSION,
      command,
      args: [...args],
      cwd: path.resolve(options.cwd || process.cwd()),
      timing: {
        calledAt,
        returnedAt,
        elapsedMs: Number(elapsed) / NANOSECONDS_PER_MILLISECOND,
        basis: 'spawnSync-call-window-not-termination-time',
      },
      process: {
        pid: result.pid ?? null,
        parentPid: process.pid,
        parentUid,
        requestedUid: options.uid ?? parentUid,
        basis: 'spawn-result-and-caller-not-post-exec-kernel-snapshot',
      },
      result: {
        status: result.status,
        signal: result.signal,
        error: errorFields(result.error),
      },
      executable: { before, after: executableSnapshot(command) },
      identityBasis: 'path-snapshots-not-executed-image-attestation',
      evidence: {
        path: filename,
        basis: 'serialized-errors-are-not-a-write-flush-close-receipt;use-returned-observation',
        errors: [],
      },
    }
    let operation = 'write'
    try {
      fs.writeFileSync(descriptor, JSON.stringify(observation, null, 2) + '\n')
      operation = 'flush'
      fs.fsyncSync(descriptor)
    } catch (error) {
      observation.evidence.errors.push({ operation, error: errorFields(error) })
    }
  } finally {
    try {
      fs.closeSync(descriptor)
    } catch (error) {
      if (!observation) throw error
      observation.evidence.errors.push({ operation: 'close', error: errorFields(error) })
    }
  }
  result.observation = observation
  return result
}

module.exports = { observeSpawn }
