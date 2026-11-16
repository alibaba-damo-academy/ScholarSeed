const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { checkLinks, repairLinks } = require('../symlinks.cjs')

const LINK = 'docs/latest'
const TARGET = '../docs/current'
const SENTINEL = 'unmanaged/keep.txt'

function fixture(context) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', repo])
  fs.mkdirSync(path.join(repo, 'docs/current'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'unmanaged'))
  fs.writeFileSync(path.join(repo, SENTINEL), 'preserve')
  fs.symlinkSync(TARGET, path.join(repo, LINK), 'dir')
  execFileSync('git', ['-C', repo, 'add', '.'])
  return repo
}

function preserved(repo) {
  assert.equal(fs.readFileSync(path.join(repo, SENTINEL), 'utf8'), 'preserve')
}

test('tracked file links use the actual owner type', context => {
  const repo = fixture(context)
  fs.unlinkSync(path.join(repo, LINK))
  fs.rmSync(path.join(repo, 'docs/current'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs/current'), 'ordinary file')
  fs.writeFileSync(path.join(repo, LINK), TARGET)
  assert.equal(repairLinks(repo), 1)
  assert.deepEqual(checkLinks(repo), [])
  preserved(repo)
})

test('tracked links cannot select an owner outside the requested repository', context => {
  const repo = fixture(context)
  fs.unlinkSync(path.join(repo, LINK))
  fs.symlinkSync('../..', path.join(repo, LINK), 'dir')
  execFileSync('git', ['-C', repo, 'add', LINK])
  assert.deepEqual(checkLinks(repo), [{ link: LINK, state: 'conflict' }])
  assert.throws(() => repairLinks(repo), /conflict/)
  preserved(repo)
})

test('Windows relative link separators are equivalent without accepting absolute targets', context => {
  const repo = fixture(context)
  const original = fs.readlinkSync
  fs.readlinkSync = filename => original(filename).replaceAll('/', '\\')
  try { assert.deepEqual(checkLinks(repo, 'win32'), []) }
  finally { fs.readlinkSync = original }
  fs.readlinkSync = filename => path.win32.resolve('C:\\foreign', original(filename))
  try { assert.deepEqual(checkLinks(repo, 'win32'), [{ link: LINK, state: 'conflict' }]) }
  finally { fs.readlinkSync = original }
})

for (const state of ['missing', 'placeholder']) {
  test(`check is read-only and ${state} repair is idempotent`, context => {
    const repo = fixture(context)
    const filename = path.join(repo, LINK)
    fs.unlinkSync(filename)
    if (state === 'placeholder') fs.writeFileSync(filename, TARGET)
    const before = state === 'placeholder' ? fs.statSync(filename).mtimeMs : null
    assert.deepEqual(checkLinks(repo), [{ link: LINK, state }])
    if (state === 'placeholder') {
      assert.equal(fs.readFileSync(filename, 'utf8'), TARGET)
      assert.equal(fs.statSync(filename).mtimeMs, before)
    } else assert.equal(fs.existsSync(filename), false)
    assert.equal(repairLinks(repo), 1)
    assert.deepEqual(checkLinks(repo), [])
    assert.equal(repairLinks(repo), 0)
    assert.equal(fs.existsSync(path.join(repo, '.claude')), false)
    assert.equal(fs.existsSync(path.join(repo, 'CLAUDE.md')), false)
    preserved(repo)
  })
}

for (const kind of ['file', 'directory', 'wrong-link']) {
  test(`${kind} conflict prevents repair and preserves unrelated files`, context => {
    const repo = fixture(context)
    const filename = path.join(repo, LINK)
    fs.unlinkSync(filename)
    if (kind === 'file') fs.writeFileSync(filename, TARGET + '\n')
    if (kind === 'directory') fs.mkdirSync(filename)
    if (kind === 'wrong-link') fs.symlinkSync('other', filename, 'dir')
    assert.throws(() => repairLinks(repo), /conflict/)
    assert.deepEqual(checkLinks(repo), [{ link: LINK, state: 'conflict' }])
    preserved(repo)
  })
}

test('Windows absolute junction targets fail closed', context => {
  const repo = fixture(context)
  const filename = path.join(repo, LINK)
  fs.unlinkSync(filename)
  fs.symlinkSync(path.join(repo, 'docs/current'), filename, 'dir')
  assert.throws(() => repairLinks(repo, 'win32'), /conflict/)
  preserved(repo)
})

test('symlink parent is rejected before repair', context => {
  const repo = fixture(context)
  fs.unlinkSync(path.join(repo, LINK))
  fs.rmdirSync(path.join(repo, 'docs/current'))
  fs.rmdirSync(path.join(repo, 'docs'))
  fs.symlinkSync('unmanaged', path.join(repo, 'docs'), 'dir')
  assert.throws(() => repairLinks(repo), /unsafe parent/)
  assert.equal(fs.existsSync(path.join(repo, LINK)), false)
  preserved(repo)
})

for (const failure of ['creation', 'rename']) {
  test(`${failure} failure preserves exact placeholder bytes`, context => {
    const repo = fixture(context)
    const filename = path.join(repo, LINK)
    fs.unlinkSync(filename)
    fs.writeFileSync(filename, TARGET)
    const method = failure === 'creation' ? 'symlinkSync' : 'renameSync'
    const original = fs[method]
    fs[method] = () => { throw new Error('injected failure') }
    try { assert.throws(() => repairLinks(repo), /injected failure/) }
    finally { fs[method] = original }
    assert.equal(fs.readFileSync(filename, 'utf8'), TARGET)
    assert.deepEqual(fs.readdirSync(path.join(repo, 'docs')), ['current', 'latest'])
    preserved(repo)
  })
}

for (const state of ['absent', 'symlink']) {
  test(`${state} physical owner blocks repair`, context => {
    const repo = fixture(context)
    const owner = path.join(repo, 'docs/current')
    fs.rmSync(owner, { recursive: true })
    if (state === 'symlink') fs.symlinkSync('..', owner, 'dir')
    fs.unlinkSync(path.join(repo, LINK))
    fs.writeFileSync(path.join(repo, LINK), TARGET)
    assert.deepEqual(checkLinks(repo), [{ link: LINK, state: 'conflict' }])
    assert.throws(() => repairLinks(repo), /conflict/)
    assert.equal(fs.readFileSync(path.join(repo, LINK), 'utf8'), TARGET)
    preserved(repo)
  })
}

for (const state of ['missing', 'placeholder']) {
  test(`repair supplies the verified directory type for ${state}`, context => {
    const repo = fixture(context)
    const filename = path.join(repo, LINK)
    fs.unlinkSync(filename)
    if (state === 'placeholder') fs.writeFileSync(filename, TARGET)
    const calls = []
    const original = fs.symlinkSync
    fs.symlinkSync = (target, destination, type) => {
      calls.push(type)
      return original(target, destination, type)
    }
    try { assert.equal(repairLinks(repo, 'win32'), 1) }
    finally { fs.symlinkSync = original }
    assert.deepEqual(calls, ['dir'])
    assert.deepEqual(checkLinks(repo, 'win32'), [])
    preserved(repo)
  })
}
