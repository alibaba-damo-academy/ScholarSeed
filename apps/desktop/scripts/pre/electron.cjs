const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { execFileSync, spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const state = require('../shared/build-state.cjs')
const { artifactCache } = require('../../../../scripts/shared/artifacts.cjs')

const ELECTRON_PACKAGE = require.resolve('electron/package.json')
const electronRequire = createRequire(ELECTRON_PACKAGE)
const { downloadArtifact } = electronRequire('@electron/get')
const MACOS = 'darwin'
const DIST = 'dist'
const RECEIPT = 'receipt.json'
const VERSION = 'version'
const PATH_FILE = 'path.txt'
const TYPE_FILE = 'electron.d.ts'
const EXECUTABLE = 'Electron.app/Contents/MacOS/Electron'
const PLIST = 'Electron.app/Contents/Info.plist'
const PRIVATE_MODE = 0o700
const PERMISSION_MASK = 0o777
const CACHE_SCHEMA = 1
const LOCK_TIMEOUT_MS = 120000
const LOCK_POLL_MS = 100
const HASH_BUFFER_BYTES = 1024 * 1024
const COPY_COMMAND = '/bin/cp'
const DISK_COMMAND = '/usr/sbin/diskutil'
const PLIST_COMMAND = '/usr/bin/plutil'
const SPACE_COMMAND = '/bin/df'
const EXTRACT_COMMAND = '/usr/bin/ditto'
const APFS_TYPE = 'apfs'
const CLONE_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL'])
const OVERRIDES = ['ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_INSTALL_ARCH', 'ELECTRON_INSTALL_PLATFORM',
  'npm_config_arch', 'npm_config_platform', 'force_no_cache', 'electron_use_remote_checksums',
  'npm_config_electron_use_remote_checksums']

function usesClones(platform, environment) {
  return platform === MACOS && !OVERRIDES.some(name => environment[name])
}

function inventory(directory) {
  const entries = []
  function scan(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const filename = path.join(current, name)
      const info = fs.lstatSync(filename)
      const relative = path.relative(directory, filename)
      if (info.isSymbolicLink()) {
        const target = fs.readlinkSync(filename)
        const resolved = path.relative(directory, path.resolve(path.dirname(filename), target))
        if (path.isAbsolute(target) || resolved === '..' || resolved.startsWith(`..${path.sep}`)) {
          throw new Error(`Electron symlink escapes distribution: ${relative}`)
        }
        entries.push({ path: relative, target })
      } else if (info.isDirectory()) {
        entries.push({ path: relative, mode: info.mode & PERMISSION_MASK, directory: true })
        scan(filename)
      } else {
        state.regular(filename)
        entries.push({ path: relative, mode: info.mode & PERMISSION_MASK, sha256: state.hashFile(filename) })
      }
    }
  }
  state.regular(directory, true)
  scan(directory)
  return entries
}

function verify(directory, expected) {
  if (JSON.stringify(inventory(directory)) !== JSON.stringify(expected)) {
    throw new Error(`Electron inventory mismatch: ${directory}`)
  }
}

function archiveDigest(filename) {
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Electron archive is not a regular file')
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES)
    let bytes
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes))
    return hash.digest('hex')
  } finally { fs.closeSync(descriptor) }
}

function cloneDistribution(source, destination) {
  if (fs.existsSync(destination) || fs.lstatSync(path.dirname(destination), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Electron clone destination exists or is a symlink: ${destination}`)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const usage = execFileSync(SPACE_COMMAND, ['-P', source], { encoding: 'utf8' }).trim().split('\n').at(-1)
  const mount = /^\S+\s+\d+\s+\d+\s+\d+\s+\S+\s+(.+)$/.exec(usage)?.[1]
  if (!mount) throw new Error('Cannot identify Electron distribution volume')
  const volume = execFileSync(DISK_COMMAND, ['info', '-plist', mount])
  const filesystem = execFileSync(PLIST_COMMAND, ['-extract', 'FilesystemType', 'raw', '-o', '-', '-'], { input: volume, encoding: 'utf8' }).trim()
  if (filesystem !== APFS_TYPE || fs.statSync(source).dev !== fs.statSync(path.dirname(destination)).dev) {
    const error = new Error('Electron clones require the same APFS volume')
    error.code = 'ENOTSUP'
    throw error
  }
  execFileSync(COPY_COMMAND, ['-cRpP', source, destination], { stdio: 'pipe' })
}

async function withLock(directory, action) {
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(directory, { mode: PRIVATE_MODE })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      state.assertPrivateDirectory(directory)
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Electron cache lock timed out; inspect owner before removing: ${directory}`)
      await delay(LOCK_POLL_MS)
    }
  }
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname() }))
  try { return await action() } finally { fs.rmSync(directory, { recursive: true }) }
}

