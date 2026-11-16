const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {parseMinimumVersions, verifyMachO, verifyMacOSTree} = require('../macos.cjs')

test('macOS load commands retain every architecture minimum and ignore SDK and dylib versions', () => {
  assert.deepEqual(parseMinimumVersions('\ncmd LC_BUILD_VERSION\nplatform 1\nminos 13.0\nsdk 27.0\ncmd LC_LOAD_DYLIB\ncurrent version 99.0\ncmd LC_VERSION_MIN_MACOSX\nversion 10.15\nsdk 14.0\n\n'), ['13.0', '10.15'])
  assert.throws(() => parseMinimumVersions('cmd LC_BUILD_VERSION\nplatform 2\nminos 13.0'), /not macOS/)
  assert.throws(() => parseMinimumVersions('cmd LC_BUILD_VERSION\nsdk 27.0'), /minimum/)
  assert.throws(() => parseMinimumVersions('cmd LC_BUILD_VERSION\nminos 13.0'), /platform/)
})

test('native payloads above the floor fail even if their file name advertises compatibility', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-minimum-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const binary = path.join(root, 'macosx_13_0.so')
  fs.writeFileSync(binary, Buffer.from('cffaedfe000000000000000000000000', 'hex'))
  const inspector = version => () => `cmd LC_BUILD_VERSION\nplatform 1\nminos ${version}\nsdk 27.0`
  assert.deepEqual(verifyMachO(binary, '13.0', inspector('11.0')).minimums, ['11.0'])
  assert.throws(() => verifyMachO(binary, '13.0', inspector('13.5')), /requires macOS 13.5/)
  assert.throws(() => verifyMachO(binary, '13.0', () => {throw new Error('tool failed')}), /tool failed/)
  fs.writeFileSync(path.join(root, 'text.py'), 'not native')
  assert.equal(verifyMachO(path.join(root, 'text.py')), null)
})

test('tree inspection never follows links outside the artifact', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-minimum-links-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  fs.symlinkSync(process.execPath, path.join(root, 'external'))
  assert.throws(() => verifyMacOSTree(root), /escapes/)
})
