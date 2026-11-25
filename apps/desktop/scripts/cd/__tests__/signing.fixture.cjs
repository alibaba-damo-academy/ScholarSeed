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

// Run in a separate Node process to exercise the actual argv/exit-code boundary.
function registryProvider() {
  const fs = require('node:fs')
  const path = require('node:path')
  const [root, operation, kindFlag, kind, targetFlag, target, keyFlag, key, archiveFlag, archive] = process.argv.slice(1)
  if (kindFlag !== '--kind' || !['electron', 'frameworks', 'python', 'texlive'].includes(kind) ||
      targetFlag !== '--target' || !['darwin-arm64', 'darwin-x86_64'].includes(target) || keyFlag !== '--key' || archiveFlag !== '--archive' || !/^[a-f0-9]{64}$/.test(key) || !path.isAbsolute(archive))
    throw new Error('invalid provider arguments')
  const entry = path.join(root, kind, target, key)
  let code = 0
  if (operation === 'fetch') {
    if (fs.existsSync(entry)) fs.copyFileSync(entry, archive, fs.constants.COPYFILE_EXCL)
    else code = 3
  } else if (operation === 'publish') {
    fs.mkdirSync(path.dirname(entry), {recursive: true})
    try {
      fs.copyFileSync(archive, entry, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!fs.readFileSync(archive).equals(fs.readFileSync(entry))) code = 4
    }
  } else throw new Error('unknown operation')
  fs.appendFileSync(path.join(root, 'calls'), operation + ' ' + code + '\n')
  process.exitCode = code
}

function registryCommand(registry) {
  return JSON.stringify([process.execPath, '-e', '(' + registryProvider.toString() + ')()', '--', registry])
}

module.exports = { entitlements, keychain, temporary, registryCommand }
