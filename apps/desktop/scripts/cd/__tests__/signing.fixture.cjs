const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const entitlements = path.join(__dirname, '../../../resources/entitlements.mac.plist')

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-policy-'))
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}))
  return dir
}

function keychain(t, cert, identityCount = 1) {
  const { CN: identity, OU: teamId } = cert.toLegacyObject().subject
  const hash = cert.fingerprint.replaceAll(':', '')
  const spawn = cp.spawnSync
  t.mock.method(cp, 'spawnSync', (tool, args, options) => {
    if (tool !== '/usr/bin/security') return spawn(tool, args, options)
    const output = args[0] === 'find-identity'
      ? Array.from({length: identityCount}, (_, i) => `  ${i+1}) ${i ? 'F'.repeat(40) : hash} "${identity}"`).join('\n')
      : cert.toString()
    return {status: 0, stdout: output, stderr: ''}
  })
  return {
    options: {identity: hash, type: 'distribution', platform: 'darwin', optionsForFile: () => ({entitlements, hardenedRuntime: true})},
    frozen: {native: {signing: {identity, teamId, mode: 'developer-id'}}},
  }
}

module.exports = { entitlements, keychain, temporary }
