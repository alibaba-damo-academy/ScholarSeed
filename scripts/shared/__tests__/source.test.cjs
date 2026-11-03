const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const test = require('node:test')
const { sourceSnapshot, developmentSourceSnapshot, sourceUnchanged } = require('../source.cjs')

const SOURCE_TEST_XATTR = 'com.scholarseed.source-test'

function interleaveReads(context, filename, action, { preserveMtime = false } = {}) {
  const initial = fs.lstatSync(filename)
  const originalLstat = fs.lstatSync
  const originalFstat = fs.fstatSync
  const originalRead = fs.readFileSync
  let reads = 0
  let revision = 0
  const observed = info => {
    if (info.dev !== initial.dev || info.ino !== initial.ino) return info
    return Object.create(info, {
      ctimeMs: { value: info.ctimeMs + revision },
      mtimeMs: { value: preserveMtime ? initial.mtimeMs : info.mtimeMs }
    })
  }
  context.mock.method(fs, 'lstatSync', (...args) => observed(originalLstat(...args)))
  context.mock.method(fs, 'fstatSync', (...args) => observed(originalFstat(...args)))
  context.mock.method(fs, 'readFileSync', (descriptor, ...args) => {
    const content = originalRead(descriptor, ...args)
    if (typeof descriptor === 'number') {
      const info = originalFstat(descriptor)
      if (info.dev === initial.dev && info.ino === initial.ino) {
        reads += 1
        if (action(reads)) revision += 1
      }
    }
    return content
  })
  return { reads: () => reads }
}

test('ctime-only races obtain a stable reread without changing source identity', context => {
  const { root } = fixture(context)
  const before = sourceSnapshot(root)
  const observed = interleaveReads(context, path.join(root, 'tracked.txt'), reads => reads === 1)
  const after = sourceSnapshot(root)
  assert.equal(sourceUnchanged(before, after), true)
  assert.equal(after.clean, true)
  assert.equal(observed.reads(), 3)
})

test('repeated ctime races exhaust a bounded read budget instead of succeeding', context => {
  const { root } = fixture(context)
  const observed = interleaveReads(context, path.join(root, 'tracked.txt'), () => true)
  assert.throws(() => sourceSnapshot(root), /Source metadata did not stabilize.*tracked\.txt/)
  assert.equal(observed.reads(), 3)
})

test('ctime retries cannot accept different bytes with restored size and mtime', context => {
  const { root, write } = fixture(context)
  interleaveReads(context, path.join(root, 'tracked.txt'), reads => {
    if (reads !== 1) return false
    write('tracked.txt', 'changed')
    return true
  }, { preserveMtime: true })
  assert.throws(() => sourceSnapshot(root), /Source bytes changed.*tracked\.txt/)
})

test('a replacement during a read is rejected without retrying its new identity', context => {
  const { root, write } = fixture(context)
  const filename = path.join(root, 'tracked.txt')
  const observed = interleaveReads(context, filename, reads => {
    if (reads !== 1) return false
    write('replacement', 'initial')
    fs.renameSync(path.join(root, 'replacement'), filename)
    return true
  }, { preserveMtime: true })
  assert.throws(() => sourceSnapshot(root), /Source changed|fingerprinting/)
  assert.equal(observed.reads(), 1)
})

test('a size change during a read fails without a metadata retry', context => {
  const { root, write } = fixture(context)
  const observed = interleaveReads(context, path.join(root, 'tracked.txt'), reads => {
    if (reads !== 1) return false
    write('tracked.txt', 'different size')
    return true
  })
  assert.throws(() => sourceSnapshot(root), /Source changed.*tracked\.txt/)
  assert.equal(observed.reads(), 1)
})

test('permission changes are not treated as ctime-only races', {
  skip: process.platform === 'win32'
}, context => {
  const { root } = fixture(context)
  const filename = path.join(root, 'tracked.txt')
  const observed = interleaveReads(context, filename, reads => {
    if (reads !== 1) return false
    fs.chmodSync(filename, 0o755)
    return true
  })
  assert.throws(() => sourceSnapshot(root), /Source changed.*tracked\.txt/)
  assert.equal(observed.reads(), 1)
})

