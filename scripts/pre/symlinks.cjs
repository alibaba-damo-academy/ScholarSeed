#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const LINKS = ['.codex/skills', '.claude/skills', 'CLAUDE.md']
const SYMLINK_MODE = '120000'
const TEMP_PREFIX = '.symlink-repair-'
const LINK_TYPE_DIRECTORY = 'dir'
const LINK_TYPE_FILE = 'file'
function inspectLinks(repo, platform) {
  repo = fs.realpathSync(repo)
  return LINKS.map(link => {
    const filename = path.join(repo, link)
    let ancestor = path.dirname(filename)
    while (ancestor !== path.resolve(repo)) {
      const parentStat = fs.lstatSync(ancestor)
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error(`conflict: unsafe parent: ${link}`)
      ancestor = path.dirname(ancestor)
    }
    const entry = execFileSync('git', ['ls-files', '--stage', '--', link], { cwd: repo, encoding: 'utf8' }).trim()
    const match = entry.match(/^(\d+) ([a-f0-9]+) 0\t/)
    if (!match || match[1] !== SYMLINK_MODE) throw new Error(`conflict: Git symlink identity unavailable: ${link}`)
    const expected = execFileSync('git', ['cat-file', 'blob', match[2]], { cwd: repo })
    const target = expected.toString('utf8')
    const physicalTarget = path.resolve(path.dirname(filename), target)
    let owner
    try {
      owner = fs.lstatSync(physicalTarget)
      if (owner.isSymbolicLink() || fs.realpathSync(physicalTarget) !== physicalTarget) {
        return { link, filename, target, state: 'conflict' }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      return { link, filename, target, state: 'conflict' }
    }
    const validType = link === 'CLAUDE.md' ? owner.isFile() : owner.isDirectory()
    if (!validType) return { link, filename, target, state: 'conflict' }
    const type = owner.isDirectory() ? LINK_TYPE_DIRECTORY : LINK_TYPE_FILE
    let stat
    try { stat = fs.lstatSync(filename) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { link, filename, target, type, state: 'missing' }
    }
    if (stat.isSymbolicLink()) {
      const actual = fs.readlinkSync(filename)
      const accurate = actual === target && !(platform === 'win32' && path.isAbsolute(actual))
      return { link, filename, target, state: accurate ? 'valid' : 'conflict' }
    }
    const placeholder = stat.isFile() && fs.readFileSync(filename).equals(expected)
    return { link, filename, target, type, expected, stat, state: placeholder ? 'placeholder' : 'conflict' }
  })
}
function checkLinks(repo, platform = process.platform) {
  return inspectLinks(repo, platform).filter(entry => entry.state !== 'valid').map(({ link, state }) => ({ link, state }))
}
function repairLinks(repo, platform = process.platform) {
  const entries = inspectLinks(repo, platform)
  const conflicts = entries.filter(entry => entry.state === 'conflict')
  if (conflicts.length) throw new Error(`conflict: ${conflicts.map(entry => entry.link).join(', ')}`)
  let repaired = 0
  for (const entry of entries) {
    if (entry.state === 'valid') continue
    if (entry.state === 'placeholder') {
      const temporary = fs.mkdtempSync(path.join(path.dirname(entry.filename), TEMP_PREFIX))
      const replacement = path.join(temporary, path.basename(entry.filename))
      try {
        fs.symlinkSync(entry.target, replacement, entry.type)
        const current = fs.lstatSync(entry.filename)
        if (!current.isFile() || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino ||
            !fs.readFileSync(entry.filename).equals(entry.expected)) {
          throw new Error(`conflict: placeholder changed: ${entry.link}`)
        }
        fs.renameSync(replacement, entry.filename)
      } finally {
        if (fs.existsSync(temporary)) {
          try { fs.unlinkSync(replacement) } catch (error) { if (error.code !== 'ENOENT') throw error }
          fs.rmdirSync(temporary)
        }
      }
    } else fs.symlinkSync(entry.target, entry.filename, entry.type)
    repaired += 1
  }
  return repaired
}
if (require.main === module) {
  try {
    const command = process.argv[2]
    const repo = path.resolve(__dirname, '../..')
    if (command === 'repair') console.log(`repaired ${repairLinks(repo)} symlink(s)`)
    else if (command === 'check') {
      const problems = checkLinks(repo)
      if (problems.length) throw new Error(problems.map(problem => `${problem.link}: ${problem.state}`).join('\n'))
      console.log('symlinks OK')
    } else throw new Error('usage: symlinks.cjs check|repair')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
module.exports = { checkLinks, repairLinks }
