// Own the complete installer invocation, including exit validation and evidence.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { timed } = require('../../../../scripts/shared/timing.cjs')
const { protectWindowsVerificationDirectory } = require('./verification-directory.cjs')

const DIAGNOSTIC_TAIL_BYTES = 16 * 1024
const ENGINE_LOG_BYTES = 4 * 1024 * 1024
const DIAGNOSTICS_DIRECTORY = 'installer-diagnostics'
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const SECRET_NAME = /token|password|passwd|secret|credential|authorization|private.?key|access.?key|sign.?key/i

function redact(value, environment) {
  let text = String(value)
  for (const [name, secret] of Object.entries(environment)) {
    if (SECRET_NAME.test(name) && typeof secret === 'string' && secret.length >= 4)
      text = text.split(secret).join('[REDACTED]')
  }
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(https?:\/\/[^\s?"<>]+)\?[^\s"<>]*/gi, '$1?[REDACTED QUERY]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [REDACTED]')
    .replace(/((?:token|password|passwd|secret|credential|authorization|private[_-]?key|access[_-]?key|signature)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[REDACTED]')
}

function engineEvidence(filename) {
  if (!filename) return null
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('not a regular log'), { code: 'INVALID_LOG' })
    const fd = fs.openSync(filename, 'r')
    try {
      const bytes = Buffer.alloc(Math.min(stat.size, ENGINE_LOG_BYTES))
      const read = fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, stat.size - bytes.length))
      return { path: filename, bytes: stat.size, truncated: stat.size > bytes.length, text: bytes.subarray(0, read).toString('utf8') }
    } finally { fs.closeSync(fd) }
  } catch (error) { return { path: filename, error: error.code || 'READ_FAILED', text: '' } }
}

function diagnostic(record) {
  // JSON escaping prevents multiline output/control characters forging CI records.
  console.log(`[installer-diagnostic] ${JSON.stringify(record)}`)
}

function failureOutput(evidence, engine, environment) {
  diagnostic({ engine, event: 'failed', status: evidence.status, signal: evidence.signal,
    error: evidence.error?.code || null, nativeLogError: evidence.engineLog?.error || null,
    ...(evidence.retirement ? { retirement: evidence.retirement } : {}) })
  for (const [stream, value] of Object.entries({ stdout: evidence.stdout, stderr: evidence.stderr,
    error: evidence.error?.message || '', native: evidence.engineLog?.text || '' })) {
    const safe = Buffer.from(redact(value, environment))
    if (!safe.length) continue
    let start = Math.max(0, safe.length - DIAGNOSTIC_TAIL_BYTES)
    while (start < safe.length && (safe[start] & 0xc0) === 0x80) start++
    diagnostic({ engine, stream, truncated: safe.length > DIAGNOSTIC_TAIL_BYTES || (stream === 'native' && evidence.engineLog?.truncated) || false,
      text: safe.subarray(start).toString('utf8') })
  }
}

function retainFailure(evidence, log, environment) {
  const cache = environment.SCHOLARSEED_BUILD_CACHE_ROOT
  const root = environment.SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT ||
    (cache && path.join(path.dirname(cache), DIAGNOSTICS_DIRECTORY))
  if (!root) { diagnostic({ event: 'retention-unconfigured', log }); return }
  let directory
  try {
    if (!path.isAbsolute(root)) throw Object.assign(new Error('diagnostics root must be absolute'), { code: 'INVALID_ROOT' })
    fs.mkdirSync(root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    directory = fs.mkdtempSync(path.join(root, 'failure-'))
    if (process.platform === 'win32') protectWindowsVerificationDirectory(directory)
    else fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE)
    const retained = path.join(directory, path.basename(log))
    fs.writeFileSync(retained, JSON.stringify(evidence, null, 2) + '\n', { mode: PRIVATE_FILE_MODE, flag: 'wx' })
    diagnostic({ event: 'retained', path: retained, nativeLogTruncated: evidence.engineLog?.truncated || false })
  } catch (error) {
    // A failed archival write must never replace the installer's original failure.
    diagnostic({ event: 'retention-failed', code: error.code || 'WRITE_FAILED', directory })
  }
}

function recordInstallerFailure(evidence, log, environment) {
  // Retirement can fail after the launcher returned zero. Persist that later
  // verdict before the distribution wrapper removes its verification sandbox.
  const safe = { ...evidence,
    stdout: redact(evidence.stdout || '', environment),
    stderr: redact(evidence.stderr || '', environment),
    error: evidence.error && { ...evidence.error, message: redact(evidence.error.message || '', environment) },
    engineLog: evidence.engineLog && { ...evidence.engineLog, text: redact(evidence.engineLog.text || '', environment) },
  }
  try { fs.writeFileSync(log, JSON.stringify(safe, null, 2) + '\n', { mode: PRIVATE_FILE_MODE }) }
  catch (error) { diagnostic({ event: 'evidence-write-failed', code: error.code || 'WRITE_FAILED' }) }
  failureOutput(safe, evidence.engine, environment)
  retainFailure(safe, log, environment)
}

function runInstaller(installer, args, options, log, engine = 'NSIS', { nativeLog = false, operation = 'install' } = {}) {
  return timed(`verification.${engine.toLowerCase()}-${operation}`, () => {
    const environment = options.env || process.env
    // A fresh path allows acceptance retries without overwriting/reading old logs.
    const engineLog = nativeLog ? `${log}.${randomUUID()}.engine.log` : null
    const result = spawnSync(installer, nativeLog ? [...args, '--log', engineLog] : args, { ...options, encoding: 'utf8' })
    const evidence = {
      schema: 1,
      engine,
      recordedAt: new Date().toISOString(),
      sourceLog: log,
      status: result.status,
      signal: result.signal,
      error: result.error ? { code: result.error.code, message: result.error.message } : null,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      engineLog: engineEvidence(engineLog),
    }
    const failed = Boolean(result.error || result.status !== 0)
    let writeError
    try { fs.writeFileSync(log, JSON.stringify(evidence, null, 2) + '\n', { mode: PRIVATE_FILE_MODE }) }
    catch (error) { writeError = error; diagnostic({ event: 'evidence-write-failed', code: error.code || 'WRITE_FAILED' }) }
    for (const line of evidence.stdout.split(/\r?\n/)) {
      if (/^\[nsis\] [a-z0-9_.= -]+$/.test(line)) console.log(redact(line, environment))
    }
    if (failed) {
      failureOutput(evidence, engine, environment)
      retainFailure(evidence, log, environment)
      throw new Error(`${engine} installation failed: ${result.error?.code || result.status}; signal=${result.signal}; log: ${log}`)
    }
    if (writeError) throw writeError
    console.log(`[package] ${engine} ${operation === 'install' ? 'installation' : operation} passed; log: ${log}`)
    return evidence
  })
}

module.exports = { runInstaller, engineEvidence, recordInstallerFailure }
