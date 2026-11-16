const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const {createRequire} = require('node:module')

const ROOT = path.resolve(__dirname, '../../..')

function fixture(context, foreign = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-python-upgrade-')))
  context.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const vendor = path.join(root, 'scripts/vendor/python-build-standalone')
  fs.mkdirSync(vendor, {recursive: true})
  fs.copyFileSync(path.join(ROOT, 'scripts/vendor/python-build-standalone/manifest.json'), path.join(vendor, 'manifest.json'))
  const release = require('../python.cjs').pythonRelease(root)
  const oldHash = 'a'.repeat(64), oldRoot = path.join(root, '.python', oldHash)
  const base = path.join(oldRoot, 'python'), current = path.join(root, '.python', release.sha256, 'python')
  const environment = path.join(root, 'venv with spaces')
  for (const directory of [base, current, environment]) fs.mkdirSync(directory, {recursive: true})
  fs.writeFileSync(path.join(oldRoot, 'archive.sha256'), oldHash)
  fs.writeFileSync(path.join(path.dirname(current), 'archive.sha256'), release.sha256)
  const executable = path.join(environment, ...release.venvExecutable.split('/'))
  fs.mkdirSync(path.dirname(executable), {recursive: true})
  fs.writeFileSync(executable, 'owned old interpreter')
  fs.writeFileSync(path.join(environment, 'pyvenv.cfg'), 'owned')
  fs.writeFileSync(path.join(environment, 'preserved'), 'do not lose previous files')
  const source = path.join(ROOT, 'scripts/shared/python.cjs'), realRequire = createRequire(source), module = {exports: {}}
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {module, process, console, Buffer, __dirname: path.dirname(source),
    require: name => name === 'node:child_process' ? {
      execFileSync: selected => JSON.stringify({...release, python: selected === executable || selected.includes(oldHash) ? '3.12.13' : release.python,
        prefix: selected === executable ? environment : selected.includes(oldHash) ? base : current,
        base_prefix: selected === executable ? foreign ? current : base : selected.includes(oldHash) ? base : current})
    } : realRequire(name)}, {filename: source})
  return {root, environment, policy: module.exports}
}

test('an old owned environment is retained before replacement and can be restored after failure', context => {
  const state = fixture(context)
  const staged = state.policy.stagePreviousEnvironment(state.root, state.environment)
  assert.ok(staged)
  assert.ok(!fs.existsSync(state.environment))
  assert.equal(fs.readFileSync(path.join(staged.previous, 'preserved'), 'utf8'), 'do not lose previous files')
  fs.mkdirSync(state.environment)
  fs.writeFileSync(path.join(state.environment, 'partial'), 'new failed attempt')
  state.policy.restorePreviousEnvironment(staged)
  assert.equal(fs.readFileSync(path.join(state.environment, 'preserved'), 'utf8'), 'do not lose previous files')
  assert.ok(!fs.existsSync(path.join(state.environment, 'partial')))
})

test('foreign or unverifiable environments are preserved rather than automatically replaced', context => {
  const state = fixture(context, true)
  assert.throws(() => state.policy.stagePreviousEnvironment(state.root, state.environment), /runtime/)
  assert.ok(fs.existsSync(path.join(state.environment, 'preserved')))
  assert.equal(fs.readdirSync(path.join(state.root, '.python')).filter(name => name.startsWith('upgrade-')).length, 0)
})
