const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const SCHEMA_VERSION = 1
const COMMIT = /^[a-f0-9]{40}$/
const FINGERPRINT = /^[a-f0-9]{64}$/
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const GIT_TIMEOUT_MS = 30_000
const SOURCE_READ_ATTEMPTS = 3
const DEVELOPMENT_POLICY = 'development-content-v2'

function git(repo, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
}

function digest(parts) {
  const hash = crypto.createHash('sha256')
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
    hash.update(`${bytes.length}:`)
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function gitState(repo) {
  const commit = git(repo, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim()
  if (!COMMIT.test(commit)) throw new Error('Source snapshot requires an existing source commit')
  const head = git(repo, ['rev-parse', '--symbolic-full-name', 'HEAD']).toString('utf8').trim()
  const index = git(repo, ['ls-files', '--stage', '-z'])
  if (index.toString('utf8').split('\0').some(record => record.startsWith('160000 '))) {
    throw new Error('Source snapshots do not support gitlinks or submodules')
  }
  const flags = git(repo, ['ls-files', '-v', '-z'])
  const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const paths = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  const indexFingerprint = digest([index, flags])
  const completeTracking = flags.toString('utf8').split('\0').filter(Boolean).every(record => record.startsWith('H '))
  return { commit, head, indexFingerprint, status, paths, completeTracking,
    identity: digest([commit, head, index, flags, status, paths]) }
}

function metadata(info) {
  const kind = info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'unsupported'
  return { kind, mode: info.mode & 0o7777 }
}

function unchangedReadMetadata(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode &&
    before.size === after.size && before.mtimeMs === after.mtimeMs
}

function unchangedMetadata(before, after) {
  return unchangedReadMetadata(before, after) && before.ctimeMs === after.ctimeMs
}

function readSourceFile(repo, name, filename, initial) {
  let previousDigest
  for (let attempt = 0; attempt < SOURCE_READ_ATTEMPTS; attempt += 1) {
    const before = attempt === 0 ? initial : fs.lstatSync(filename)
    if (!unchangedReadMetadata(initial, before)) {
      throw new Error(`Source changed while fingerprinting: ${JSON.stringify(name)}`)
    }
    const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      const opened = fs.fstatSync(descriptor)
      if (!unchangedReadMetadata(initial, opened) || !inside(repo, fs.realpathSync.native(path.dirname(filename)))) {
        throw new Error(`Source changed or linked ancestors appeared while fingerprinting: ${JSON.stringify(name)}`)
      }
      const content = digest([fs.readFileSync(descriptor)])
      const after = fs.fstatSync(descriptor)
      const leaf = fs.lstatSync(filename)
      if (!unchangedReadMetadata(initial, after) || !unchangedReadMetadata(initial, leaf)) {
        throw new Error(`Source changed while fingerprinting: ${JSON.stringify(name)}`)
      }
      if (previousDigest !== undefined && previousDigest !== content) {
        throw new Error(`Source bytes changed while fingerprinting: ${JSON.stringify(name)}`)
      }
      previousDigest = content
      if (unchangedMetadata(before, opened) && unchangedMetadata(opened, after) && unchangedMetadata(after, leaf)) {
        return { content, info: leaf }
      }
    } finally { fs.closeSync(descriptor) }
  }
  throw new Error(`Source metadata did not stabilize while fingerprinting after ${SOURCE_READ_ATTEMPTS} reads: ${JSON.stringify(name)}`)
}

function inside(repo, filename) {
  const relative = path.relative(repo, filename)
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

function inspectAncestors(repo, name, records) {
  const components = name.split('/')
  let directory = repo
  for (let index = 0; index < components.length - 1; index += 1) {
    directory = path.join(directory, components[index])
    let info
    try { info = fs.lstatSync(directory) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(repo, fs.realpathSync.native(directory))) {
      throw new Error('Source snapshot refuses linked or non-directory ancestors outside its source boundary')
    }
    records.set(path.relative(repo, directory), JSON.stringify(metadata(info)))
  }
  return true
}

function sourceFiles(repo, paths) {
  const names = [...new Set(paths.toString('utf8').split('\0').filter(Boolean))].sort()
  if (!Buffer.from(paths.toString('utf8')).equals(paths)) throw new Error('Source paths must have an unambiguous UTF-8 representation')
  const records = new Map()
  for (const name of names) {
    if (path.isAbsolute(name) || name.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('Source snapshot refuses an escaping path')
    }
    const filename = path.resolve(repo, name)
    if (!inside(repo, filename)) throw new Error('Source path is outside the repository')
    if (!inspectAncestors(repo, name, records)) { records.set(name, 'missing'); continue }
    let before
    try { before = fs.lstatSync(filename) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      records.set(name, 'missing')
      continue
    }
    const attributes = metadata(before)
    if (attributes.kind === 'unsupported') throw new Error('Unsupported source file type')
    let content = ''
    if (attributes.kind === 'symlink') content = digest([fs.readlinkSync(filename, { encoding: 'buffer' })])
    if (attributes.kind === 'file') {
      const observed = readSourceFile(repo, name, filename, before)
      content = observed.content
      before = observed.info
    }
    if (!unchangedMetadata(before, fs.lstatSync(filename))) throw new Error('Source changed while fingerprinting')
    inspectAncestors(repo, name, records)
    records.set(name, JSON.stringify({ ...attributes, content }))
  }
  return { fingerprint: digest([...records].sort(([left], [right]) => left.localeCompare(right)).flat()), files: names.length }
}

function capture(repo, development) {
  const start = gitState(repo)
  const files = sourceFiles(repo, start.paths)
  const end = gitState(repo)
  if (start.identity !== end.identity) throw new Error('Source index or path set changed while fingerprinting')
  return { schemaVersion: SCHEMA_VERSION, valid: true, commit: start.commit, head: start.head,
    indexFingerprint: start.indexFingerprint, fingerprint: digest([start.identity, files.fingerprint, ...(development ? [DEVELOPMENT_POLICY] : [])]),
    clean: start.status.length === 0 && start.completeTracking, files: files.files }
}

function validSnapshot(snapshot) {
  return snapshot?.schemaVersion === SCHEMA_VERSION && snapshot.valid === true && COMMIT.test(snapshot.commit || '') &&
    typeof snapshot.head === 'string' && snapshot.head.length > 0 && FINGERPRINT.test(snapshot.indexFingerprint || '') &&
    FINGERPRINT.test(snapshot.fingerprint || '') && typeof snapshot.clean === 'boolean' &&
    Number.isSafeInteger(snapshot.files) && snapshot.files >= 0
}

function sourceUnchanged(start, end) {
  return validSnapshot(start) && validSnapshot(end) && start.commit === end.commit && start.head === end.head &&
    start.indexFingerprint === end.indexFingerprint && start.fingerprint === end.fingerprint && start.clean === end.clean && start.files === end.files
}

function snapshot(directory, development) {
  const repo = fs.realpathSync.native(directory)
  const top = fs.realpathSync.native(git(repo, ['rev-parse', '--show-toplevel']).toString('utf8').trim())
  if (top !== repo) throw new Error('Source snapshot requires the repository root')
  const start = capture(repo, development)
  const end = capture(repo, development)
  if (!sourceUnchanged(start, end)) throw new Error('Source bytes changed while fingerprinting')
  return end
}

function sourceSnapshot(directory) {
  return snapshot(directory, false)
}

function developmentSourceSnapshot(directory) {
  return snapshot(directory, true)
}

module.exports = { sourceSnapshot, developmentSourceSnapshot, sourceUnchanged }
