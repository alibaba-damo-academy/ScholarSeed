// Native lease artifact preparation. Signing precedes the digest consumed by
// bundling; compiler provenance continues to describe the original bytes.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { compileNative } = require('../shared/native.cjs')
const { timedAsync } = require('../../../../scripts/shared/timing.cjs')
const windows = require('./windows-sign.cjs')
const { LIBRARIES, BUNDLED_LIBRARIES } = require('../../native/libraries.cjs')

const BUILD = 'build.json'
const MANIFEST = 'native.json'
const SCHEMA = 2
const SHA256 = /^[a-f0-9]{64}$/
const SIGN_TIMEOUT = 120000
const MODES = Object.freeze({
  darwin: ['ad-hoc-local-only', 'developer-id'],
  win32: ['unsigned-dev', 'authenticode'],
})

function bytes(filename) {
  const before = fs.lstatSync(filename, { bigint: true })
  const ordinary = (stat) => stat.isFile() && stat.nlink === 1n
  if (!ordinary(before)) throw new Error('native artifact must be a regular single-link file')
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    const same = (stat) =>
      ordinary(stat) &&
      stat.dev === opened.dev &&
      stat.ino === opened.ino &&
      stat.size === opened.size &&
      stat.mtimeNs === opened.mtimeNs &&
      stat.ctimeNs === opened.ctimeNs
    if (!same(before)) throw new Error('native artifact changed while opening')
    const content = fs.readFileSync(descriptor)
    if (
      !same(fs.fstatSync(descriptor, { bigint: true })) ||
      !same(fs.lstatSync(filename, { bigint: true })) ||
      BigInt(content.length) !== opened.size
    )
      throw new Error('native artifact changed while reading')
    return content
  } finally {
    fs.closeSync(descriptor)
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function signingPolicy(platform, signing) {
  if (!signing || !MODES[platform]?.includes(signing.mode))
    throw new Error('explicit native signing mode required for the target platform')
  if (signing.mode === 'developer-id') {
    if (
      typeof signing.identity !== 'string' ||
      !signing.identity.startsWith('Developer ID Application: ') ||
      !/^[A-Z0-9]{10}$/.test(signing.teamId)
    )
      throw new Error('native Developer ID signing requires identity and team')
    return { mode: signing.mode, identity: signing.identity, teamId: signing.teamId }
  }
  if (signing.mode === 'authenticode') {
    if (typeof signing.publisher !== 'string' || !signing.publisher.trim())
      throw new Error('native Authenticode signing requires publisher')
    return { mode: signing.mode, publisher: signing.publisher }
  }
  return { mode: signing.mode }
}

function codesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, {
    encoding: 'utf8',
    timeout: SIGN_TIMEOUT,
    maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0)
    throw new Error(`native codesign failed: ${result.error?.message || result.status}`)
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

function verifySignature(filename, signing, expected) {
  if (!bytes(filename).equals(expected)) throw new Error('native signature input changed')
  checkSignature(filename, signing)
  if (!bytes(filename).equals(expected)) throw new Error('native signature input changed')
}

function checkSignature(filename, signing) {
  if (signing.mode === 'unsigned-dev') return
  if (signing.mode === 'authenticode') {
    windows.verify(filename, signing.publisher)
    return
  }
  codesign(['--verify', '--strict', filename])
  const details = codesign(['--display', '--verbose=4', filename])
  if (signing.mode === 'ad-hoc-local-only') {
    if (!/^Signature=adhoc$/m.test(details)) throw new Error('native ad-hoc signature required')
  } else if (
    !details.includes('flags=0x10000(runtime)') ||
    !/^Timestamp=.+$/m.test(details) ||
    !details.split(/\r?\n/).includes(`Authority=${signing.identity}`) ||
    !details.split(/\r?\n/).includes(`TeamIdentifier=${signing.teamId}`)
  ) {
    throw new Error('native Developer ID signature differs from signing policy')
  }
}

/** Compile into a new directory, sign exact output, then freeze all shipped bytes. */
async function prepareNative({ signing, ...compilation }) {
  const selected = Object.freeze(signingPolicy(process.platform, signing))
  const build = await (process.platform === 'win32'
    ? timedAsync('native.compile', () => compileNative(compilation)) : compileNative(compilation))
  const directory = build.directory
  const buildBytes = bytes(path.join(directory, BUILD))
  const libraries = []
  if (selected.mode === 'authenticode') {
    const inputs = LIBRARIES.map(name => path.join(directory, name))
    for (const [index, library] of inputs.entries()) {
      if (sha256(bytes(library)) !== build.libraries.find(item => item.path === LIBRARIES[index])?.sha256)
        throw new Error('native compiler output changed before signing')
    }
    await windows.signFiles(inputs)
  }
  for (const name of LIBRARIES) {
    const library = path.join(directory, name)
    if (selected.mode !== 'authenticode' &&
        sha256(bytes(library)) !== build.libraries.find(item => item.path === name)?.sha256)
      throw new Error('native compiler output changed before signing')
    if (process.platform === 'darwin') {
      codesign(['--force', '--sign', selected.mode === 'developer-id' ? selected.identity : '-',
        ...(selected.mode === 'developer-id' ? ['--options', 'runtime', '--timestamp'] : []), library])
    }
    const content = bytes(library)
    verifySignature(library, selected, content)
    libraries.push({ path: name, sha256: sha256(content) })
  }
  if (!bytes(path.join(directory, BUILD)).equals(buildBytes))
    throw new Error('native compiler provenance changed during signing')
  const inventory = [
    ...libraries,
    { path: BUILD, sha256: sha256(buildBytes) },
    ...build.licenses,
  ]
  // License bytes are independently checked against compiler provenance before
  // a manifest is published. Only a fully verified artifact returns frozen evidence.
  for (const item of inventory) {
    if (sha256(bytes(path.join(directory, item.path))) !== item.sha256)
      throw new Error('native artifact changed before freezing')
  }
  const manifest = {
    schema: SCHEMA,
    platform: build.platform,
    arch: build.arch,
    signing: selected,
    inventory,
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(directory, MANIFEST), manifestBytes, { flag: 'wx' })
  const frozen = {
    libraries: libraries.map(item => ({ ...item, path: `out/main/${item.path}` })),
    manifestSha256: sha256(manifestBytes),
    platform: build.platform,
    arch: build.arch,
    signing: selected,
  }
  readNative(directory, frozen)
  return Object.freeze(frozen)
}

/** Verify external frozen evidence before supplying bytes to bundling/signing. */
function readNative(directory, frozen, libraryDirectory = directory) {
  if (
    !frozen ||
    !Array.isArray(frozen.libraries) ||
    frozen.libraries.length !== LIBRARIES.length ||
    frozen.libraries.some((item, index) => item.path !== BUNDLED_LIBRARIES[index] || !SHA256.test(item.sha256)) ||
    !SHA256.test(frozen.manifestSha256) ||
    frozen.platform !== process.platform
  )
    throw new Error('invalid frozen native artifact')
  const selected = signingPolicy(frozen.platform, frozen.signing)
  const manifestBytes = bytes(path.join(directory, MANIFEST))
  if (sha256(manifestBytes) !== frozen.manifestSha256)
    throw new Error('native manifest differs from frozen digest')
  const manifest = JSON.parse(manifestBytes)
  if (
    manifest.schema !== SCHEMA ||
    manifest.platform !== frozen.platform ||
    manifest.arch !== frozen.arch ||
    JSON.stringify(manifest.signing) !== JSON.stringify(selected) ||
    !Array.isArray(manifest.inventory)
  )
    throw new Error('native manifest differs from frozen target or signing policy')
  const files = new Map()
  for (const item of manifest.inventory) {
    if (
      typeof item.path !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(item.path) ||
      item.path === MANIFEST ||
      files.has(item.path) ||
      !SHA256.test(item.sha256)
    )
      throw new Error('invalid native artifact inventory')
    const content = bytes(path.join(LIBRARIES.includes(item.path) ? libraryDirectory : directory, item.path))
    if (sha256(content) !== item.sha256)
      throw new Error('native artifact differs from frozen digest')
    files.set(item.path, content)
  }
  if (
    LIBRARIES.some(name => !files.has(name)) ||
    !files.has(BUILD) ||
    fs.readdirSync(directory).length !== files.size + 1 - (libraryDirectory === directory ? 0 : LIBRARIES.length) ||
    frozen.libraries.some(item => sha256(files.get(path.posix.basename(item.path))) !== item.sha256)
  )
    throw new Error('native directory differs from frozen inventory')
  const build = JSON.parse(files.get(BUILD))
  if (
    build.schema !== SCHEMA ||
    build.signed !== false ||
    build.platform !== frozen.platform ||
    build.arch !== frozen.arch ||
    !Array.isArray(build.licenses) ||
    files.size !== build.licenses.length + LIBRARIES.length + 1 ||
    !Array.isArray(build.libraries) || build.libraries.length !== LIBRARIES.length ||
    build.libraries.some((item, index) => item.path !== LIBRARIES[index] || !SHA256.test(item.sha256)) ||
    build.licenses.some(
      (item) => !files.has(item.path) || sha256(files.get(item.path)) !== item.sha256
    ) ||
    (selected.mode === 'unsigned-dev' && build.libraries.some((item, index) => item.sha256 !== frozen.libraries[index].sha256))
  )
    throw new Error('native compiler provenance differs from frozen artifact')
  for (const name of LIBRARIES) verifySignature(path.join(libraryDirectory, name), selected, files.get(name))
  files.set(MANIFEST, manifestBytes)
  return files
}

/** Select one explicit product signing identity, shared with the outer application. */
function productSigning(args) {
  if (!args.signed) return { mode: process.platform === 'darwin' ? 'ad-hoc-local-only' : 'unsigned-dev' }
  if (process.platform === 'win32') return { mode: 'authenticode', publisher: args['windows-publisher'] }
  const teamId = args['team-id']
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error('native signing requires the product team')
  const result = spawnSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', timeout: SIGN_TIMEOUT })
  if (result.error || result.status !== 0) throw new Error('cannot enumerate product signing identities')
  const identities = [...new Set([...result.stdout.matchAll(/"(Developer ID Application: [^"\r\n]+)"/g)].map(match => match[1]))]
    .filter(identity => identity.endsWith(`(${teamId})`))
  if (identities.length !== 1) throw new Error('product team requires exactly one Developer ID Application identity')
  return { mode: 'developer-id', identity: identities[0], teamId }
}

/** Preserve exactly this app's verified library during the outer signing pass. */
function nativeSignatureGuard(app, frozen) {
  const resources = path.join(path.resolve(app), 'Contents', 'Resources')
  const directory = path.join(resources, 'app.asar.unpacked', 'out', 'main')
  const libraries = LIBRARIES.map(name => path.join(directory, name))
  const verify = () => readNative(path.join(resources, 'native'), frozen, directory)
  verify()
  return { ignore: filename => libraries.includes(path.resolve(filename)), verify }
}

module.exports = { prepareNative, readNative, productSigning, nativeSignatureGuard }
