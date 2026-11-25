// Admission policy for the nested Developer ID signatures restored by the CI signer.
const cp = require('node:child_process')
const {createHash, X509Certificate} = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {isDeepStrictEqual} = require('node:util')

const CODESIGN = '/usr/bin/codesign'
const SECURITY = '/usr/bin/security'
const INTERMEDIATE = 'certificate 1[field.1.2.840.113635.100.6.2.6]'
const APPLICATION = 'certificate leaf[field.1.2.840.113635.100.6.1.13]'
const SIGNING_CHAIN = `anchor apple generic and ${INTERMEDIATE} and ${APPLICATION}`

function command(program, args, input) {
  const result = cp.spawnSync(program, args, {encoding: 'utf8', input, timeout: 120_000, maxBuffer: 4 * 1024 * 1024})
  if (result.error || result.status !== 0)
    throw new Error(`macOS signing cache: ${path.basename(program)} failed: ${result.error?.message || result.stderr.trim()}`)
  return result
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function verifiedSigningTeam(options, signing) {
  if (signing?.mode !== 'developer-id' || !/^[A-Z0-9]{10}$/.test(signing.teamId) ||
      !signing.identity.startsWith('Developer ID Application: ') || options.platform !== 'darwin' ||
      options.type !== 'distribution' || typeof options.identity !== 'string')
    throw new Error('Invalid macOS cache signing identity')
  const scope = options.keychain ? [options.keychain] : []
  const result = command(SECURITY, ['find-identity', '-v', '-p', 'codesigning', ...scope]).stdout
  const hits = [...result.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\r\n]+)"/gm)]
    .filter(([, sha1, name]) => name === signing.identity &&
      (options.identity === name || sha1.toUpperCase() === options.identity.toUpperCase()))
  const hashes = [...new Set(hits.map(hit => hit[1].toUpperCase()))]
  if (hashes.length !== 1) throw new Error('Cannot resolve a unique macOS cache signing identity')
  const pem = command(SECURITY, ['find-certificate', '-a', '-c', signing.identity, '-p', ...scope]).stdout
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []) {
    const cert = new X509Certificate(block)
    const subject = cert.toLegacyObject().subject
    if (cert.fingerprint.replaceAll(':', '') === hashes[0] &&
        subject.CN === signing.identity && subject.OU === signing.teamId)
      return signing.teamId
  }
  throw new Error('Selected Developer ID certificate does not match the configured signing identity and team')
}

function plistValue(data) {
  return JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], data).stdout)
}

function frameworkExecutables(targets) {
  const info = new Map()
  for (const bundle of targets) {
    const plist = plistValue(fs.readFileSync(path.join(bundle, 'Resources', 'Info.plist')))
    if (!plist.CFBundleIdentifier || !plist.CFBundleExecutable)
      throw new Error('Missing framework signing metadata: ' + bundle)
    const executable = fs.realpathSync(path.join(bundle, plist.CFBundleExecutable))
    if (!executable.startsWith(fs.realpathSync(bundle) + path.sep))
      throw new Error('Invalid executable of cached framework: ' + bundle)
    const member = {identifier: plist.CFBundleIdentifier, executable}
    info.set(bundle, member)
    info.set(executable, member)
  }
  return info
}

function binaryIdentifier(filename, arch) {
  // Security.framework's MachORep takes CFBundleIdentifier from __info_plist.
  // Without one, DiskRep::canonicalIdentifier strips a nonnumeric extension
  // and keeps the first number of a trailing version (libfoo.2.3 -> libfoo.2).
  const embedded = command('/usr/bin/otool', ['-arch', arch, '-X', '-P', filename]).stdout.trim()
  if (embedded) {
    const identifier = plistValue(embedded).CFBundleIdentifier
    if (identifier) return identifier
  }
  const name = path.basename(filename).replace(/\.[^\d.][^.]*$/, '')
  if (/^[\d.]/.test(name)) return name
  return name.replace(/([^\d.]\.?\d*)[\d.]*$/, '$1')
}

