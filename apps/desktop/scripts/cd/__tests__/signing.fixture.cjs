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
  const [root, operation, kindFlag, kind, targetFlag, target, versionFlag, version, keyFlag, key, archiveFlag, archive] = process.argv.slice(1)
  if (kindFlag !== '--kind' || !['electron', 'frameworks', 'python', 'texlive'].includes(kind) ||
      targetFlag !== '--target' || !['darwin-arm64', 'darwin-x86_64'].includes(target) ||
      versionFlag !== '--version' || !/^[a-z0-9][a-z0-9.-]*-r[1-9][0-9]*$/.test(version) ||
      keyFlag !== '--key' || archiveFlag !== '--archive' || !/^[a-f0-9]{64}$/.test(key) || !path.isAbsolute(archive))
    throw new Error('invalid provider arguments')
  const folder = path.join(root, target, kind, version)
  const entry = path.join(folder, 'component.zip')
  const receipt = path.join(folder, 'receipt.json')
  if (fs.existsSync(receipt) && JSON.parse(fs.readFileSync(receipt)).inputSha256 !== key)
    throw new Error('cache version already bound to another input')
  let code = 0
  if (operation === 'fetch' || operation === 'recover') {
    if (fs.existsSync(entry) && (operation === 'recover' || fs.existsSync(receipt)))
      fs.copyFileSync(entry, archive, fs.constants.COPYFILE_EXCL)
    else code = 3
  } else if (operation === 'confirm') {
    if (!fs.existsSync(receipt)) code = 3
    else if (!fs.readFileSync(archive).equals(fs.readFileSync(entry))) code = 4
  } else if (operation === 'publish') {
    fs.mkdirSync(folder, {recursive: true})
    try {
      fs.copyFileSync(archive, entry, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!fs.readFileSync(archive).equals(fs.readFileSync(entry))) code = fs.existsSync(receipt) ? 4 : 5
    }
    if (code === 0 && !fs.existsSync(receipt)) fs.writeFileSync(receipt, JSON.stringify({inputSha256: key}), {flag: 'wx'})
  } else throw new Error('unknown operation')
  fs.appendFileSync(path.join(root, 'calls'), operation + ' ' + code + '\n')
  process.exitCode = code
}

function registryCommand(registry) {
  return JSON.stringify([process.execPath, '-e', '(' + registryProvider.toString() + ')()', '--', registry])
}

module.exports = { entitlements, keychain, temporary, registryCommand }
