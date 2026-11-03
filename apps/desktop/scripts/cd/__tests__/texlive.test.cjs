const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const PE = require('pe-library')
const { normalizeTexliveTree } = require('../texlive.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'texlive-utf8-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const bin = path.join(root, 'bin/windows')
  fs.mkdirSync(bin, {recursive: true})
  const raw = Buffer.from(PE.NtExecutable.createEmpty(false, false).generate())
  for (const name of ['xetex.exe', 'xelatex.exe']) fs.writeFileSync(path.join(bin, name), raw)
  return {root, bin, raw}
}

test('Windows TeX embeds UTF-8 for both entrypoints, preserves resources and is byte-stable', t => {
  const {bin} = fixture(t)
  const filename = path.join(bin, 'xelatex.exe')
  const exe = PE.NtExecutable.from(fs.readFileSync(filename))
  const resources = PE.NtExecutableResource.from(exe)
  resources.replaceResourceEntryFromString(10, 2, 1033, 'preserved fixture resource')
  resources.outputResource(exe)
  fs.writeFileSync(filename, Buffer.from(exe.generate()))
  normalizeTexliveTree(bin, 'win32')
  for (const name of ['xetex.exe', 'xelatex.exe']) {
    const readback = PE.NtExecutableResource.from(PE.NtExecutable.from(fs.readFileSync(path.join(bin, name))))
    const manifests = readback.getResourceEntriesAsString(24, 1)
    assert.equal(manifests.length, 1)
    assert.equal(manifests[0][0], 0)
    assert.match(manifests[0][1], /<activeCodePage[^>]*>UTF-8<\/activeCodePage>/)
    assert.doesNotMatch(manifests[0][1], /requestedExecutionLevel|autoElevate/)
    if (name === 'xelatex.exe') assert.deepEqual(readback.getResourceEntriesAsString(10, 2), [[1033, 'preserved fixture resource']])
  }
  const first = fs.readFileSync(filename)
  normalizeTexliveTree(bin, 'win32')
  assert.deepEqual(fs.readFileSync(filename), first)
})

test('unexpected vendor manifest fails before either executable is changed', t => {
  const {bin, raw} = fixture(t)
  const filename = path.join(bin, 'xelatex.exe')
  const exe = PE.NtExecutable.from(raw)
  const resources = PE.NtExecutableResource.from(exe)
  resources.replaceResourceEntryFromString(24, 1, 1033, '<unexpected/>')
  resources.outputResource(exe)
  fs.writeFileSync(filename, Buffer.from(exe.generate()))
  const before = fs.readFileSync(filename)
  assert.throws(() => normalizeTexliveTree(bin, 'win32'), /unexpected TeX process manifest/)
  assert.deepEqual(fs.readFileSync(path.join(bin, 'xetex.exe')), raw)
  assert.deepEqual(fs.readFileSync(filename), before)
})

test('signed vendor executable is refused without invalidating its signature', t => {
  const {bin, raw} = fixture(t)
  const exe = PE.NtExecutable.from(raw)
  exe.newHeader.optionalHeaderDataDirectory.set(4, {virtualAddress: 512, size: 32})
  // generate clears certificates, so install this fixture's signed header last.
  const signed = Buffer.from(raw)
  Buffer.from(exe.getRawHeader()).copy(signed)
  const filename = path.join(bin, 'xelatex.exe')
  fs.writeFileSync(filename, signed)
  assert.throws(() => normalizeTexliveTree(bin, 'win32'), /signed/i)
  assert.deepEqual(fs.readFileSync(filename), signed)
  assert.deepEqual(fs.readFileSync(path.join(bin, 'xetex.exe')), raw)
})

test('macOS normalization never edits executable bytes', t => {
  const {bin, raw} = fixture(t)
  normalizeTexliveTree(bin, 'darwin')
  assert.deepEqual(fs.readFileSync(path.join(bin, 'xelatex.exe')), raw)
})

test('linked executables are refused and fresh copies normalize to identical bytes', t => {
  const first = fixture(t)
  const second = fixture(t)
  normalizeTexliveTree(first.bin, 'win32')
  normalizeTexliveTree(second.bin, 'win32')
  assert.deepEqual(fs.readFileSync(path.join(first.bin, 'xelatex.exe')),
    fs.readFileSync(path.join(second.bin, 'xelatex.exe')))
  const linked = fixture(t)
  fs.linkSync(path.join(linked.bin, 'xelatex.exe'), path.join(linked.root, 'alias.exe'))
  assert.throws(() => normalizeTexliveTree(linked.bin, 'win32'), /invalid build state object/)
  assert.deepEqual(fs.readFileSync(path.join(linked.bin, 'xetex.exe')), linked.raw)
})
