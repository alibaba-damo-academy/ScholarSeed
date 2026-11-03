const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const child = require('node:child_process')
const { createRequire } = require('node:module')
const cache = require('../../shared/component-cache.cjs')
const state = require('../../shared/build-state.cjs')
const { developmentPython } = require('../../../../../scripts/shared/python.cjs')
const REPO = path.resolve(sourceDirectory, '../../../..')
const PYTHON = process.env.TEST_PYTHON || developmentPython(REPO, process.env.VENV, { context: process.env.CI ? 'ci' : 'local' })

function fixture(t, kind = 'codex') {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-compression-')))
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}))
  const root = path.join(temporary, 'source'), repo = path.join(temporary, 'repo')
  fs.mkdirSync(path.join(root, 'bin'), {recursive: true})
  fs.writeFileSync(path.join(root, 'bin', 'runtime.exe'), 'runtime contents')
  fs.writeFileSync(path.join(root, 'notice.txt'), 'license')
  for (const [file] of cache.recipe(REPO, {}, kind).files) {
    const output = path.join(repo, file)
    fs.mkdirSync(path.dirname(output), {recursive: true})
    fs.copyFileSync(path.join(REPO, file), output)
  }
  const filename = path.join(sourceDirectory, 'compression.cjs'), module = {exports: {}}
  const realRequire = createRequire(filename), commands = []
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, __dirname: sourceDirectory, require: name =>
    name === 'node:child_process' ? {...child, execFileSync: (file, args, options) => {
      commands.push([file, ...args]); return child.execFileSync(file, args, options)
    }} : realRequire(name)}, {filename})
  const inputs = {cacheRoot: path.join(temporary, 'cache'), repo, kind, target: 'win32-x86_64',
    contentId: 'a'.repeat(64), pythonArchiveSha256: 'b'.repeat(64),
    python: PYTHON, root,
    entry: 'bin/runtime.exe'}
  let sequence = 0
  const pack = (overrides = {}) => {
    const output = path.join(temporary, `${++sequence}.zip`)
    const measured = module.exports.pack({...inputs, ...overrides, output}, process.env)
    return {output, measured}
  }
  return {temporary, inputs, commands, pack}
}
for (const kind of ['codex', 'office', 'electron']) test(`${kind} ZIP warm reuse preserves exact bytes and full inventory without compression`, t => {
  const f = fixture(t, kind), first = f.pack(), second = f.pack()
  assert.equal(f.commands.length, 1)
  assert.deepEqual(fs.readFileSync(first.output), fs.readFileSync(second.output))
  assert.deepEqual(first.measured, second.measured)
  const files = JSON.parse(child.execFileSync(f.inputs.python, ['-I', '-B', path.join(sourceDirectory, 'archive_inventory.py'), '--files', second.output]))[0].files
  assert.deepEqual(files.map(file => file.path), ['bin/runtime.exe', 'notice.txt'])
  assert.deepEqual(second.measured.files, files)
})
test('ZIP inputs bind actual files, directories, target, recipe, interpreter and entry', t => {
  const f = fixture(t)
  f.pack(); f.pack()
  assert.equal(f.commands.length, 1)
  fs.writeFileSync(path.join(f.inputs.root, 'notice.txt'), 'changed license')
  f.pack(); assert.equal(f.commands.length, 2)
  fs.mkdirSync(path.join(f.inputs.root, 'empty'))
  f.pack(); assert.equal(f.commands.length, 3)
  f.pack({target: 'win32-other'}); assert.equal(f.commands.length, 4)
  f.pack({pythonArchiveSha256: 'c'.repeat(64)}); assert.equal(f.commands.length, 5)
  f.pack({entry: 'notice.txt'}); assert.equal(f.commands.length, 6)
  fs.appendFileSync(path.join(f.inputs.repo, 'apps/desktop/scripts/cd/payload.py'), '\n# recipe changed\n')
  f.pack(); assert.equal(f.commands.length, 7)
})
test('corrupt warm ZIP fails without compression or overwriting outputs', t => {
  const f = fixture(t); f.pack()
  const directory = fs.readdirSync(f.inputs.cacheRoot)[0]
  fs.appendFileSync(path.join(f.inputs.cacheRoot, directory, 'component.zip'), 'tampered')
  assert.throws(() => f.pack(), /digest mismatch/)
  assert.equal(f.commands.length, 1)
})
test('cache-disabled ZIP matches cached cold bytes and does not create another cache', t => {
  const f = fixture(t), cold = f.pack(), uncached = f.pack({cacheRoot: null})
  assert.deepEqual(fs.readFileSync(cold.output), fs.readFileSync(uncached.output))
  assert.equal(f.commands.length, 2)
  assert.equal(fs.readdirSync(f.inputs.cacheRoot).length, 1)
})
test('rootless layout is explicit; existing prefixed Python archives remain constrained', t => {
  const f = fixture(t), archive = f.pack().output
  assert.throws(() => cache.measure(f.inputs.python, archive, process.env, 'python'), /component_archive_root/)
  assert.equal(cache.measure(f.inputs.python, archive, process.env, '').archiveSha256, state.hashFile(archive))
})
