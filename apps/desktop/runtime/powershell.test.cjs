const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  PowerShellProbeError,
  PROBE_SCRIPT,
  artifact,
  parseProbeOutput,
  stagedExecutable,
  stagedRoot
} = require('./powershell.cjs')

const DESKTOP = path.resolve(__dirname, '..')

test('PowerShell manifest freezes the official Windows x64 portable runtime', () => {
  const selected = artifact(DESKTOP, 'win32', 'x64')
  assert.equal(selected.version, '7.6.6')
  assert.equal(selected.archive, path.resolve(DESKTOP, '..', '..', 'scripts', 'vendor', 'powershell',
    'PowerShell-7.6.6-win-x64.zip'))
  assert.equal(selected.entry, 'powershell/pwsh.exe')
  assert.equal(selected.machine, 'x86_64')
  assert.match(selected.url, /^https:\/\/deep-rd\.oss-cn-hangzhou\.aliyuncs\.com\//)
  assert.match(selected.sha256, /^[a-f0-9]{64}$/)
  assert.ok(selected.bytes > 0)
  assert.throws(() => artifact(DESKTOP, 'darwin', 'arm64'), /Windows x64/)
  assert.throws(() => artifact(DESKTOP, 'win32', 'arm64'), /Windows x64/)
})

test('PowerShell staged layout points at the complete portable tree', () => {
  assert.equal(stagedRoot('/resources'), path.join('/resources', 'backend', 'powershell'))
  assert.equal(stagedExecutable('/resources'), path.join('/resources', 'backend', 'powershell', 'pwsh.exe'))
})

test('PowerShell probe uses ASCII only and requires the frozen version', () => {
  assert.doesNotMatch(PROBE_SCRIPT, /ToString|OutputEncoding/)
  assert.match(PROBE_SCRIPT, /PSVersion\.Major/)
  assert.equal(Buffer.byteLength(PROBE_SCRIPT), PROBE_SCRIPT.length)
  assert.deepEqual(parseProbeOutput('7.6.6\r\n', '7.6.6'), { version: '7.6.6' })
  assert.throws(() => parseProbeOutput('7.6.5\n', '7.6.6'), PowerShellProbeError)
})
