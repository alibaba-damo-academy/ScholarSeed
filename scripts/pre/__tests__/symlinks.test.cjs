const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { checkLinks, repairLinks } = require('../symlinks.cjs')

const entries = [['.codex/skills', '../.agents/skills'], ['.claude/skills', '../.agents/skills'], ['CLAUDE.md', 'AGENTS.md']]
function fixture(context) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', repo])
  fs.mkdirSync(path.join(repo, '.agents/skills'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'owner')
  for (const [name, target] of entries) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.symlinkSync(target, path.join(repo, name))
  }
  execFileSync('git', ['-C', repo, 'add', '.'])
  return repo
}
test('check is read-only; repair handles missing and exact placeholders idempotently', context => {
  const repo = fixture(context)
  const missing = path.join(repo, entries[0][0])
  const placeholder = path.join(repo, entries[1][0])
  fs.unlinkSync(missing)
  fs.unlinkSync(placeholder)
  fs.writeFileSync(placeholder, entries[1][1])
  const before = fs.statSync(placeholder)
  assert.equal(checkLinks(repo, 'darwin').length, 2)
  assert.equal(fs.existsSync(missing), false)
  assert.equal(fs.readFileSync(placeholder, 'utf8'), entries[1][1])
  assert.equal(fs.statSync(placeholder).mtimeMs, before.mtimeMs)
  assert.equal(repairLinks(repo, 'darwin'), 2)
  assert.deepEqual(checkLinks(repo, 'darwin'), [])
  assert.equal(repairLinks(repo, 'darwin'), 0)
})
for (const kind of ['file', 'directory', 'wrong-link']) {
  test(`last-item ${kind} conflict prevents all repair`, context => {
    const repo = fixture(context)
    fs.unlinkSync(path.join(repo, entries[0][0]))
    const conflict = path.join(repo, 'CLAUDE.md')
    fs.unlinkSync(conflict)
    if (kind === 'file') fs.writeFileSync(conflict, 'AGENTS.md\n')
    if (kind === 'directory') fs.mkdirSync(conflict)
    if (kind === 'wrong-link') fs.symlinkSync('other', conflict)
    assert.throws(() => repairLinks(repo, 'darwin'), /conflict/)
    assert.equal(fs.existsSync(path.join(repo, entries[0][0])), false)
    assert.equal(checkLinks(repo, 'darwin').length, 2)
  })
}
test('Windows absolute junction targets fail closed', context => {
  const repo = fixture(context)
  const junction = path.join(repo, entries[0][0])
  fs.unlinkSync(junction)
  fs.symlinkSync(path.join(repo, '.agents/skills'), junction)
  assert.throws(() => repairLinks(repo, 'win32'), /conflict/)
})
test('symlink parent is rejected before any missing link is repaired', context => {
  const repo = fixture(context)
  fs.unlinkSync(path.join(repo, entries[0][0]))
  fs.unlinkSync(path.join(repo, entries[1][0]))
  fs.rmdirSync(path.join(repo, '.claude'))
  fs.symlinkSync('.codex', path.join(repo, '.claude'))
  assert.throws(() => repairLinks(repo, 'darwin'), /unsafe parent/)
  assert.equal(fs.existsSync(path.join(repo, entries[0][0])), false)
})
test('link creation failure preserves exact placeholder and all other entries', context => {
  const repo = fixture(context)
  const placeholder = path.join(repo, entries[0][0])
  fs.unlinkSync(placeholder)
  fs.writeFileSync(placeholder, entries[0][1])
  const original = fs.symlinkSync
  fs.symlinkSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
  try { assert.throws(() => repairLinks(repo, 'darwin'), /EPERM/) }
  finally { fs.symlinkSync = original }
  assert.equal(fs.readFileSync(placeholder, 'utf8'), entries[0][1])
  assert.equal(fs.readlinkSync(path.join(repo, entries[1][0])), entries[1][1])
  assert.deepEqual(fs.readdirSync(path.join(repo, '.codex')), ['skills'])
})
test('absent final owner blocks repair of preceding missing and placeholder paths', context => {
  const repo = fixture(context)
  fs.unlinkSync(path.join(repo, 'AGENTS.md'))
  fs.unlinkSync(path.join(repo, entries[0][0]))
  const placeholder = path.join(repo, entries[1][0])
  fs.unlinkSync(placeholder)
  fs.writeFileSync(placeholder, entries[1][1])
  assert.ok(checkLinks(repo, 'darwin').some(problem => problem.link === 'CLAUDE.md'))
  assert.throws(() => repairLinks(repo, 'darwin'), /conflict/)
  assert.equal(fs.existsSync(path.join(repo, entries[0][0])), false)
  assert.equal(fs.readFileSync(placeholder, 'utf8'), entries[1][1])
})
test('replacement rename failure leaves placeholder bytes intact and cleans temporary link', context => {
  const repo = fixture(context)
  const placeholder = path.join(repo, entries[0][0])
  fs.unlinkSync(placeholder)
  fs.writeFileSync(placeholder, entries[0][1])
  const original = fs.renameSync
  fs.renameSync = () => { throw new Error('rename denied') }
  try { assert.throws(() => repairLinks(repo, 'darwin'), /rename denied/) }
  finally { fs.renameSync = original }
  assert.equal(fs.readFileSync(placeholder, 'utf8'), entries[0][1])
  assert.deepEqual(fs.readdirSync(path.join(repo, '.codex')), ['skills'])
})
test('wrong physical owner type is reported and preserved', context => {
  const repo = fixture(context)
  fs.rmSync(path.join(repo, '.agents/skills'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agents/skills'), 'not a directory')
  assert.equal(checkLinks(repo, 'darwin').length, 2)
  assert.throws(() => repairLinks(repo, 'darwin'), /conflict/)
  assert.equal(fs.readFileSync(path.join(repo, '.agents/skills'), 'utf8'), 'not a directory')
})
for (const state of ['missing', 'placeholder']) {
  test(`repair explicitly supplies verified dir/file type for ${state} paths`, context => {
    const repo = fixture(context)
    for (const [name, target] of entries) {
      fs.unlinkSync(path.join(repo, name))
      if (state === 'placeholder') fs.writeFileSync(path.join(repo, name), target)
    }
    const calls = []
    const original = fs.symlinkSync
    fs.symlinkSync = (target, filename, type) => {
      calls.push(type)
      return original(target, filename, type)
    }
    try { assert.equal(repairLinks(repo, 'win32'), 3) }
    finally { fs.symlinkSync = original }
    assert.deepEqual(calls, ['dir', 'dir', 'file'])
    assert.deepEqual(checkLinks(repo, 'win32'), [])
  })
}
