const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { createRuntimeSigningPolicy } = require('../mac-sign-policy.cjs')

const { entitlements, keychain, temporary } = require('./signing.fixture.cjs')

const darwin = process.platform === 'darwin'

function fixtureCertificate(dir) {
  const cert = path.join(dir, 'cert.pem')
  cp.execFileSync('/usr/bin/openssl', ['req', '-newkey', 'rsa:2048', '-x509', '-nodes',
    '-subj', '/CN=Developer ID Application: Fixture (ABCDEF1234)/OU=ABCDEF1234',
    '-days', '1', '-keyout', path.join(dir, 'fixture.key'), '-out', cert], {stdio: 'ignore'})
  return new crypto.X509Certificate(fs.readFileSync(cert))
}

test('bind the resolved identity, entitlement bytes and effective per-file policy', {skip: !darwin}, t => {
  const app = temporary(t)
  const cert = fixtureCertificate(app)
  const {options, frozen} = keychain(t, cert, 2)
  options.app = app
  const group = {files: ['bin'], bundles: []}
  const make = () => createRuntimeSigningPolicy(options, frozen).forGroup(group)
  const digest = make().digest
  const alternate = path.join(app, 'alternate.plist')
  fs.writeFileSync(alternate, fs.readFileSync(entitlements, 'utf8').replace('allow-jit', 'something-else'))
  options.optionsForFile = () => ({entitlements: alternate})
  assert.notEqual(make().digest, digest)
  options.optionsForFile = () => ({entitlements, additionalArguments: ['--identifier', 'override']})
  assert.equal(make(), null)
  options.optionsForFile = () => ({entitlements, timestamp: 'none'})
  assert.equal(make(), null)
  options.identity = frozen.native.signing.identity
  assert.throws(make, /identity/)
})

test('reject ad hoc Mach-O under a Developer ID cache policy', {skip: !darwin}, t => {
  const app = temporary(t)
  const {options, frozen} = keychain(t, fixtureCertificate(app))
  options.app = app
  const binary = path.join(app, 'true')
  fs.copyFileSync('/usr/bin/true', binary)
  cp.execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', '--entitlements', entitlements, binary], {stdio: 'pipe'})
  const group = createRuntimeSigningPolicy(options, frozen).forGroup({files: ['true'], bundles: []})
  assert.throws(() => group.verify(), /signature|codesign/)
})
