const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { validateTarget, verifyAdmission } = require('../shipit.cjs')

test('ShipIt rejects another Electron release and unsupported platforms before compilation', () => {
  assert.throws(() => validateTarget('win32', 'x64', '44.3.0', '44.3.0'), /native macOS/)
  assert.throws(() => validateTarget('darwin', 'ia32', '44.3.0', '44.3.0'), /native macOS/)
  assert.throws(() => validateTarget('darwin', 'arm64', '44.2.0', '44.3.0'), /does not match/)
})

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
