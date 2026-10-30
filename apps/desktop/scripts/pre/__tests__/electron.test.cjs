const sourceDirectory = require('node:path').dirname(__dirname)
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { inventory, verify, cloneDistribution, usesClones, archiveDigest, withLock } = require('../electron.cjs')
const PYTHON = process.env.PYTHON || path.resolve(sourceDirectory, '../../../../.venv/bin/python')
const CLONE_PROBE = `
import ctypes, os, struct, sys, json
class Attributes(ctypes.Structure):
    _fields_ = [('count', ctypes.c_ushort), ('reserved', ctypes.c_ushort),
                ('common', ctypes.c_uint32), ('volume', ctypes.c_uint32),
                ('directory', ctypes.c_uint32), ('file', ctypes.c_uint32),
                ('extended', ctypes.c_uint32)]
library = ctypes.CDLL(None, use_errno=True)
library.getattrlist.argtypes = [ctypes.c_char_p, ctypes.POINTER(Attributes),
                              ctypes.c_void_p, ctypes.c_size_t, ctypes.c_ulong]
attributes = Attributes(5, 0, 0x80000000, 0, 0, 0, 0x1308)
results = []
for filename in sys.argv[1:]:
    buffer = ctypes.create_string_buffer(128)
    if library.getattrlist(os.fsencode(filename), ctypes.byref(attributes), buffer, 128, 0x20):
        raise OSError(ctypes.get_errno(), filename)
    results.append(struct.unpack_from('QQQI', buffer, 24))
print(json.dumps(results))
`

function fixture(context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'electron-clone-')))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'original')
  fs.mkdirSync(path.join(source, 'Electron.app', 'Contents', 'MacOS'), { recursive: true })
  fs.writeFileSync(path.join(source, 'version'), '44.3.0')
  fs.writeFileSync(path.join(source, 'Electron.app', 'Contents', 'MacOS', 'Electron'), 'runtime', { mode: 0o755 })
  fs.writeFileSync(path.join(source, 'Electron.app', 'Contents', 'Info.plist'), 'original identity')
  fs.symlinkSync('MacOS/Electron', path.join(source, 'Electron.app', 'Contents', 'Current'))
  return { root, source }
}

test('only native macOS installations without overrides use clones', () => {
  assert.equal(usesClones('darwin', {}), true)
  assert.equal(usesClones('win32', {}), false)
  assert.equal(usesClones('linux', {}), false)
  for (const name of ['ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_INSTALL_ARCH', 'ELECTRON_INSTALL_PLATFORM', 'npm_config_arch', 'npm_config_platform', 'force_no_cache', 'electron_use_remote_checksums', 'npm_config_electron_use_remote_checksums']) {
    assert.equal(usesClones('darwin', { [name]: 'override' }), false)
  }
})

test('inventory detects changed bytes, modes, extra files and escaping symlinks', { skip: process.platform !== 'darwin' }, context => {
  const { source } = fixture(context)
  const expected = inventory(source)
  verify(source, expected)
  const identity = path.join(source, 'Electron.app', 'Contents', 'Info.plist')
  fs.writeFileSync(identity, 'modified identity')
  assert.throws(() => verify(source, expected), /inventory/)
  fs.writeFileSync(identity, 'original identity')
  fs.chmodSync(identity, 0o755)
  assert.throws(() => verify(source, expected), /inventory/)
  fs.chmodSync(identity, 0o644)
  fs.writeFileSync(path.join(source, 'extra'), 'extra')
  assert.throws(() => verify(source, expected), /inventory/)
  fs.rmSync(path.join(source, 'extra'))
  fs.symlinkSync('/tmp', path.join(source, 'escape'))
  assert.throws(() => inventory(source), /symlink/)
})

test('APFS clones keep standard paths, relative links and independent identity', { skip: process.platform !== 'darwin' }, context => {
  const { root, source } = fixture(context)
  const expected = inventory(source)
  const first = path.join(root, 'first', 'dist')
  const second = path.join(root, 'second', 'dist')
  cloneDistribution(source, first)
  cloneDistribution(source, second)
  verify(first, expected)
  verify(second, expected)
  const identity = path.join('Electron.app', 'Contents', 'Info.plist')
  fs.writeFileSync(path.join(first, identity), 'first identity')
  assert.equal(fs.readFileSync(path.join(second, identity), 'utf8'), 'original identity')
  assert.equal(fs.readlinkSync(path.join(second, 'Electron.app', 'Contents', 'Current')), 'MacOS/Electron')
  verify(source, expected)
  assert.throws(() => cloneDistribution(source, first), /exists/)
})

test('archive verification accepts read-only hardlinked cache files but rejects symlinks', { skip: process.platform !== 'darwin' }, context => {
  const { root } = fixture(context)
  const original = path.join(root, 'archive.zip')
  const linked = path.join(root, 'linked.zip')
  fs.writeFileSync(original, 'archive bytes')
  fs.linkSync(original, linked)
  assert.equal(archiveDigest(linked), crypto.createHash('sha256').update('archive bytes').digest('hex'))
  const symlink = path.join(root, 'symlink.zip')
  fs.symlinkSync(original, symlink)
  assert.throws(() => archiveDigest(symlink))
})

test('concurrent cache users serialize and failures release their lock', { skip: process.platform !== 'darwin' }, async context => {
  const { root } = fixture(context)
  const lock = path.join(root, 'cache.lock')
  const order = []
  await Promise.all([withLock(lock, async () => {
    order.push('first')
    await new Promise(resolve => setImmediate(resolve))
    order.push('finished')
  }), withLock(lock, async () => { order.push('second') })])
  assert.deepEqual(order, ['first', 'finished', 'second'])
  await assert.rejects(withLock(lock, async () => { throw new Error('failed') }), /failed/)
  assert.equal(fs.existsSync(lock), false)
})

test('native APFS clone shares actual blocks rather than merely copying bytes', {
  skip: process.platform !== 'darwin' || !fs.existsSync(PYTHON),
}, context => {
  const { root, source } = fixture(context)
  const destination = path.join(root, 'cloned')
  cloneDistribution(source, destination)
  const executable = path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
  const [original, cloned] = JSON.parse(execFileSync(PYTHON, [
    '-c', CLONE_PROBE, path.join(source, executable), path.join(destination, executable),
  ], { encoding: 'utf8' }))
  assert.equal(original[1], cloned[1])
  assert.equal(cloned[0], 0)
  assert.ok(cloned[2] & 0x40)
})
