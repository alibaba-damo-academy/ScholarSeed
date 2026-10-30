const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { planBuildCleanup, planUserDataCleanup, deleteUserData } = require('../cleanup.cjs')

function fixture(context) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cleanup-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'data')
  for (const directory of [repo, home, path.join(repo, '.venv/bin'), path.join(repo, 'apps/desktop/out'), path.join(repo, 'apps/desktop/node_modules')]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(repo, '.venv/pyvenv.cfg'), 'home = /python\n')
  fs.writeFileSync(path.join(repo, '.venv/bin/python'), '')
  fs.writeFileSync(path.join(home, 'keep'), 'user data')
  return { root, repo, home }
}

function npmFixture(repo) {
  fs.cpSync(path.dirname(sourceDirectory), path.join(repo, 'scripts'), { recursive: true })
  fs.cpSync(path.join(sourceDirectory, '../../apps/desktop/runtime'), path.join(repo, 'apps/desktop/runtime'), { recursive: true })
  fs.cpSync(path.join(sourceDirectory, '../../apps/desktop/scripts'), path.join(repo, 'apps/desktop/scripts'), { recursive: true })
  fs.copyFileSync(path.join(sourceDirectory, '../../apps/desktop/package.json'), path.join(repo, 'apps/desktop/package.json'))
  fs.copyFileSync(path.join(sourceDirectory, '../../package.json'), path.join(repo, 'package.json'))
}

function invokeNpm(repo, home, command, venv = '.venv', args = [], extraEnv = {}) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const invocation = ['clean', 'distclean'].includes(command)
    ? ['run', 'ops', '--', 'pre', 'clean', ...args]
    : ['run', command, '--', ...args]
  return spawnSync(npm, invocation, { cwd: repo, env: { ...process.env, ...extraEnv, VENV: venv, SCHOLARSEED_HOME: home }, encoding: 'utf8', shell: process.platform === 'win32' })
}

function equivalentPaths(directory) {
  return [directory + path.sep, directory + path.sep + path.sep, directory + path.sep + '.', directory + path.sep + '.' + path.sep]
}

test('cleanup API exposes the guarded planners', () => {
  for (const planner of [planBuildCleanup, planUserDataCleanup, deleteUserData]) assert.equal(typeof planner, 'function')
})

test('build planner rejects unsafe venv paths and preserves all targets', context => {
  const { repo, root } = fixture(context)
  for (const venv of ['', '.', '..', root, 'apps', 'missing-custom']) {
    assert.throws(() => planBuildCleanup(repo, venv))
    assert.ok(fs.existsSync(path.join(repo, '.venv/pyvenv.cfg')))
    assert.ok(fs.existsSync(path.join(repo, 'apps/desktop/out')))
  }
})

test('build planner checks every target before deletion and rejects symlinks', context => {
  const { repo, root } = fixture(context)
  fs.symlinkSync(path.join(repo, '.venv'), path.join(repo, 'linked'), 'junction')
  assert.throws(() => planBuildCleanup(repo, 'linked'))
  fs.rmSync(path.join(repo, 'apps/desktop/out'), { recursive: true })
  fs.symlinkSync(root, path.join(repo, 'apps/desktop/out'), 'junction')
  assert.throws(() => planBuildCleanup(repo, '.venv'))
  assert.ok(fs.existsSync(path.join(repo, '.venv/pyvenv.cfg')))
  fs.rmSync(path.join(repo, 'apps/desktop/out'))
  fs.rmSync(path.join(repo, 'apps/desktop'), { recursive: true })
  fs.symlinkSync(root, path.join(repo, 'apps/desktop'), 'junction')
  assert.throws(() => planBuildCleanup(repo, '.venv'))
})

test('valid venv identity and absent default build targets are supported', context => {
  const { repo } = fixture(context)
  assert.deepEqual(planBuildCleanup(repo, '.venv'), ['.venv', 'apps/desktop/node_modules', 'apps/desktop/out'].map(target => path.join(repo, target)))
  fs.rmSync(path.join(repo, '.venv'), { recursive: true })
  assert.equal(planBuildCleanup(repo, '.venv').length, 3)
  fs.mkdirSync(path.join(repo, 'custom/Scripts'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'custom/pyvenv.cfg'), 'home = python')
  fs.writeFileSync(path.join(repo, 'custom/Scripts/python.exe'), '')
  assert.equal(planBuildCleanup(repo, 'custom')[0], path.join(repo, 'custom'))
})