function verifySignature(target, framework, expected, signing, decoded) {
  // Apply the Apple Developer ID requirement to every slice, independent of
  // what the cache object declares about its own signing requirements.
  const {team, requirement} = signing
  command(CODESIGN, ['--verify', '--strict', '--all-architectures', '-R', `=${requirement}`, target])
  const executable = framework?.executable || target
  const archs = command('/usr/bin/lipo', ['-archs', executable]).stdout.trim().split(/\s+/)
  for (const arch of archs) {
    const {stdout, stderr} = command(CODESIGN, ['--display', '--architecture', arch, '--verbose=4', '-r-',
      '--xml', '--entitlements', '-', target])
    const identifier = /^Identifier=(.+)$/m.exec(stderr)?.[1]
    if (identifier !== (framework?.identifier || binaryIdentifier(executable, arch)))
      throw new Error(`Cached signature identifier differs from the signing input: ${target} (${arch})`)
    const end = stdout.indexOf('\n')
    const designated = stdout.slice(0, end).replaceAll(' /* exists */', '')
    const required = ` and ${requirement}`
    const lines = stderr.split(/\r?\n/)
    if (!identifier || end < 0 ||
        ![`designated => identifier ${identifier}${required}`, `designated => identifier "${identifier}"${required}`].includes(designated) ||
        !/^CodeDirectory .* flags=0x10000\(runtime\) /m.test(stderr) || !/^Timestamp=.+$/m.test(stderr) ||
        !/^Authority=Developer ID Application: .+$/m.test(stderr) || !lines.includes('TeamIdentifier=' + team))
      throw new Error(`Cached signature differs from the Developer ID policy: ${target} (${arch})`)
    const xml = stdout.slice(end + 1)
    if (!decoded.has(xml)) decoded.set(xml, plistValue(xml))
    if (!isDeepStrictEqual(expected, decoded.get(xml)))
      throw new Error(`Cached entitlements differ from the signing policy: ${target} (${arch})`)
  }
}

function createRuntimeSigningPolicy(options, frozen) {
  const team = verifiedSigningTeam(options, frozen.native.signing)
  const signing = {team, requirement: `${SIGNING_CHAIN} and certificate leaf[subject.OU] = ${team}`}
  // Fingerprint the actual tools, independent of per-runner installation paths.
  const allocator = command('/usr/bin/xcrun', ['--find', 'codesign_allocate']).stdout.trim()
  const sources = [CODESIGN, '/usr/bin/codesign_allocate', allocator, __filename, ...['signer.cjs', 'macho.cjs', 'osx-sign.cjs'].map(name => path.join(__dirname, name)),
    require.resolve('@electron/osx-sign/dist/cjs/sign'), require.resolve('@electron/osx-sign/dist/cjs/util')]
  if (process.env.CODESIGN_ALLOCATE) sources.push(process.env.CODESIGN_ALLOCATE)
  const policy = {signing, electron: options.version, system: command('/usr/bin/sw_vers', ['-buildVersion']).stdout.trim(),
    recipe: sources.map(filename => digest(fs.readFileSync(filename)))}
  const entitlements = new Map()
  return {
    forGroup({files, bundles}) {
      const members = []
      for (const [bundle, names] of [[false, files], [true, bundles]]) {
        for (const relative of [...names].sort()) {
          const filename = path.resolve(options.app, relative)
          if (path.relative(options.app, filename) !== relative || !filename.startsWith(options.app + path.sep))
            throw new Error('Invalid nested signing target')
          const settings = options.optionsForFile?.(filename)
          // osx-sign's default flags/timestamp are runtime and --timestamp. A
          // future, unmodelled signing policy can still take the ordinary pass.
          if (options.ignore?.(filename) || !settings || typeof settings.entitlements !== 'string' ||
              (settings.hardenedRuntime !== undefined && settings.hardenedRuntime !== true) || settings.timestamp || settings.requirements ||
              settings.signatureFlags || settings.additionalArguments?.length) return null
          const filenameOfPlist = settings.entitlements
          if (!entitlements.has(filenameOfPlist)) {
            const data = fs.readFileSync(filenameOfPlist)
            entitlements.set(filenameOfPlist, {digest: digest(data), value: plistValue(data)})
          }
          members.push({relative, filename, bundle, entitlements: entitlements.get(filenameOfPlist)})
        }
      }
      return {
        digest: digest(JSON.stringify([policy, members.map(m => [m.relative, m.bundle, m.entitlements.digest])])),
        verify() {
          const decoded = new Map()
          const frameworks = frameworkExecutables(members.filter(m => m.bundle).map(m => m.filename))
          for (const member of members) {
            verifySignature(member.filename, frameworks.get(member.filename) || frameworks.get(fs.realpathSync(member.filename)),
              member.entitlements.value, signing, decoded)
          }
        },
      }
    },
  }
}

module.exports = {createRuntimeSigningPolicy}
