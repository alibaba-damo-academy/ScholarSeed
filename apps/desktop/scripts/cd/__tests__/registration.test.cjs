const sourceDirectory = require('node:path').dirname(__dirname)
const { test } = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { assertCleanInstallation } = require('../registration.cjs')

for (const hive of ['CurrentUser', 'LocalMachine']) {
  for (const view of ['Registry64', 'Registry32']) {
    for (const kind of ['velopack', 'nsis-install', 'nsis-uninstall']) {
      test(`preflight rejects ${hive}/${view}/${kind}, including partial registration`, t => {
        const records = [{ hive, view, kind }]
        t.mock.method(childProcess, 'execFileSync', () => JSON.stringify(records))
        const logs = []
        t.mock.method(console, 'log', line => logs.push(line))
        assert.throws(() => assertCleanInstallation('scholarseed'), /prevents isolated acceptance/)
        assert(logs.some(line => line.includes(JSON.stringify(records))))
        assert(logs.some(line => line.includes('"status":"failed"')))
      })
    }
  }
}
test('empty registry query passes and uses fixed preflight script with argument array', t => {
  const query = t.mock.method(childProcess, 'execFileSync', () => '\uFEFF[]\r\n')
  assertCleanInstallation('scholarseed', { SystemRoot: 'C:/Windows', HOME: 'unused' })
  const [executable, args, options] = query.mock.calls[0].arguments
  assert.equal(executable, path.join('C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  assert(args.includes('-NonInteractive'))
  assert.equal(args.at(-1), 'scholarseed')
  assert.equal(options.timeout, 30000)
  assert.equal(options.shell, undefined)
})
for (const output of ['', '{}', '[{"kind":"nsis-install"}]']) {
  test(`malformed query fails closed: ${JSON.stringify(output)}`, t => {
    t.mock.method(childProcess, 'execFileSync', () => output)
    assert.throws(() => assertCleanInstallation('scholarseed'))
  })
}
test('query access failure propagates and does not launch another process', t => {
  const error = Object.assign(new Error('access denied'), { code: 'EACCES' })
  const query = t.mock.method(childProcess, 'execFileSync', () => { throw error })
  assert.throws(() => assertCleanInstallation('scholarseed'), e => e === error)
  assert.equal(query.mock.calls.length, 1)
})
test('invalid identity is rejected before starting PowerShell', t => {
  const query = t.mock.method(childProcess, 'execFileSync')
  assert.throws(() => assertCleanInstallation('x;Remove-Item'), /invalid/)
  assert.equal(query.mock.calls.length, 0)
})
test('historical NSIS identity remains aligned with the native migration owner', () => {
  const script = fs.readFileSync(path.join(sourceDirectory, 'registration.ps1'), 'utf8')
  const native = fs.readFileSync(path.join(sourceDirectory, '../../updater/cmd/setup/legacy.go'), 'utf8')
  const guid = native.match(/const legacyGUID = "([a-f0-9-]+)"/)[1]
  assert(script.includes(`$legacyId = '${guid}'`))
})


test('native Windows registry remediation uses an isolated test-owned namespace', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-registration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = childProcess.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'registration.test.ps1'), '-TaskRoot', root], { encoding: 'utf8', timeout: 30000 })
  assert.match(output, /PASS native registry remediation/)
})
