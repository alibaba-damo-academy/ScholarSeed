// Build-owned private state, shared by component caching and acceptance checkpoints.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { assertWindowsPermissions, protectWindowsDirectory: protectWindowsVerificationDirectory } = require('../../../../scripts/shared/permissions.cjs')
const SHA256 = /^[a-f0-9]{64}$/
const PRIVATE_MODE = 0o700
function assertPrivateFile(filename) {
  noLinks(path.dirname(filename))
  const stat=regular(filename)
  if(process.platform==='win32') assertWindowsPermissions(filename)
  else if(stat.uid!==process.getuid() || stat.mode & 0o022) throw new Error('build state file is writable by another user')
}


function regular(filename, directory = false) {
  const s = fs.lstatSync(filename)
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (!directory && s.nlink !== 1))
    throw new Error(`invalid build state object: ${filename}`)
  return s
}
function noLinks(filename) {
  let current = path.resolve(filename)
  for (;;) {
    regular(current, true)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
function assertPrivateDirectory(directory) {
  noLinks(directory)
  if (process.platform === 'win32') {
    assertWindowsPermissions(directory)
  } else {
    const stat = regular(directory, true)
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('build state directory is not private')
  }
}
function ensurePrivateDirectory(directory) {
  const resolved = path.resolve(directory)
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true, mode: PRIVATE_MODE })
    if (process.platform === 'win32') protectWindowsVerificationDirectory(resolved)
  }
  assertPrivateDirectory(resolved)
  return resolved
}
function hashFile(filename) {
  regular(filename)
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filename, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)) }
  finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
function identity(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function inside(root, filename) {
  const rel = path.relative(path.resolve(root), path.resolve(filename))
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('build state path escapes its root')
  return rel
}
function inventory(directory) {
  noLinks(directory)
  const files = []
  function scan(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file)
      if (stat.isDirectory() && !stat.isSymbolicLink()) scan(file)
      else files.push({ path: inside(directory, file).split(path.sep).join('/'), bytes: regular(file).size, sha256: hashFile(file) })
    }
  }
  scan(directory)
  return files
}
module.exports = { SHA256, regular, noLinks, assertPrivateFile, ensurePrivateDirectory, assertPrivateDirectory, hashFile, identity, inside, inventory }
