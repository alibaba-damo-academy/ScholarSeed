const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runInstaller, engineEvidence, recordInstallerFailure } = require('../installation.cjs')

for (const code of [0, 2]) {
  test(`NSIS invocation records actual exit ${code} and retains diagnostics`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-installation-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const log = path.join(directory, 'install.json')
    const lines = []
    t.mock.method(console, 'log', (line) => lines.push(line))
    const run = () => runInstaller(process.execPath, ['-e',
      `console.log('[nsis] phase=process-check code=0'); console.error('installer detail'); process.exit(${code})`,
    ], { timeout: 10000, env: { ...process.env, SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT: path.join(directory, 'retained') } }, log)
    if (code === 0) assert.equal(run().status, 0)
    else assert.throws(run, /NSIS installation failed: 2;.*install.json/)
    const evidence = JSON.parse(fs.readFileSync(log, 'utf8'))
    assert.equal(evidence.status, code)
    assert.match(evidence.stderr, /installer detail/)
    assert.match(evidence.stdout, /phase=process-check/)
    assert.ok(lines.includes('[nsis] phase=process-check code=0'))
    assert.equal(lines.some((line) => line.includes('installer detail')), code !== 0)
    const end = lines.filter((line) => line.startsWith('[stage] '))
      .map((line) => JSON.parse(line.slice('[stage] '.length))).filter((record) => record.event === 'end')
    assert.equal(end.length, 1)
    assert.equal(end[0].status, code === 0 ? 'passed' : 'failed')
  })
}

test('NSIS launch failure and timeout retain failure evidence and fail the stage', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-installation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const lines = []
  t.mock.method(console, 'log', (line) => lines.push(line))
  for (const [executable, args, expected] of [
    [path.join(directory, 'missing.exe'), [], 'ENOENT'],
    [process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], 'ETIMEDOUT'],
  ]) {
    const log = path.join(directory, `${expected}.json`)
    assert.throws(() => runInstaller(executable, args, { timeout: 100, env: { ...process.env, SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT: path.join(directory, 'retained') } }, log), new RegExp(expected))
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).error.code, expected)
  }
  const ends = lines.filter((line) => line.includes('"event":"end"'))
  assert.equal(ends.length, 2)
  assert.ok(ends.every((line) => line.includes('"status":"failed"')))
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-diagnostics-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const build = path.join(directory, 'build')
  fs.mkdirSync(build)
  const log = path.join(build, 'velopack-install.json')
  const env = { ...process.env, SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT: path.join(directory, 'retained') }
  const lines = []
  t.mock.method(console, 'log', line => lines.push(line))
  return { directory, build, log, env, lines }
}
const records = lines => lines.filter(line => line.startsWith('[installer-diagnostic] '))
  .map(line => JSON.parse(line.slice('[installer-diagnostic] '.length)))

test('Velopack native log and both streams survive deletion of the CI build directory', t => {
  const { directory, build, log, env, lines } = fixture(t)
  const script = path.join(directory, 'installer.cjs')
  fs.writeFileSync(script, `const fs=require('node:fs'); const args=process.argv.slice(2);
    fs.writeFileSync(args[args.indexOf('--log')+1], 'native installation root rejected');
    console.log('engine starting'); console.error('wrapper rejected directory'); process.exit(1)`)
  assert.throws(() => runInstaller(process.execPath, [script], { env }, log, 'Velopack', { nativeLog: true }), /installation failed: 1/)
  const retained = records(lines).find(record => record.event === 'retained').path
  fs.rmSync(build, { recursive: true })
  const evidence = JSON.parse(fs.readFileSync(retained, 'utf8'))
  assert.equal(evidence.status, 1)
  assert.match(evidence.stdout, /engine starting/)
  assert.match(evidence.stderr, /wrapper rejected/)
  assert.equal(evidence.engineLog.text, 'native installation root rejected')
  assert(records(lines).some(record => record.stream === 'native' && record.text === evidence.engineLog.text))
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(retained).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.dirname(retained)).mode & 0o777, 0o700)
  }
})

test('failure output is bounded, redacted before truncation, and safely JSON escaped', t => {
  const { log, env, lines } = fixture(t)
  env.TEST_TOKEN = 'unique-secret-value'
  const secret = 'Bearer abc.def.secret https://example.test/file?Signature=signed-secret password="hidden phrase" unique-secret-value'
  const text = 'x'.repeat(20000) + '\n' + secret + '\n[stage] forged\u001b[31m'
  assert.throws(() => runInstaller(process.execPath, ['-e', `console.error(${JSON.stringify(text)});process.exit(3)`], { env }, log, 'Velopack'), /failed: 3/)
  const record = records(lines).find(record => record.stream === 'stderr')
  assert.equal(record.truncated, true)
  assert(Buffer.byteLength(record.text) <= 16384)
  const output = lines.join('\n')
  for (const value of ['abc.def.secret', 'signed-secret', 'hidden phrase', 'unique-secret-value']) assert(!output.includes(value))
  assert(!lines.some(line => line.startsWith('[stage] forged')))
  assert(!output.includes('\u001b'))
})

