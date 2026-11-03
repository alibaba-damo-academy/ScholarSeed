#!/usr/bin/env node
// Velopack handoff contract gate: verify and isolate the exact compiler archive.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '../..')
const MODULE = path.join(REPO, 'apps', 'desktop', 'updater')
const { timed, timedAsync } = require('../shared/timing.cjs')
const manifest = require('../../apps/desktop/updater/toolchain.json')

function run(executable, args, environment, capture = false) {
  const result = spawnSync(executable, args, {
    cwd: MODULE,
    env: environment,
    windowsHide: true,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error || result.status !== 0) {
    throw new Error(`native updater gate failed: ${result.error || result.stderr || result.status}`)
  }
  return capture ? result.stdout.trim() : null
}

async function main(argv, session = createSession(), buildEnvironment = process.env) {
  const options = new Map()
  const allowed = new Set(['--archive'])
  for (let i = 0; i < argv.length; i += 2) {
    const [key, value] = argv.slice(i, i + 2)
    if (!allowed.has(key) || !value || value.startsWith('--') || options.has(key)) {
      throw new Error(
        'usage: pnpm ops ci test --scope desktop --suite updater --archive <reviewed Go archive>'
      )
    }
    options.set(key, path.resolve(value))
  }
  if (!options.has('--archive')) throw new Error('--archive is required')
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const entry = manifest.archives.find((item) => item.os === platform && item.arch === arch)
  if (!entry) throw new Error(`unsupported native updater host: ${platform}/${arch}`)
  const archive = options.get('--archive')
  try {
    await prepareSession(session, archive, entry, platform, arch, buildEnvironment)
  } finally {
    if (session.standalone) closeSession(session)
  }
}

function createSession(standalone = true) { return { standalone, ready: false } }
function closeSession(session) {
  session.ready = false
  if (session.temporary) timed('go.cleanup', () => fs.rmSync(session.temporary, { recursive: true, force: true }))
  delete session.temporary
}
async function prepareSession(session, archive, entry, platform, arch, buildEnvironment) {
  if (session.ready) {
    if (session.archive !== archive || session.sha256 !== entry.sha256) throw new Error('Go session input changed')
    console.log('[updater] reusing prepared compiler and passed gates for this build')
    return
  }
  try {
    await timedAsync('go.archive-verify', async () => {
      if (fs.statSync(archive).size !== entry.size) throw new Error('Go archive size mismatch')
      const hash = crypto.createHash('sha256')
      for await (const chunk of fs.createReadStream(archive)) hash.update(chunk)
      if (hash.digest('hex') !== entry.sha256) throw new Error('Go archive SHA256 mismatch')
    })
    const { createPackageCheckDirectory } = require('../../apps/desktop/scripts/cd/verification-directory.cjs')
    const temporary = createPackageCheckDirectory({ platform: process.platform, repo: REPO })
    session.temporary = temporary
    const tar = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
    timed('go.extract', () => run(tar, ['-xf', archive, '-C', temporary], buildEnvironment))
    const goRoot = path.join(temporary, 'go')
    const go = path.join(goRoot, 'bin', process.platform === 'win32' ? 'go.exe' : 'go')
    const environment = Object.fromEntries(Object.entries(buildEnvironment).filter(
      ([key]) => !key.toUpperCase().startsWith('GO') && !key.toUpperCase().startsWith('CGO')
    ))
    const configured = buildEnvironment.SCHOLARSEED_BUILD_CACHE_ROOT
    const cache = configured ? require('../../apps/desktop/scripts/shared/build-state.cjs')
      .ensurePrivateDirectory(path.join(configured, 'go', entry.sha256)) : temporary
    const privateDir = (name) => configured ? require('../../apps/desktop/scripts/shared/build-state.cjs')
      .ensurePrivateDirectory(path.join(cache, name)) : path.join(cache, name)
    Object.assign(environment, {
      TMPDIR: temporary, TEMP: temporary, TMP: temporary,
      GOROOT: goRoot, GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GO111MODULE: 'on',
      GOFLAGS: '', GOPROXY: 'off', GOSUMDB: 'off', CGO_ENABLED: '0',
      GOPATH: path.join(temporary, 'path'), GOCACHE: privateDir('cache'), GOMODCACHE: privateDir('modules')
    })
    delete environment.SCHOLARSEED_UPDATER_RELEASE_RESULT
    const actual = run(go, ['version'], environment, true)
    if (actual !== `go version ${manifest.version} ${platform}/${arch}`) throw new Error(`unexpected compiler: ${actual}`)
    console.log(`[updater] verified ${entry.filename} sha256=${entry.sha256}`)
    timed('go.vet', () => run(go, ['vet', './...'], environment))
    timed('go.test', () => run(go, ['test', '-count=1', '-timeout=5m', '-v', './...'], environment))
    Object.assign(session, { temporary, goRoot, go, environment, archive, sha256: entry.sha256, ready: true })
  } catch (error) { closeSession(session); throw error }
}

module.exports = { main, createSession, closeSession }

if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
