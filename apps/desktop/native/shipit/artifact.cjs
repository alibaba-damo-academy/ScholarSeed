const fs = require('node:fs')
const path = require('node:path')
const { sha256 } = require('../../scripts/shared/digest.cjs')
const { fingerprint } = require('./fingerprint.cjs')
const { SHIPIT_OVERLAYS, SQUIRREL_OVERLAYS } = require('./overlays.cjs')

const EXECUTABLE = 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt'
const FRAMEWORK = 'Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel'
const BINARIES = { shipit: EXECUTABLE, squirrel: FRAMEWORK }
const EVIDENCE = 'Contents/Resources/shipit'
const RECEIPT = 'build.json'
const HASH = /^[a-f0-9]{64}$/

function binaryMetadata(value, arch, expectedOverlays) {
  if (!value || value.schema !== 1 || !HASH.test(value.sha256) ||
      !HASH.test(value.executableDigest) || !HASH.test(value.patchSha256) ||
      !HASH.test(value.headerSha256) || !Array.isArray(value.licenses) || !value.licenses.length ||
      !Array.isArray(value.sources) || !value.sources.length ||
      value.arch !== arch)
    throw new Error('missing or invalid frozen ShipIt evidence')
  const overlays = value.overlays
  if (!overlays || Object.keys(overlays).length !== expectedOverlays.length ||
      expectedOverlays.some(name => !HASH.test(overlays[name])))
    throw new Error('missing or invalid frozen native overlays')
  const names = new Set()
  const licenses = value.licenses.map(license => {
    const name = path.basename(license.path)
    if (!/^[A-Za-z0-9._-]+$/.test(name) || names.has(name) || !HASH.test(license.sha256))
      throw new Error('invalid ShipIt license inventory')
    names.add(name)
    return { name, sha256: license.sha256 }
  })
  return {
    schema: value.schema, electronVersion: value.electronVersion, arch: value.arch,
    sha256: value.sha256, executableDigest: value.executableDigest,
    sources: value.sources, patchSha256: value.patchSha256, headerSha256: value.headerSha256,
    sourceManifestSha256: value.sourceManifestSha256,
    ...(value.abi ? { abi: value.abi } : {}),
    licenses, overlays,
  }
}

function metadata(frozen) {
  const arch = frozen.arch === 'x86_64' ? 'x64' : frozen.arch
  const helper = binaryMetadata(frozen.shipit, arch, SHIPIT_OVERLAYS)
  const squirrel = binaryMetadata(frozen.squirrel, arch, SQUIRREL_OVERLAYS)
  if (helper.electronVersion !== squirrel.electronVersion)
    throw new Error('ShipIt and Squirrel Electron versions differ')
  if (JSON.stringify(helper.licenses) !== JSON.stringify(squirrel.licenses))
    throw new Error('ShipIt and Squirrel license inventories differ')
  return { ...helper, squirrel }
}

function regularInside(application, filename) {
  const root = fs.realpathSync(application)
  const actual = fs.realpathSync(filename)
  if (!actual.startsWith(root + path.sep) || !fs.lstatSync(filename).isFile())
    throw new Error('ShipIt artifact is not a regular file in the output application')
}

// Called only by afterPack, before the existing nested signing pass.
async function install(application, frozen) {
  if (frozen.platform !== 'darwin') return
  const receipt = metadata(frozen)
  for (const [name, relative] of Object.entries(BINARIES)) {
    if (!fs.lstatSync(frozen[name].executable).isFile() ||
        await sha256(frozen[name].executable) !== frozen[name].sha256)
      throw new Error(`frozen ${name} executable changed before packaging`)
    regularInside(application, path.join(application, relative))
  }
  for (const [name, relative] of Object.entries(BINARIES)) {
    const destination = path.join(application, relative)
    fs.copyFileSync(frozen[name].executable, destination)
    fs.chmodSync(destination, 0o755)
  }
  const directory = path.join(application, EVIDENCE)
  fs.mkdirSync(directory, { recursive: false })
  for (let index = 0; index < receipt.licenses.length; index++) {
    const license = frozen.shipit.licenses[index]
    if (!fs.lstatSync(license.path).isFile() || await sha256(license.path) !== license.sha256)
      throw new Error('ShipIt license changed before packaging')
    fs.copyFileSync(license.path, path.join(directory, receipt.licenses[index].name))
  }
  fs.writeFileSync(path.join(directory, RECEIPT), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  await verify(application, frozen, false)
}

async function verify(application, frozen, signed) {
  if (frozen.platform !== 'darwin') return
  const expected = metadata(frozen)
  for (const [name, relative] of Object.entries(BINARIES)) {
    const value = name === 'shipit' ? expected : expected.squirrel
    const filename = path.join(application, relative)
    regularInside(application, filename)
    fs.accessSync(filename, fs.constants.X_OK)
    if (signed ? fingerprint(filename) !== value.executableDigest : await sha256(filename) !== value.sha256)
      throw new Error(`packaged ${name} differs from the frozen native build`)
  }
  const receipt = path.join(application, EVIDENCE, RECEIPT)
  regularInside(application, receipt)
  if (JSON.stringify(JSON.parse(fs.readFileSync(receipt, 'utf8'))) !== JSON.stringify(expected))
    throw new Error('packaged ShipIt build evidence changed')
  for (const license of expected.licenses) {
    const filename = path.join(application, EVIDENCE, license.name)
    regularInside(application, filename)
    if (await sha256(filename) !== license.sha256) throw new Error('packaged ShipIt license changed')
  }
}

module.exports = { install, verify, metadata, EXECUTABLE, FRAMEWORK, EVIDENCE }
