const { SHIPIT_OVERLAYS, SQUIRREL_OVERLAYS } = require('./overlays.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { fingerprint } = require('./fingerprint.cjs')
const { install, verify, FRAMEWORK } = require('./artifact.cjs')
const { sha256 } = require('../../scripts/shared/digest.cjs')

test('real Mach-O re-sign preserves fingerprint; signed loader mutation is rejected', { skip: process.platform !== 'darwin' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipit-fingerprint-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const env = { ...process.env, TMPDIR: directory }
  const run = (exe, args) => execFileSync(exe, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const executable = path.join(directory, 'ShipIt')
  const source = path.join(directory, 'probe.c')
  fs.writeFileSync(source, 'int main(void) { return 0; }\n')
  run('/usr/bin/xcrun', ['clang', source, '-Wl,-rpath,@executable_path/../liba', '-o', executable])
  run('/usr/bin/codesign', ['--force', '--sign', '-', executable])
  const expected = fingerprint(executable)
  const license = path.join(directory, 'LICENSE')
  fs.writeFileSync(license, 'test license')
  const digest = await sha256(license)
  const frozen = { platform: 'darwin', arch: process.arch, shipit: {
    schema: 1, electronVersion: '44.3.0', arch: process.arch, executable,
    sha256: await sha256(executable), executableDigest: expected,
    patchSha256: digest, headerSha256: digest,
    sources: [{ name: 'test', commit: 'a'.repeat(40), sha256: digest }],
    licenses: [{ path: license, sha256: digest }],
    overlays: Object.fromEntries(SHIPIT_OVERLAYS.map(name => [name, digest])),
  } }
  frozen.squirrel = { ...frozen.shipit, overlays: Object.fromEntries(SQUIRREL_OVERLAYS.map(name => [name, digest])) }
  const app = path.join(directory, 'Test.app')
  const helper = path.join(app, 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt')
  fs.mkdirSync(path.dirname(helper), { recursive: true })
  fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true })
  fs.writeFileSync(helper, 'placeholder')
  const framework = path.join(app, FRAMEWORK)
  fs.mkdirSync(path.dirname(framework), { recursive: true })
  fs.writeFileSync(framework, 'placeholder')
  await install(app, frozen)
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'test.shipit.new', helper])
  run('/usr/bin/codesign', ['--verify', '--strict', helper])
  assert.equal(fingerprint(helper), expected)
  await verify(app, frozen, true)
  const bytes = fs.readFileSync(helper)
  const marker = Buffer.from('@executable_path/../liba')
  const offset = bytes.indexOf(marker)
  assert.ok(offset >= 32)
  bytes[offset + marker.length - 1] = 'b'.charCodeAt(0)
  fs.writeFileSync(helper, bytes)
  run('/usr/bin/codesign', ['--force', '--sign', '-', helper])
  run('/usr/bin/codesign', ['--verify', '--strict', helper])
  assert.notEqual(fingerprint(helper), expected)
  await assert.rejects(verify(app, frozen, true), /differs/)
  fs.appendFileSync(helper, 'extra')
  assert.throws(() => fingerprint(helper), /terminal code-signature/)
})