test('user data preview is readonly and exact confirmation is required', context => {
  const { repo, home, root } = fixture(context)
  assert.deepEqual(planUserDataCleanup(repo, home), { path: home, exists: true })
  for (const confirmation of [undefined, '', home + path.sep, path.relative(repo, home)]) {
    assert.throws(() => deleteUserData(repo, home, confirmation))
    assert.ok(fs.existsSync(path.join(home, 'keep')))
  }
  for (const unsafe of ['', '.', '..', root, repo, os.homedir(), path.parse(home).root, path.join(repo, 'data')]) assert.throws(() => planUserDataCleanup(repo, unsafe))
  fs.symlinkSync(home, path.join(root, 'linked'), 'junction')
  assert.throws(() => planUserDataCleanup(repo, path.join(root, 'linked')))
  assert.throws(() => planUserDataCleanup(repo, path.join(root, 'linked/child')))
  deleteUserData(repo, home, home)
  assert.deepEqual(planUserDataCleanup(repo, home), { path: home, exists: false })
  deleteUserData(repo, home, home)
})

test('root npm cleanup entries protect home and reject mixed unsafe targets', context => {
  const { repo, home } = fixture(context)
  npmFixture(repo)
  const invoke = (command, venv, args = []) => invokeNpm(repo, home, command, venv, args)
  for (const venv of ['.', '..', home, 'apps']) {
    assert.notEqual(invoke('clean', venv).status, 0)
    assert.ok(fs.existsSync(path.join(repo, '.venv/pyvenv.cfg')))
    assert.ok(fs.existsSync(path.join(repo, 'apps/desktop/out')))
  }
  const distclean = invoke('distclean', '.venv')
  assert.equal(distclean.status, 0, distclean.stderr)
  assert.ok(fs.existsSync(path.join(home, 'keep')))
  assert.equal(invoke('user-data:preview', '.venv').status, 0)
  assert.notEqual(invoke('user-data:delete', '.venv', ['--confirm', home + path.sep]).status, 0)
  assert.ok(fs.existsSync(path.join(home, 'keep')))
  assert.equal(invoke('user-data:delete', '.venv', ['--confirm', home]).status, 0)
  assert.equal(fs.existsSync(home), false)
})

test('equivalent protected repo and system home paths are rejected', context => {
  const { repo, home } = fixture(context)
  for (const protectedDirectory of [repo, os.homedir()]) {
    for (const equivalent of equivalentPaths(protectedDirectory)) assert.throws(() => planUserDataCleanup(repo, equivalent), equivalent)
  }
  for (const equivalentRepo of equivalentPaths(repo)) assert.throws(() => planUserDataCleanup(equivalentRepo, repo), equivalentRepo)
  for (const equivalent of equivalentPaths(home)) {
    assert.deepEqual(planUserDataCleanup(repo, equivalent), { path: home, exists: true })
    assert.throws(() => deleteUserData(repo, equivalent, equivalent))
    assert.ok(fs.existsSync(path.join(home, 'keep')))
  }
  deleteUserData(repo, home + path.sep, home)
  assert.equal(fs.existsSync(home), false)
})

test('root npm user data entries reject equivalent protected paths and preserve sentinels', context => {
  const { repo, home, root } = fixture(context)
  npmFixture(repo)
  const systemHome = path.join(root, 'system-home')
  fs.mkdirSync(systemHome)
  fs.writeFileSync(path.join(systemHome, 'keep'), 'system home sentinel')
  fs.writeFileSync(path.join(repo, 'keep'), 'repo sentinel')
  const homeEnv = { HOME: systemHome, USERPROFILE: systemHome }
  for (const protectedDirectory of [repo, systemHome]) {
    for (const equivalent of equivalentPaths(protectedDirectory)) {
      for (const command of ['user-data:preview', 'user-data:delete']) {
        const args = command === 'user-data:delete' ? ['--confirm', equivalent] : []
        const result = invokeNpm(repo, equivalent, command, '.venv', args, homeEnv)
        assert.notEqual(result.status, 0, `${command}: ${equivalent}`)
        assert.ok(fs.existsSync(path.join(repo, 'keep')))
        assert.ok(fs.existsSync(path.join(systemHome, 'keep')))
        assert.ok(fs.existsSync(path.join(home, 'keep')))
      }
    }
  }
})

test('root npm clean and distclean preflight later invalid targets before any deletion', context => {
  const { repo, home, root } = fixture(context)
  npmFixture(repo)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep'), 'external sentinel')
  fs.writeFileSync(path.join(repo, 'apps/desktop/node_modules/keep'), 'dependency sentinel')
  fs.rmSync(path.join(repo, 'apps/desktop/out'), { recursive: true })
  fs.symlinkSync(outside, path.join(repo, 'apps/desktop/out'), 'junction')
  for (const command of ['clean', 'distclean']) {
    const result = invokeNpm(repo, home, command)
    assert.notEqual(result.status, 0, result.stderr)
    assert.ok(fs.existsSync(path.join(repo, '.venv/pyvenv.cfg')))
    assert.ok(fs.existsSync(path.join(repo, '.venv/bin/python')))
    assert.ok(fs.existsSync(path.join(repo, 'apps/desktop/node_modules/keep')))
    assert.ok(fs.existsSync(path.join(outside, 'keep')))
    assert.ok(fs.existsSync(path.join(home, 'keep')))
  }
})