test('retention failure and primary evidence write failure preserve the original installer exit', t => {
  const { directory, log, env, lines } = fixture(t)
  const blocked = path.join(directory, 'blocked')
  fs.writeFileSync(blocked, 'file')
  env.SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT = blocked
  assert.throws(() => runInstaller(process.execPath, ['-e', 'process.exit(7)'], { env }, path.join(blocked, 'result.json'), 'Velopack'), /installation failed: 7/)
  assert(records(lines).some(record => record.event === 'evidence-write-failed'))
  assert(records(lines).some(record => record.event === 'retention-failed'))
})

test('wrapper failure before engine launch records the missing native log', t => {
  const { log, env, lines } = fixture(t)
  assert.throws(() => runInstaller(process.execPath, ['-e', 'process.exit(1)', '--'], { env }, log, 'Velopack', { nativeLog: true }), /failed: 1/)
  assert.equal(JSON.parse(fs.readFileSync(log)).engineLog.error, 'ENOENT')
  assert(records(lines).some(record => record.nativeLogError === 'ENOENT'))
})

test('configured cache uses a unique persistent sibling for each failed invocation', t => {
  const { directory, log, env, lines } = fixture(t)
  delete env.SCHOLARSEED_INSTALLER_DIAGNOSTICS_ROOT
  env.SCHOLARSEED_BUILD_CACHE_ROOT = path.join(directory, 'cache')
  for (let i = 0; i < 2; i++) assert.throws(() => runInstaller(process.execPath, ['-e', 'process.exit(1)'], { env }, log, 'Velopack'))
  const paths = records(lines).filter(record => record.event === 'retained').map(record => record.path)
  assert.equal(paths.length, 2)
  assert.notEqual(paths[0], paths[1])
  assert(paths.every(p => p.startsWith(path.join(directory, 'installer-diagnostics') + path.sep)))
})

test('existing native log is not overwritten or attributed to a new invocation', t => {
  const { log, env } = fixture(t)
  fs.writeFileSync(log + '.engine.log', 'earlier evidence')
  const evidence = runInstaller(process.execPath, ['-e', 'process.exit(0)', '--'], { env }, log, 'Velopack', { nativeLog: true })
  assert.notEqual(evidence.engineLog.path, log + '.engine.log')
  assert.equal(evidence.engineLog.error, 'ENOENT')
  assert.equal(fs.readFileSync(log + '.engine.log', 'utf8'), 'earlier evidence')
})

test('oversized native log retains a bounded tail with original byte count', t => {
  const { directory, log, env, lines } = fixture(t)
  const script = path.join(directory, 'large-log.cjs')
  fs.writeFileSync(script, `const fs=require('node:fs'); const args=process.argv.slice(2);
    fs.writeFileSync(args[args.indexOf('--log')+1], 'x'.repeat(5*1024*1024)+'failure at end'); process.exit(1)`)
  assert.throws(() => runInstaller(process.execPath, [script], { env }, log, 'Velopack', { nativeLog: true }))
  const evidence = JSON.parse(fs.readFileSync(log, 'utf8'))
  assert.equal(evidence.engineLog.bytes, 5 * 1024 * 1024 + 'failure at end'.length)
  assert.equal(evidence.engineLog.truncated, true)
  assert.equal(Buffer.byteLength(evidence.engineLog.text), 4 * 1024 * 1024)
  assert(evidence.engineLog.text.endsWith('failure at end'))
  const record = records(lines).find(record => record.stream === 'native')
  assert.equal(record.truncated, true)
  assert(record.text.endsWith('failure at end'))
})

test('retirement failure preserves native evidence after a successful asynchronous launch', t => {
  const { directory, build, log, env, lines } = fixture(t)
  env.TEST_TOKEN = 'retirement-private-token'
  const launched = runInstaller(process.execPath, ['-e', 'process.exit(0)'], { env }, log, 'Velopack', { operation: 'uninstall-launch' })
  const native = path.join(directory, 'velopack.log')
  fs.writeFileSync(native, 'hook completed; deletion failed retirement-private-token')
  const failedLog = path.join(build, 'retirement.json')
  recordInstallerFailure({ ...launched, phase: 'uninstall-retirement',
    error: { code: 'UNINSTALL_RETIREMENT_TIMEOUT', message: 'installation remains' },
    retirement: { complete: false, remaining: ['runtime', 'Update.exe'] },
    engineLog: engineEvidence(native),
  }, failedLog, env)
  fs.rmSync(build, { recursive: true })
  fs.unlinkSync(native)
  const evidence = JSON.parse(fs.readFileSync(records(lines).find(record => record.event === 'retained').path))
  assert.equal(evidence.status, 0) // Original launch verdict is not rewritten.
  assert.equal(evidence.phase, 'uninstall-retirement')
  assert.equal(evidence.error.code, 'UNINSTALL_RETIREMENT_TIMEOUT')
  assert.deepEqual(evidence.retirement.remaining, ['runtime', 'Update.exe'])
  assert.match(evidence.engineLog.text, /deletion failed/)
  assert(!JSON.stringify(evidence).includes(env.TEST_TOKEN))
  assert(lines.some(line => line.includes('uninstall-launch passed')))
  assert(!lines.some(line => line.includes('installation passed')))
})
