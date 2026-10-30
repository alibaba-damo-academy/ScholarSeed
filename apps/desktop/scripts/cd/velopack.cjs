// Windows installer/package owner. Component archives remain frozen build inputs.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { sha256 } = require('../shared/digest.cjs')
const { verify: verifySignature } = require('./windows-sign.cjs')
const tooling = require('./vpk.cjs')
const { wrapSetup } = require('./setup.cjs')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const VERSION = tooling.VERSION
const DOMAIN = 'scholarseed.velopack-release'
const SCHEMA = 1
const MANIFEST_LIMIT = 32 * 1024 * 1024
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/
const PACK_VERSION = /^(\d+)\.(\d+)\.(\d+)-build\.(\d{12})$/
const CI_NAMES = ['CI', 'GITLAB_CI', 'GITHUB_ACTIONS', 'AONE_CI']
const NO_FILE_EXCLUSION = '(?!)'
function payloadPublicKey(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw, 'base64')]),
    format: 'der',
    type: 'spki',
  })
}

function assertDistinctPayloadKeys(keys, installerKeys) {
  if (!Object.keys(keys).length) return
  const installers = Object.values(installerKeys || {}).map((pem) =>
    crypto.createPublicKey(pem).export({ format: 'der', type: 'spki' })
  )
  for (const raw of Object.values(keys)) {
    const payload = payloadPublicKey(raw).export({ format: 'der', type: 'spki' })
    if (installers.some((installer) => installer.equals(payload)))
      throw new Error('payload and installer signing keys must be distinct')
  }
}


