// A private, verified Go SDK session shared by Windows native build owners.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { ensureArtifact } = require('../../../../scripts/shared/artifacts.cjs')
const cache = require('./cache.cjs')
const toolchain = require('../../updater/toolchain.json')
const CLEANUP_RETRIES = 6
const CLEANUP_DELAY_MS = 200
const CLEANUP_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

async function cleanup(temporary) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(temporary, {recursive: true, force: true})
      return
    } catch (cause) {
      if (!CLEANUP_BUSY_CODES.has(cause.code) || attempt === CLEANUP_RETRIES) {
        const error = new Error(`native compiler cleanup failed after ${attempt + 1} attempt(s): ${temporary}: ${cause.message}`, {cause})
        error.code = cause.code
        error.path = temporary
        throw error
      }
      // Child commands have exited, but Windows may still deny deletion briefly.
      // Yield between attempts; persistent locks remain fatal (4.2s total delay).
      await delay(CLEANUP_DELAY_MS * (attempt + 1))
    }
  }
}

function run(executable, args, environment, cwd) {
  const result = spawnSync(executable, args, {cwd, env: environment, encoding: 'utf8', windowsHide: true,
    timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024})
  if (result.error || result.status !== 0) throw new Error(`native compiler failed: ${result.error || result.stderr || result.stdout || result.status}`)
  return result.stdout.trim()
}
async function withCompiler({runDirectory, goArchive, environment}, operation) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('native packaging requires Windows x64')
  const selected = toolchain.archives.find(item => item.os === 'windows' && item.arch === 'amd64')
  const archive = goArchive ? path.resolve(goArchive) : path.join(runDirectory, selected.filename)
  if (!goArchive) await ensureArtifact(archive, {url: selected.url, sha256: selected.sha256, bytes: selected.size}, {environment})
  if (fs.statSync(archive).size !== selected.size || crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== selected.sha256)
    throw new Error('native compiler archive differs from reviewed SDK')
  const temporary = fs.mkdtempSync(path.join(runDirectory, 'native-build-'))
  let operationFailed = false, operationError
  try {
    const tar = path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    const expanded = cache.expanded(archive, {sha256: selected.sha256, bytes: selected.size}, environment,
      directory => run(tar, ['-xf', archive, '-C', directory], environment))
    const goRoot = path.join(expanded, 'go'), go = path.join(goRoot, 'bin', 'go.exe')
    const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !name.toUpperCase().startsWith('GO') && !name.toUpperCase().startsWith('CGO')))
    Object.assign(env, {GOROOT: goRoot, GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GO111MODULE: 'on',
      GOFLAGS: '', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64',
      GOPATH: path.join(temporary, 'path'), GOCACHE: cache.goObjects(environment, selected.sha256), GOMODCACHE: path.join(temporary, 'modules'),
      TMPDIR: temporary, TEMP: temporary, TMP: temporary})
    if (run(go, ['version'], env) !== `go version ${toolchain.version} windows/amd64`) throw new Error('native compiler version differs')
    return await operation({temporary, goRoot, go, env, selected})
  } catch (error) {
    operationFailed = true
    operationError = error
    throw error
  } finally {
    try { await cleanup(temporary) }
    catch (error) {
      if (operationFailed) throw new AggregateError([operationError, error],
        `native compiler operation failed: ${operationError?.message || String(operationError)}; ${error.message}`,
        {cause: operationError})
      throw error
    }
  }
}
module.exports = {withCompiler, run}
