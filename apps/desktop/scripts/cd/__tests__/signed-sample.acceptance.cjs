const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const { createRuntimeSigningPolicy } = require('../mac-sign-policy.cjs')

const { entitlements, keychain, temporary } = require('./signing.fixture.cjs')

test('verify a distribution framework and all slices of a TeX executable', t => {
  const app = process.env.SCHOLARSEED_SIGNED_RUNTIME_SAMPLE
  assert.equal(process.platform, 'darwin', 'signed sample acceptance requires macOS')
  assert.ok(app, 'set SCHOLARSEED_SIGNED_RUNTIME_SAMPLE to the signed distribution app')
  const dir = temporary(t)
  const framework = 'Contents/Frameworks/Electron Framework.framework'
  const tex = 'Contents/Resources/backend/texlive/bin/universal-darwin/pdftex'
  const prefix = path.join(dir, 'cert')
  cp.execFileSync('/usr/bin/codesign', ['--display', '--extract-certificates=' + prefix, path.join(app, framework)], {stdio: 'pipe'})
  const cert = new crypto.X509Certificate(fs.readFileSync(prefix + '0'))
  const {options, frozen} = keychain(t, cert)
  options.app = app
  const group = {files: [tex], bundles: [framework]}
  const make = () => createRuntimeSigningPolicy(options, frozen).forGroup(group)
  make().verify()
  // The original CMS, timestamp and entitlements still verify under another
  // filename, while codesign would choose a different identifier for it.
  const renamed = path.join(dir, 'renamed')
  fs.copyFileSync(path.join(app, tex), renamed)
  const misplaced = createRuntimeSigningPolicy({...options, app: dir}, frozen)
    .forGroup({files: ['renamed'], bundles: []})
  assert.throws(() => misplaced.verify(), /identifier/)
  const changed = path.join(dir, 'changed.plist')
  fs.writeFileSync(changed, fs.readFileSync(entitlements, 'utf8').replace('allow-jit', 'allow-other'))
  options.optionsForFile = () => ({entitlements: changed})
  assert.throws(() => make().verify(), /entitlements/)
})