async function cachedDistribution(root, identity, checksums) {
  const key = state.identity(identity)
  const directory = path.join(root, key)
  return withLock(path.join(root, `${key}.lock`), async () => {
    if (fs.existsSync(directory)) {
      state.assertPrivateDirectory(directory)
      state.assertPrivateFile(path.join(directory, RECEIPT))
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, RECEIPT), 'utf8'))
      if (JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw new Error('Electron cache identity mismatch')
      verify(path.join(directory, DIST), receipt.files)
      return { directory, receipt }
    }
    const temporary = fs.mkdtempSync(path.join(root, `${key}.prepare-`))
    try {
      const zip = await downloadArtifact({
        version: identity.version, artifactName: 'electron', platform: MACOS, arch: identity.arch,
        checksums, cacheRoot: process.env.electron_config_cache,
      })
      if (archiveDigest(zip) !== identity.sha256) throw new Error('Electron archive checksum mismatch')
      const dist = path.join(temporary, DIST)
      fs.mkdirSync(dist)
      execFileSync(EXTRACT_COMMAND, ['-x', '-k', zip, dist], { stdio: 'pipe' })
      fs.rmSync(path.join(dist, TYPE_FILE), { force: true })
      if (fs.readFileSync(path.join(dist, VERSION), 'utf8').trim().replace(/^v/, '') !== identity.version) {
        throw new Error('Electron extracted version mismatch')
      }
      fs.accessSync(path.join(dist, EXECUTABLE), fs.constants.X_OK)
      const receipt = { identity, files: inventory(dist) }
      fs.writeFileSync(path.join(temporary, RECEIPT), JSON.stringify(receipt))
      fs.renameSync(temporary, directory)
      console.log(`[electron-cache] published verified ${identity.version} ${MACOS}-${identity.arch}`)
      return { directory, receipt }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  })
}

function assertIdle(directory) {
  const executable = path.join(directory, DIST, EXECUTABLE)
  if (!fs.existsSync(executable)) return
  const result = spawnSync('/usr/sbin/lsof', ['-t', '--', executable], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 1 || result.stdout.trim()) {
    throw new Error(`Electron distribution is in use or cannot be checked: ${executable} ${result.stderr || result.stdout}`)
  }
}

function upstream(directory) {
  execFileSync(process.execPath, [path.join(directory, 'install.js')], { stdio: 'inherit' })
}

async function prepare(directory = path.dirname(ELECTRON_PACKAGE), refresh = false) {
  directory = fs.realpathSync(directory)
  if (!usesClones(process.platform, process.env)) return upstream(directory)
  const version = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version
  const checksums = JSON.parse(fs.readFileSync(path.join(directory, 'checksums.json'), 'utf8'))
  const sha256 = checksums[`electron-v${version}-${MACOS}-${process.arch}.zip`]
  if (!state.SHA256.test(sha256 || '')) throw new Error('Electron archive checksum is unavailable')
  const dist = path.join(directory, DIST)
  if (!refresh && fs.existsSync(path.join(dist, EXECUTABLE)) &&
      fs.readFileSync(path.join(dist, VERSION), 'utf8').trim().replace(/^v/, '') === version &&
      fs.readFileSync(path.join(directory, PATH_FILE), 'utf8') === EXECUTABLE) return
  state.noLinks(directory)
  assertIdle(directory)
  const root = state.ensurePrivateDirectory(path.join(artifactCache(), 'electron-distributions'))
  const identity = { schema: CACHE_SCHEMA, version, platform: MACOS, arch: process.arch, sha256 }
  const cached = await cachedDistribution(root, identity, checksums)
  return withLock(path.join(directory, '.scholarseed-electron.lock'), async () => {
    assertIdle(directory)
    const temporary = fs.mkdtempSync(path.join(directory, '.electron-'))
    const staged = path.join(temporary, DIST)
    const previous = path.join(temporary, 'previous')
    try {
      try { cloneDistribution(path.join(cached.directory, DIST), staged) } catch (error) {
        if (!CLONE_UNSUPPORTED.has(error.code)) throw error
        console.warn(`[electron-cache] clone unavailable (${error.code}); retaining upstream independent installation`)
        return upstream(directory)
      }
      verify(staged, cached.receipt.files)
      assertIdle(directory)
      if (fs.existsSync(dist)) {
        state.regular(dist, true)
        const plist = path.join(dist, PLIST)
        if (fs.readFileSync(path.join(dist, VERSION), 'utf8').trim().replace(/^v/, '') === version && fs.existsSync(plist)) {
          state.assertPrivateFile(plist)
          fs.copyFileSync(plist, path.join(staged, PLIST))
        }
        fs.renameSync(dist, previous)
      }
      try { fs.renameSync(staged, dist) } catch (error) {
        if (fs.existsSync(previous)) fs.renameSync(previous, dist)
        throw error
      }
      fs.writeFileSync(path.join(directory, PATH_FILE), EXECUTABLE)
      console.log(`[electron-cache] cloned ${version} ${MACOS}-${process.arch} to ${dist}`)
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  })
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const refresh = args.includes('--refresh')
  const directory = args.find(value => value !== '--refresh')
  prepare(directory, refresh).catch(error => { console.error(error); process.exitCode = 1 })
}

module.exports = { inventory, verify, cloneDistribution, usesClones, prepare, archiveDigest, withLock }