function packVersion(version, build) {
  const result = `${version}-build.${build}`
  if (!PACK_VERSION.test(result)) throw new Error('invalid Velopack product version/build')
  return result
}
function compareVersions(left, right) {
  const a = PACK_VERSION.exec(left), b = PACK_VERSION.exec(right)
  if (!a || !b) throw new Error('invalid Velopack base version')
  for (let i = 1; i < a.length; i++) { if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1 }
  return 0
}
function signingConfiguration(args) {
  if (args.platform !== 'win32' || !args.signed || args.stage === 'backend') return null
  if (!CI_NAMES.some(name => /^(1|true)$/i.test(process.env[name] || ''))) throw new Error('signed Windows packaging is CI-only')
  for (const name of ['payload-public-keys', 'payload-private-key', 'payload-key-id']) {
    if (!args[name]) throw new Error(`signed Windows packaging requires --${name}`)
  }
  if (!KEY_ID.test(args['payload-key-id'])) throw new Error('invalid package signing key ID')
  const stat = fs.statSync(args['payload-private-key'])
  if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('invalid Ed25519 private-key file')
  return { key_id: args['payload-key-id'] }
}
function packageKeys(filename, activationKeys = {}) {
  if (!filename) return {}
  if (fs.statSync(filename).size > 8192) throw new Error('package keys exceed limit')
  const keys = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (!keys || Array.isArray(keys) || typeof keys !== 'object') throw new Error('invalid package keys')
  for (const [id, key] of Object.entries(keys)) { if (!KEY_ID.test(id)) throw new Error('invalid package key ID'); payloadPublicKey(key) }
  assertDistinctPayloadKeys(keys, activationKeys)
  return keys
}
function envelope(manifest, signing, privateKey, keys) {
  const raw = Buffer.from(JSON.stringify(manifest))
  if (raw.length > MANIFEST_LIMIT) throw new Error('Velopack manifest exceeds size limit')
  if (!signing) return { schema: SCHEMA, key_id: '', manifest: raw.toString('base64'), signature: '' }
  const key = crypto.createPrivateKey(fs.readFileSync(privateKey))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('package signing requires Ed25519')
  const signature = crypto.sign(null, raw, key)
  if (!Object.hasOwn(keys, signing.key_id) || !crypto.verify(null, raw, payloadPublicKey(keys[signing.key_id]), signature)) throw new Error('package signer differs from embedded trust root')
  return { schema: SCHEMA, key_id: signing.key_id, manifest: raw.toString('base64'), signature: signature.toString('base64') }
}
function inspect(archive, python, environment) {
  return JSON.parse(execFileSync(python, ['-I', '-B', path.join(__dirname, 'velopack.py'), archive], { env: environment, encoding: 'utf8', maxBuffer: MANIFEST_LIMIT, windowsHide: true }))
}
function packArguments(app, frozen, output, version) {
  // Component trees are already frozen and verified. Override the default PDB
  // regex and disable the separate built-in exclusions so vpk preserves them.
  return ['pack', '--packId', frozen.appId, '--packVersion', version, '--packDir', app.path,
    '--mainExe', `${frozen.productName}.exe`, '--packTitle', frozen.product.config.product_name || frozen.productName,
    '--channel', frozen.product.config.update_channel, '--runtime', 'win-x64', '--outputDir', output,
    '--icon', frozen.icon, '--skip-updates', '--noPortable', '--delta', 'BestSpeed',
    '--exclude', NO_FILE_EXCLUSION, '--noDefaultExclude']
}
function releaseManifest(frozen, version, assets, files, baseVersion) {
  const product = frozen.product.config
  return { domain: DOMAIN, schema: SCHEMA, product_id: product.product_id, bundle_id: product.bundle_id,
    arch_type: frozen.archType, channel: product.update_channel, version: frozen.version,
    build_number: product.build_number, pack_version: version, app_id: frozen.appId,
    base_version: baseVersion, assets: assets.map(({path: _path, ...asset}) => asset), files }
}
async function pack(app, frozen, args, python, environment, branding) {
  if (frozen.platform !== 'win32' || app.content !== 'passed' || !app.package_check?.ok) throw new Error('Velopack requires a verified Windows application')
  const invocation = tooling.invocation(frozen.velopackTools, args, environment)
  const { executable, prefix } = invocation
  environment = invocation.environment
  tooling.check(invocation)
  const output = path.join(frozen.output, 'velopack')
  fs.mkdirSync(output, { recursive: true })
  const version = packVersion(frozen.version, frozen.product.config.build_number)
  let baseVersion = null
  if (args['velopack-base']) {
    const base = path.resolve(args['velopack-base'])
    const previous = inspect(base, python, environment)
    if (previous.app_id !== frozen.appId || compareVersions(previous.version, version) >= 0 || !/-full\.nupkg$/i.test(base)) throw new Error('Velopack delta base must be an earlier full package of this application')
    baseVersion = previous.version
    fs.copyFileSync(base, path.join(output, path.basename(base)), fs.constants.COPYFILE_EXCL)
  }
  const command = packArguments(app, frozen, output, version)
  if (frozen.signingRequired) {
    // vpk signs generated Update/stub/setup as well as our application.
    // The template contains only controlled tool paths; vpk substitutes files.
    const safe = value => { if (/["\r\n%]/.test(value)) throw new Error('unsafe signing command path'); return `"${value}"` }
    command.push('--signTemplate', `${safe(process.execPath)} ${safe(path.join(__dirname, 'velopack-sign.cjs'))} {{file}}`, '--signParallel', '1')
  }
  execFileSync(executable, [...prefix, ...command], { env: { ...environment, ...(frozen.signingRequired ? Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('SCHOLARSEED_WINDOWS_SIGN_'))) : {}) }, stdio: 'inherit', windowsHide: true })
  const feedPath = path.join(output, `releases.${frozen.product.config.update_channel}.json`)
  const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'))
  if (!Array.isArray(feed.Assets)) throw new Error('invalid vpk release feed')
  const selected = feed.Assets.filter(item => item.Version === version)
  if (selected.filter(item => item.Type === 'Full').length !== 1 || selected.filter(item => item.Type === 'Delta').length > 1 || selected.some(item => !['Full', 'Delta'].includes(item.Type))) throw new Error('invalid target Velopack asset set')
  const assets = []
  for (const item of selected) {
    if (path.basename(item.FileName) !== item.FileName || /[\\/:]/.test(item.FileName)) throw new Error('unsafe vpk asset name')
    const filename = path.join(output, item.FileName)
    const digest = await sha256(filename), size = fs.statSync(filename).size
    if (item.Size !== size || String(item.SHA256).toLowerCase() !== digest) throw new Error('vpk release feed differs from final package')
    assets.push({ FileName: item.FileName, Version: version, Type: item.Type, Size: size, SHA256: digest, path: filename })
  }
  const full = assets.find(item => item.Type === 'Full'), delta = assets.find(item => item.Type === 'Delta')
  if (delta && !baseVersion) throw new Error('delta without explicit base')
  const inventory = inspect(full.path, python, environment)
  if (inventory.version !== version || inventory.app_id !== frozen.appId) throw new Error('final package identity mismatch')
  const product = frozen.product.config
  const manifest = releaseManifest(frozen, version, assets, inventory.files, delta ? baseVersion : null)
  const manifestPath = path.join(output, 'velopack.json')
  fs.writeFileSync(manifestPath, JSON.stringify(envelope(manifest, frozen.payloadSigning, args['payload-private-key'], product.update_package_keys))+'\n', { flag: 'wx' })
  // Publish a release-pinned feed, not the preceding release that was only a delta input.
  fs.writeFileSync(feedPath, JSON.stringify({ Assets: selected })+'\n')
  const one = suffix => { const names = fs.readdirSync(output).filter(name => name.endsWith(suffix)); if (names.length !== 1) throw new Error(`expected one Velopack ${suffix}`); return path.join(output, names[0]) }
  const setupPath = one('Setup.exe')
  const directorySelection = await wrapSetup(setupPath, frozen, args, environment, inventory.files, branding)
  if (frozen.signingRequired) {
    verifySignature(setupPath, product.expected_windows_publisher)
  }
  return { schema: SCHEMA, tool_version: VERSION, pack_version: version, channel: product.update_channel,
    app_id: frozen.appId, base_version: manifest.base_version, manifest_path: manifestPath, feed_path: feedPath,
    full_path: full.path, delta_path: delta?.path || null, setup_path: setupPath,
    directory_selection: directorySelection, assets, files: inventory.files, signed: Boolean(frozen.payloadSigning) }
}
module.exports = { VERSION, prepare: tooling.prepare, packVersion, compareVersions, signingConfiguration, packageKeys, envelope, inspect, packArguments, releaseManifest, pack }
