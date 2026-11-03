const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

test('macOS default temporary alias supports builder lifecycle without accepting explicit links',
  {skip: process.platform !== 'darwin'}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wheel-path-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const physical = path.join(root, 'physical'), alias = path.join(root, 'alias')
  fs.mkdirSync(physical)
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const temporary = path.join(alias, 'nested')
  fs.mkdirSync(temporary)
  const filename = require.resolve('../wheels.cjs'), realRequire = createRequire(filename)
  const module = {exports: {}}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, __filename: filename,
    process: {platform: 'darwin'}, require: name => {
      if (name === 'node:os') return {tmpdir: () => temporary}
      if (name === 'node:child_process') return {execFileSync: () => '["3.12.13","1.0"]'}
      return realRequire(name)
    }}, {filename})
  for (const fail of [false, true]) {
    let directory, invoked = false
    const promise = module.exports.withBuilder({python: 'target-python', uv: 'uv',
      buildConstraints: '', environment: {}, run: (file, args) => {
        assert.equal(file, 'uv')
        if (args[0] !== 'venv') return
        directory = path.dirname(path.dirname(args.at(-1)))
        assert.equal(path.dirname(directory), path.join(physical, 'nested'))
        if (fail) throw new Error('builder failed')
      }}, async () => { invoked = true })
    if (fail) await assert.rejects(promise, /builder failed/)
    else await promise
    assert.equal(invoked, !fail)
    assert.ok(!fs.existsSync(directory))
    assert.deepEqual(fs.readdirSync(temporary), [])
  }
  await assert.rejects(module.exports.withBuilder({temporaryRoot: temporary,
    run: () => assert.fail('explicit links must fail before spawning')},
  () => assert.fail('explicit links must not reach callback')), /invalid build state object/)
  assert.deepEqual(fs.readdirSync(temporary), [])
  for (const platform of ['win32', 'linux']) {
    const other = {exports: {}}
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module: other, __filename: filename,
      process: {platform}, require: name => name === 'node:os'
        ? {tmpdir: () => temporary} : realRequire(name)}, {filename})
    await assert.rejects(other.exports.withBuilder({
      run: () => assert.fail('other platforms must retain strict default root checks')},
    () => assert.fail('linked default must not reach callback')), /invalid build state object/)
  }
})

test('locked wheel builder syncs hashes privately and cleans up on success and failure', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wheel-test-')))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const filename = require.resolve('../wheels.cjs'), realRequire = createRequire(filename)
  const module = {exports: {}}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {module, process, __filename: filename,
    require: name => {
      if (name === 'node:os') return {tmpdir: () => assert.fail('explicit root must override system Temp')}
      return name === 'node:child_process' ? {execFileSync: () => '["3.12.13","1.0"]'} : realRequire(name)
    }}, {filename})
  for (const fail of [false, true]) {
    const buildConstraints = `fixture-builder==${fail ? 2 : 1}.0 --hash=sha256:${'a'.repeat(64)}\n`
    let directory, invoked = false
    const promise = module.exports.withBuilder({python: 'target-python', uv: 'uv', temporaryRoot: root,
      buildConstraints, environment: {PIP_EXTRA_INDEX_URL: 'must-not-inherit'}, run: (file, args) => {
        assert.equal(file, 'uv')
        if (args[0] === 'venv') return
        assert.ok(args.includes('--require-hashes'))
        assert.ok(args.includes('--only-binary'))
        assert.equal(fs.readFileSync(args.at(-1), 'utf8'), buildConstraints)
        directory = path.dirname(path.dirname(args.at(-1)))
        if (fail) throw new Error('sync rejected')
      }}, async prepared => {
        invoked = true
        assert.equal(prepared.buildConstraints, buildConstraints)
        assert.equal(prepared.environment.PIP_NO_INDEX, '1')
        assert.equal(prepared.environment.PIP_EXTRA_INDEX_URL, undefined)
        assert.ok(prepared.python.startsWith(directory))
      })
    if (fail) await assert.rejects(promise, /sync rejected/)
    else await promise
    assert.equal(invoked, !fail)
    assert.ok(!fs.existsSync(directory))
  }
})
