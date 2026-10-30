const fs = require('node:fs')
const path = require('node:path')

const EXECUTABLE_DIRECTORY = 'bin'
const LINK_TYPE_FILE = 'file'
const STATE_MISSING = 'missing'
const STATE_OWNED = 'owned'
const STATE_CONFLICT = 'conflict'

function lstat(filename) {
  try { return fs.lstatSync(filename) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

function executableRoot(repo, venv, names) {
  const root = fs.realpathSync(repo)
  const relative = path.relative(path.resolve(repo), path.resolve(repo, venv))
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('venv must belong to this worktree')
  }
  const environment = path.resolve(root, relative)
  let ancestor = environment
  while (ancestor !== root) {
    const stat = lstat(ancestor)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('venv has an unsafe ancestor')
    ancestor = path.dirname(ancestor)
  }
  for (const name of names) {
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) throw new Error('invalid command name')
  }
  const executables = path.join(environment, EXECUTABLE_DIRECTORY)
  const stat = lstat(executables)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('venv executable directory is unsafe')
  return executables
}

function binDirectory(candidate, create) {
  const filename = path.resolve(candidate)
  const before = lstat(filename)
  if (!before && create) fs.mkdirSync(filename, { recursive: true })
  const stat = lstat(filename)
  if (!stat) return null
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe bin directory: ${filename}`)
  return fs.realpathSync(filename)
}

function inspect(directory, source, name) {
  const filename = path.join(directory, name)
  const stat = lstat(filename)
  if (!stat) return { filename, source, state: STATE_MISSING }
  let owned = false
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(filename)
    if (target.split(path.sep).includes('..')) return { filename, source, stat, state: STATE_CONFLICT }
    const resolved = path.resolve(directory, target)
    let ancestor = path.dirname(resolved)
    const missing = [path.basename(resolved)]
    while (!lstat(ancestor)) {
      missing.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
    try { owned = path.join(fs.realpathSync.native(ancestor), ...missing) === source } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'ELOOP') throw error
    }
  }
  return { filename, source, stat, state: owned ? STATE_OWNED : STATE_CONFLICT }
}

function installCommandLinks(repo, venv, candidates, names) {
  const executables = executableRoot(repo, venv, names)
  const failures = []
  let directory
  for (const candidate of candidates) {
    try {
      const selected = binDirectory(candidate, true)
      fs.accessSync(selected, fs.constants.W_OK)
      directory = selected
      break
    } catch (error) { failures.push(`${candidate}: ${error.message}`) }
  }
  if (!directory) throw new Error(`no writable bin directory found: ${failures.join('; ')}`)
  const entries = names.map(name => inspect(directory, path.join(executables, name), name))
  const conflicts = entries.filter(entry => entry.state === STATE_CONFLICT)
  if (conflicts.length) throw new Error(`conflict: ${conflicts.map(entry => entry.filename).join(', ')}`)
  const result = { created: [], existing: [], skipped: [] }
  const creatable = []
  for (const entry of entries) {
    const source = lstat(entry.source)
    if (!source) { result.skipped.push(entry.source); continue }
    if (!fs.statSync(entry.source).isFile() || !fs.realpathSync.native(entry.source).startsWith(`${executables}${path.sep}`)) {
      throw new Error(`conflict: executable is not owned by venv: ${entry.source}`)
    }
    if (entry.state === STATE_OWNED) { result.existing.push(entry.filename); continue }
    creatable.push(entry)
  }
  for (const entry of creatable) {
    fs.symlinkSync(entry.source, entry.filename, LINK_TYPE_FILE)
    result.created.push(entry.filename)
  }
  return result
}

function uninstallCommandLinks(repo, venv, candidates, names) {
  const executables = executableRoot(repo, venv, names)
  const result = { removed: [], unowned: [], unavailable: [] }
  const entries = []
  const seen = new Set()
  for (const candidate of candidates) {
    let directory
    try { directory = binDirectory(candidate, false) } catch (error) {
      result.unavailable.push(`${candidate}: ${error.message}`)
      continue
    }
    if (!directory) continue
    if (seen.has(directory)) continue
    seen.add(directory)
    for (const name of names) entries.push(inspect(directory, path.join(executables, name), name))
  }
  for (const entry of entries) {
    if (entry.state === STATE_CONFLICT) { result.unowned.push(entry.filename); continue }
    if (entry.state !== STATE_OWNED) continue
    const current = inspect(path.dirname(entry.filename), entry.source, path.basename(entry.filename))
    if (current.state !== STATE_OWNED || current.stat.ino !== entry.stat.ino || current.stat.dev !== entry.stat.dev) {
      throw new Error(`conflict: command link changed: ${entry.filename}`)
    }
    fs.unlinkSync(entry.filename)
    result.removed.push(entry.filename)
  }
  return result
}

module.exports = { installCommandLinks, uninstallCommandLinks }
