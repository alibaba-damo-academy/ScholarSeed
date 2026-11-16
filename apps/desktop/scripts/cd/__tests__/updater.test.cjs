const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { verifyAdmission } = require('../shipit.cjs')
const { assertAbi, validateNativeLog, buildSquirrel } = require('../squirrel.cjs')

const build = process.env.SHIPIT_TEST_BUILD
const electron = process.env.SHIPIT_TEST_ELECTRON
const output = process.env.SHIPIT_TEST_OUTPUT
test('native admission waits for reentry, preserves its deadline, error and disposal', {
  skip: process.platform !== 'darwin' || !build || !electron || !output
    ? 'requires isolated native contract directories' : false,
}, () => {
  fs.mkdirSync(output, { recursive: true })
  verifyAdmission(output, path.join(electron, 'Electron.app', 'Contents', 'Frameworks'), path.join(build, 'headers'))
})
test('real ReactiveObjC timing preserves termination, disposal and per-subscription identity', {
  skip: process.platform !== 'darwin' || !build || !electron || !output
    ? 'requires native macOS and explicit SHIPIT_TEST_BUILD/ELECTRON/OUTPUT directories' : false,
}, () => {
  fs.mkdirSync(output, { recursive: true })
  const executable = path.join(output, 'timing-test')
  const frameworks = path.join(electron, 'Electron.app', 'Contents', 'Frameworks')
  const owner = path.resolve(sourceDirectory, '../../native/shipit')
  const compile = spawnSync('/usr/bin/xcrun', [
    'clang', '-fobjc-arc', '-fobjc-weak', '-Wno-deprecated-declarations',
    `-I${path.join(build, 'headers')}`, `-I${owner}`, `-F${frameworks}`,
    '-framework', 'Foundation', '-framework', 'ReactiveObjC', '-framework', 'AppKit',
    `-Wl,-rpath,${frameworks}`, '-o', executable, path.join(owner, 'timing.test.m'),
  ], { encoding: 'utf8', env: { ...process.env, TMPDIR: output } })
  assert.equal(compile.status, 0, compile.stderr)
  const run = spawnSync(executable, [], { encoding: 'utf8', env: { ...process.env, TMPDIR: output } })
  fs.writeFileSync(path.join(output, 'timing.log'), run.stderr)
  assert.equal(run.status, 0, run.stderr)
  const events = [...run.stderr.matchAll(/id=(\d+) stage=([\w-]+) event=(start|end)(?: result=(\w+))?/g)]
  const starts = events.filter(event => event[3] === 'start')
  const ends = events.filter(event => event[3] === 'end')
  assert.equal(starts.length, 7)
  assert.equal(ends.length, starts.length)
  assert.equal(new Set(starts.map(event => event[1])).size, starts.length)
  for (const start of starts) assert.equal(ends.filter(end => end[1] === start[1]).length, 1)
  assert.equal(ends.find(event => event[2] === 'error')[4], 'error')
  assert.equal(ends.find(event => event[2] === 'dispose')[4], 'disposed')
  assert.ok(run.stderr.indexOf('stage=terminal event=end') < run.stderr.indexOf('DOWNSTREAM_TERMINAL'))
  assert.ok(run.stderr.indexOf('stage=value event=end') < run.stderr.indexOf('DOWNSTREAM_NEXT'))
})

const electronDist = process.env.SQUIRREL_TEST_ELECTRON
const squirrelOutput = process.env.SQUIRREL_TEST_OUTPUT
const sourceCache = process.env.SQUIRREL_TEST_SOURCE_CACHE
test('pinned Squirrel dylib compiles, retains exports, and exercises real RAC and ditto', {
  skip: process.platform !== 'darwin' || !electronDist || !squirrelOutput
    ? 'requires native macOS and explicit SQUIRREL_TEST_ELECTRON/OUTPUT' : false,
}, async () => {
  const result = await buildSquirrel({ directory: squirrelOutput, electronDist, sourceCache, arch: process.arch })
  assert.equal(result.arch, process.arch)
  assert.ok(result.abi.originalExports.length > 0)
  assertAbi(result.abi.originalExports, result.abi.replacementExports)
  assert.equal(fs.statSync(result.executable).isFile(), true)
  validateNativeLog(fs.readFileSync(path.join(path.dirname(result.executable), 'handoff-test.log'), 'utf8'))
})