test('macOS xattr writes during hashing preserve clean source evidence', {
  skip: process.platform !== 'darwin'
}, context => {
  const { root } = fixture(context)
  const filename = path.join(root, 'tracked.txt')
  const before = sourceSnapshot(root)
  const metadata = fs.lstatSync(filename)
  interleaveReads(context, filename, reads => {
    if (reads === 1) execFileSync('/usr/bin/xattr', ['-w', SOURCE_TEST_XATTR, 'checked', filename])
    return false
  })
  const after = sourceSnapshot(root)
  assert.equal(sourceUnchanged(before, after), true)
  assert.equal(after.clean, true)
  const changed = fs.lstatSync(filename)
  assert.equal(changed.mtimeMs, metadata.mtimeMs)
  assert.notEqual(changed.ctimeMs, metadata.ctimeMs)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'initial')
})

test('development snapshots hash binary assets as well as code', context => {
  const { root: directory, write } = fixture(context)
  const root = fs.realpathSync(directory)
  assert.equal(sourceUnchanged(sourceSnapshot(root), developmentSourceSnapshot(root)), false)
  const asset = path.join(root, 'font.otf')
  const code = path.join(root, 'large.js')
  write('font.otf', Buffer.alloc(2 * 1024 * 1024))
  write('large.js', 'export const value = 1\n'.repeat(100000))
  const opened = []
  const original = fs.openSync
  context.mock.method(fs, 'openSync', (filename, ...args) => {
    opened.push(filename)
    return original(filename, ...args)
  })
  const before = developmentSourceSnapshot(root)
  assert.equal(opened.includes(asset), true)
  assert.equal(opened.includes(code), true)
  assert.equal(sourceUnchanged(before, developmentSourceSnapshot(root)), true)
  const complete = sourceSnapshot(root)
  assert.equal(opened.includes(asset), true)
  assert.equal(sourceUnchanged(before, complete), false)
  write('font.otf', Buffer.alloc(2 * 1024 * 1024 + 1))
  assert.equal(sourceUnchanged(before, developmentSourceSnapshot(root)), false)
  const changedAsset = developmentSourceSnapshot(root)
  write('large.js', 'export const value = 2\n'.repeat(100000))
  assert.equal(sourceUnchanged(changedAsset, developmentSourceSnapshot(root)), false)
})

test('development PNG identity survives xattr-only changes but detects same-size edits', {
  skip: process.platform !== 'darwin'
}, context => {
  const { root, write } = fixture(context)
  const filename = path.join(root, 'image.png')
  write('image.png', 'original')
  const before = developmentSourceSnapshot(root)
  const metadata = fs.statSync(filename)
  execFileSync('/usr/bin/xattr', ['-w', SOURCE_TEST_XATTR, 'checked', filename])
  assert.notEqual(fs.statSync(filename).ctimeMs, metadata.ctimeMs)
  assert.equal(sourceUnchanged(before, developmentSourceSnapshot(root)), true)
  write('image.png', 'modified')
  fs.utimesSync(filename, metadata.atime, metadata.mtime)
  assert.equal(sourceUnchanged(before, developmentSourceSnapshot(root)), false)
})

test('development binary ctime races require stable bytes and bounded rereads', context => {
  const { root, write } = fixture(context)
  write('image.png', 'original')
  const before = developmentSourceSnapshot(root)
  const observed = interleaveReads(context, path.join(root, 'image.png'), reads => reads === 1)
  assert.equal(sourceUnchanged(before, developmentSourceSnapshot(root)), true)
  assert.equal(observed.reads(), 3)
})

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-source-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '--quiet')
  git('config', 'user.name', 'Source Fixture')
  git('config', 'user.email', 'source@example.test')
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n')
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial')
  git('add', '.')
  git('commit', '--quiet', '-m', 'fixture')
  return { root, git, write: (name, content) => fs.writeFileSync(path.join(root, name), content) }
}

test('clean and unchanged dirty source snapshots remain distinct and reproducible', context => {
  const { root, write } = fixture(context)
  const clean = sourceSnapshot(root)
  assert.equal(clean.clean, true)
  assert.equal(sourceUnchanged(clean, sourceSnapshot(root)), true)
  write('tracked.txt', 'modified')
  const dirty = sourceSnapshot(root)
  assert.equal(dirty.clean, false)
  assert.equal(sourceUnchanged(clean, dirty), false)
  assert.equal(sourceUnchanged(dirty, sourceSnapshot(root)), true)
  assert.equal(JSON.stringify(dirty).includes('modified'), false)
})

