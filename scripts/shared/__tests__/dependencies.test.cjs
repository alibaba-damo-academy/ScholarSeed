const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const state = require('../../../apps/desktop/scripts/shared/build-state.cjs')
const cache = require('../dependencies.cjs')
const { spawn } = require('node:child_process')

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm-snapshot-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const desktop = path.join(root, 'cold', 'apps', 'desktop')
  const destination = path.join(root, 'hot', 'apps', 'desktop')
  for (const directory of [desktop, destination]) fs.mkdirSync(directory, { recursive: true })
  const modules = path.join(desktop, 'node_modules')
  fs.mkdirSync(path.join(modules, 'empty'), { recursive: true })
  fs.mkdirSync(path.join(modules, 'pkg'))
  fs.writeFileSync(path.join(modules, 'pkg', 'package.json'), '{"version":"1.0.0"}')
  fs.writeFileSync(path.join(modules, 'pkg', 'binary.exe'), Buffer.from([0, 1, 2, 255]))
  const inputs = { schema: 1, lock: 'fixture', toolchain: 'fixture' }
  const store = path.join(root, 'cache')
  const entry = path.join(store, state.identity(inputs))
  return { root, desktop, destination, modules, inputs, store, entry }
}

test('complete snapshot restores another checkout, probes, preserves empty dirs and never overwrites a winner', t => {
  const f = fixture(t)
  assert.equal(cache.restore(f.store, f.inputs, f.destination, () => assert.fail('miss probed')), false)
  cache.publish(f.store, f.inputs, f.desktop)
  const initial = fs.readFileSync(path.join(f.entry, 'receipt.json'))
  let probes = 0
  assert.equal(cache.restore(f.store, f.inputs, f.destination, () => probes++), true)
  assert.equal(probes, 1)
  assert.deepEqual(cache.tree(path.join(f.destination, 'node_modules')), cache.tree(f.modules))
  assert.equal(fs.lstatSync(path.join(f.destination, 'node_modules', 'empty')).isDirectory(), true)
  cache.publish(f.store, f.inputs, f.destination)
  assert.deepEqual(fs.readFileSync(path.join(f.entry, 'receipt.json')), initial)
  assert.equal(cache.restore(f.store, { ...f.inputs, lock: 'changed' }, f.destination, () => {}), false)
})

test('corrupt data, graph/tool probe failure and malicious paths reject restoration', t => {
  const f = fixture(t)
  cache.publish(f.store, f.inputs, f.desktop)
  assert.equal(cache.restore(f.store, f.inputs, f.destination, () => { throw new Error('probe failed') }), false)
  const filename = path.join(f.entry, 'receipt.json')
  const original = JSON.parse(fs.readFileSync(filename))
  for (const name of ['node_modules/../../escaped', 'node_modules/C:/bad', 'node_modules/CON', 'node_modules/pkg./bad']) {
    const receipt = structuredClone(original)
    receipt.entries[0].path = name
    fs.writeFileSync(filename, JSON.stringify(receipt))
    assert.equal(cache.restore(f.store, f.inputs, f.destination, () => assert.fail('invalid cache probed')), false)
  }
  assert.equal(fs.existsSync(path.join(f.root, 'escaped')), false)
  fs.writeFileSync(filename, JSON.stringify(original))
  fs.appendFileSync(path.join(f.entry, 'installation.bin'), 'corrupt')
  assert.equal(cache.restore(f.store, f.inputs, f.destination, () => assert.fail('corrupt cache probed')), false)
})

test('source hardlinks and symbolic links cannot become snapshots', t => {
  const f = fixture(t)
  fs.linkSync(path.join(f.modules, 'pkg', 'binary.exe'), path.join(f.modules, 'duplicate'))
  assert.throws(() => cache.publish(f.store, f.inputs, f.desktop), /invalid build state object/)
  fs.unlinkSync(path.join(f.modules, 'duplicate'))
  fs.symlinkSync(path.join(f.modules, 'pkg', 'binary.exe'), path.join(f.modules, 'link'))
  assert.throws(() => cache.publish(f.store, f.inputs, f.desktop), /links are not supported/)
})

test('installation inputs change with effective config but not checkout location; local links opt out', t => {
  const f = fixture(t)
  for (const desktop of [f.desktop, f.destination]) fs.writeFileSync(path.join(desktop, 'package-lock.json'), '{"packages":{}}')
  const command = { executable: process.execPath, args: ['-e', 'console.log("/nonexistent-npm-global-config")', '--'] }
  const tools = { node: { version: process.versions.node }, npm: { version: 'fixture' } }
  const a = cache.inputs(path.join(f.root, 'cold'), tools, command, { npm_config_local_prefix: 'cold', npm_config_cache: 'cold-downloads' })
  const b = cache.inputs(path.join(f.root, 'hot'), tools, command, { npm_config_local_prefix: 'hot', npm_config_cache: 'hot-downloads' })
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, cache.inputs(path.join(f.root, 'cold'), tools, command, { NODE_ENV: 'production' }))
  const hidden = cache.inputs(path.join(f.root, 'cold'), tools, command, { npm_config_registry: 'https://user:private@registry/' })
  assert.equal(JSON.stringify(hidden).includes('private@'), false)
  fs.writeFileSync(path.join(f.desktop, 'package-lock.json'), '{"packages":{"node_modules/local":{"link":true}}}')
  assert.equal(cache.inputs(path.join(f.root, 'cold'), tools, command, {}), null)
})

test('two real publishers atomically converge on one complete private snapshot', async t => {
  const f = fixture(t)
  // Establish the private parent before racing entry publishers.
  state.ensurePrivateDirectory(f.store)
  const source = `require(${JSON.stringify(require.resolve('../dependencies.cjs'))}).publish(${JSON.stringify(f.store)},${JSON.stringify(f.inputs)},${JSON.stringify(f.desktop)})`
  const publish = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', data => { error += data })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)))
  })
  await Promise.all([publish(), publish()])
  assert.equal(cache.restore(f.store, f.inputs, f.destination, () => {}), true)
  assert.deepEqual(fs.readdirSync(f.store), [state.identity(f.inputs)])
})
