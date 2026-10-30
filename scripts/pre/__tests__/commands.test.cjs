const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { installCommandLinks, uninstallCommandLinks } = require('../commands.cjs')

const NAMES = ['scholarseed', 'damoatrace']
function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-links-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  const venv = path.join(repo, '.venv')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(venv, 'bin'), { recursive: true })
  fs.mkdirSync(bin)
  for (const name of [...NAMES, 'mowoker']) fs.writeFileSync(path.join(venv, 'bin', name), 'executable')
  return { root, repo, venv, bin }
}
test('install and uninstall are idempotent for exact owned links including legacy names', context => {
  const { repo, venv, bin } = fixture(context)
  assert.equal(installCommandLinks(repo, venv, [bin], NAMES).created.length, 2)
  assert.equal(installCommandLinks(repo, venv, [bin], NAMES).created.length, 0)
  fs.symlinkSync(path.join(venv, 'bin/mowoker'), path.join(bin, 'mowoker'))
  assert.equal(uninstallCommandLinks(repo, venv, [bin], [...NAMES, 'mowoker']).removed.length, 3)
  assert.equal(uninstallCommandLinks(repo, venv, [bin], [...NAMES, 'mowoker']).removed.length, 0)
})
for (const kind of ['file', 'directory', 'foreign', 'foreign-dangling']) {
  test(`${kind} last target blocks all install and survives uninstall`, context => {
    const { root, repo, venv, bin } = fixture(context)
    const target = path.join(bin, NAMES[1])
    if (kind === 'file') fs.writeFileSync(target, 'third-party')
    if (kind === 'directory') fs.mkdirSync(target)
    if (kind.startsWith('foreign')) {
      const foreign = path.join(root, 'other')
      if (kind === 'foreign') fs.writeFileSync(foreign, 'third-party')
      fs.symlinkSync(foreign, target)
    }
    const before = fs.lstatSync(target)
    assert.throws(() => installCommandLinks(repo, venv, [bin], NAMES), /conflict/)
    assert.equal(fs.existsSync(path.join(bin, NAMES[0])), false)
    assert.equal(uninstallCommandLinks(repo, venv, [bin], NAMES).removed.length, 0)
    assert.equal(fs.lstatSync(target).ino, before.ino)
    if (kind === 'file') assert.equal(fs.readFileSync(target, 'utf8'), 'third-party')
    if (kind.startsWith('foreign')) assert.equal(fs.readlinkSync(target), path.join(root, 'other'))
  })
}
test('owned dangling link may be removed without venv executable existing', context => {
  const { repo, venv, bin } = fixture(context)
  const source = path.join(venv, 'bin', NAMES[0])
  fs.symlinkSync(source, path.join(bin, NAMES[0]))
  fs.unlinkSync(source)
  assert.equal(uninstallCommandLinks(repo, venv, [bin], NAMES).removed.length, 1)
})
test('failed candidate creation selects next bin without altering conflicting candidate entity', context => {
  const { root, repo, venv, bin } = fixture(context)
  const blocked = path.join(root, 'blocked')
  fs.writeFileSync(blocked, 'preserve')
  const result = installCommandLinks(repo, venv, [path.join(blocked, 'bin'), bin], NAMES)
  assert.equal(result.created.length, 2)
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'preserve')
})
test('all failed candidates leave existing files untouched and uninstall does not create directories', context => {
  const { root, repo, venv } = fixture(context)
  const blocked = path.join(root, 'blocked')
  fs.writeFileSync(blocked, 'preserve')
  assert.throws(() => installCommandLinks(repo, venv, [blocked], NAMES), /writable/)
  const missing = path.join(root, 'missing')
  assert.equal(uninstallCommandLinks(repo, venv, [missing], NAMES).removed.length, 0)
  assert.equal(fs.existsSync(missing), false)
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'preserve')
})
test('external venv and symlink bin identity are rejected', context => {
  const { root, repo, venv, bin } = fixture(context)
  const alias = path.join(root, 'alias')
  fs.symlinkSync(bin, alias)
  assert.throws(() => installCommandLinks(repo, path.join(root, 'other'), [bin], NAMES), /venv/)
  assert.throws(() => installCommandLinks(repo, venv, [alias], NAMES), /writable/)
})
test('foreign legacy dangling link is retained while owned links are removed once', context => {
  const { root, repo, venv, bin } = fixture(context)
  installCommandLinks(repo, venv, [bin], NAMES)
  fs.symlinkSync(path.join(root, 'other/mowoker'), path.join(bin, 'mowoker'))
  const result = uninstallCommandLinks(repo, venv, [bin, bin], [...NAMES, 'mowoker'])
  assert.equal(result.removed.length, 2)
  assert.equal(result.unowned.length, 1)
  assert.equal(fs.readlinkSync(path.join(bin, 'mowoker')), path.join(root, 'other/mowoker'))
})
test('unwritable candidate is skipped without modifying its commands', context => {
  const { root, repo, venv, bin } = fixture(context)
  const blocked = path.join(root, 'blocked')
  fs.mkdirSync(blocked)
  fs.writeFileSync(path.join(blocked, NAMES[0]), 'third-party')
  const original = fs.accessSync
  fs.accessSync = (filename, mode) => {
    if (filename === fs.realpathSync(blocked)) throw new Error('permission denied')
    return original(filename, mode)
  }
  try { assert.equal(installCommandLinks(repo, venv, [blocked, bin], NAMES).created.length, 2) }
  finally { fs.accessSync = original }
  assert.equal(fs.readFileSync(path.join(blocked, NAMES[0]), 'utf8'), 'third-party')
})
test('missing executable is reported and foreign executable target blocks all links', context => {
  const { root, repo, venv, bin } = fixture(context)
  const source = path.join(venv, 'bin', NAMES[1])
  fs.unlinkSync(source)
  assert.equal(installCommandLinks(repo, venv, [bin], NAMES).skipped.length, 1)
  uninstallCommandLinks(repo, venv, [bin], NAMES)
  const foreign = path.join(root, 'foreign')
  fs.writeFileSync(foreign, 'foreign')
  fs.symlinkSync(foreign, source)
  assert.throws(() => installCommandLinks(repo, venv, [bin], NAMES), /conflict/)
  assert.deepEqual(fs.readdirSync(bin), [])
})
test('symlink followed by parent traversal is unowned despite lexical same-venv spelling', context => {
  const { root, repo, venv, bin } = fixture(context)
  const foreign = path.join(root, 'foreign')
  fs.mkdirSync(path.join(foreign, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(foreign, NAMES[1]), 'foreign')
  fs.symlinkSync(path.join(foreign, 'sub'), path.join(venv, 'bin/bridge'))
  const target = `${venv}/bin/bridge/../${NAMES[1]}`
  const link = path.join(bin, NAMES[1])
  fs.symlinkSync(target, link)
  assert.equal(fs.readFileSync(link, 'utf8'), 'foreign')
  assert.throws(() => installCommandLinks(repo, venv, [bin], NAMES), /conflict/)
  assert.equal(fs.existsSync(path.join(bin, NAMES[0])), false)
  const result = uninstallCommandLinks(repo, venv, [bin], NAMES)
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.unowned, [fs.realpathSync(bin) + path.sep + NAMES[1]])
  assert.equal(fs.readlinkSync(link), target)
})
for (const kind of ['foreign-source', 'directory-source', 'traversal-source']) {
  test(`owned last link with ${kind} blocks creation of preceding link`, context => {
    const { root, repo, venv, bin } = fixture(context)
    const source = path.join(venv, 'bin', NAMES[1])
    fs.unlinkSync(source)
    if (kind === 'directory-source') fs.mkdirSync(source)
    else {
      const foreign = path.join(root, 'foreign')
      fs.mkdirSync(path.join(foreign, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(foreign, NAMES[1]), 'foreign')
      if (kind === 'traversal-source') {
        fs.symlinkSync(path.join(foreign, 'sub'), path.join(venv, 'bin/bridge'))
        fs.symlinkSync(`bridge/../${NAMES[1]}`, source)
      } else fs.symlinkSync(path.join(foreign, NAMES[1]), source)
    }
    const link = path.join(bin, NAMES[1])
    fs.symlinkSync(source, link)
    assert.throws(() => installCommandLinks(repo, venv, [bin], NAMES), /conflict/)
    assert.equal(fs.existsSync(path.join(bin, NAMES[0])), false)
    assert.equal(fs.readlinkSync(link), source)
  })
}
test('owned dangling install is retained but reports missing source instead of existing success', context => {
  const { repo, venv, bin } = fixture(context)
  const source = path.join(venv, 'bin', NAMES[1])
  fs.unlinkSync(source)
  fs.symlinkSync(source, path.join(bin, NAMES[1]))
  const result = installCommandLinks(repo, venv, [bin], NAMES)
  assert.equal(result.created.length, 1)
  assert.deepEqual(result.existing, [])
  assert.equal(result.skipped.length, 1)
  assert.equal(fs.readlinkSync(path.join(bin, NAMES[1])), source)
})