test('bytes names creation deletion and staging changes invalidate source identity', context => {
  const { root, git, write } = fixture(context)
  const initial = sourceSnapshot(root)
  const unusual = process.platform === 'win32' ? 'space 中文 file.txt' : 'space 中文\nfile.txt'
  write(unusual, 'untracked')
  const added = sourceSnapshot(root)
  assert.equal(sourceUnchanged(initial, added), false)
  git('add', unusual)
  const staged = sourceSnapshot(root)
  assert.equal(sourceUnchanged(added, staged), false)
  git('update-index', '--assume-unchanged', 'tracked.txt')
  write('tracked.txt', 'hidden change')
  assert.equal(sourceSnapshot(root).clean, false)
  assert.equal(sourceUnchanged(staged, sourceSnapshot(root)), false)
  git('update-index', '--no-assume-unchanged', 'tracked.txt')
  write('tracked.txt', 'initial')
  git('update-index', '--skip-worktree', 'tracked.txt')
  assert.equal(sourceSnapshot(root).clean, false)
  git('update-index', '--no-skip-worktree', 'tracked.txt')
  write('tracked.txt', 'changed bytes')
  assert.equal(sourceUnchanged(staged, sourceSnapshot(root)), false)
  fs.unlinkSync(path.join(root, 'tracked.txt'))
  assert.equal(sourceUnchanged(staged, sourceSnapshot(root)), false)
  fs.mkdirSync(path.join(root, 'tracked.txt'))
  assert.equal(sourceUnchanged(staged, sourceSnapshot(root)), false)
  git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD').trim()},nested`)
  assert.throws(() => sourceSnapshot(root), /gitlinks|submodules/)
})

test('ignored artifacts do not alter source identity and missing evidence never matches', context => {
  const { root } = fixture(context)
  const before = sourceSnapshot(root)
  fs.mkdirSync(path.join(root, 'ignored'))
  fs.writeFileSync(path.join(root, 'ignored', 'result.json'), 'artifact')
  assert.equal(sourceUnchanged(before, sourceSnapshot(root)), true)
  for (const invalid of [null, {}, { ...before, valid: false }, { ...before, fingerprint: 'invalid' }]) {
    assert.equal(sourceUnchanged(before, invalid), false)
  }
})

test('symlink leaves are identified without reading their external contents', { skip: process.platform === 'win32' }, context => {
  const { root } = fixture(context)
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-source-outside-'))
  context.after(() => fs.rmSync(external, { recursive: true, force: true }))
  fs.writeFileSync(path.join(external, 'secret'), 'outside')
  fs.symlinkSync(path.join(external, 'secret'), path.join(root, 'link'))
  const before = sourceSnapshot(root)
  fs.writeFileSync(path.join(external, 'secret'), 'changed outside')
  assert.equal(sourceUnchanged(before, sourceSnapshot(root)), true)
  fs.unlinkSync(path.join(root, 'link'))
  fs.symlinkSync(path.join(external, 'absent'), path.join(root, 'link'))
  assert.equal(sourceUnchanged(before, sourceSnapshot(root)), false)
})

test('linked ancestors are rejected and executable permission changes are recorded', { skip: process.platform === 'win32' }, context => {
  const { root, git } = fixture(context)
  fs.mkdirSync(path.join(root, 'folder'))
  fs.writeFileSync(path.join(root, 'folder', 'child'), 'inside')
  git('add', 'folder/child')
  const before = sourceSnapshot(root)
  fs.chmodSync(path.join(root, 'tracked.txt'), 0o755)
  assert.equal(sourceUnchanged(before, sourceSnapshot(root)), false)
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-source-ancestor-'))
  context.after(() => fs.rmSync(external, { recursive: true, force: true }))
  fs.writeFileSync(path.join(external, 'child'), 'outside')
  fs.rmSync(path.join(root, 'folder'), { recursive: true })
  fs.symlinkSync(external, path.join(root, 'folder'))
  assert.throws(() => sourceSnapshot(root), /ancestor|linked|outside/)
})
