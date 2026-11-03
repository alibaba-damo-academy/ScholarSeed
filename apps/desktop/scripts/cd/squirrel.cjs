// Compile the pinned in-process updater without rebuilding Electron or its dependencies.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { sha256 } = require('../shared/digest.cjs')
const { SQUIRREL_OVERLAYS } = require('../../native/shipit/overlays.cjs')
const { fingerprint } = require('../../native/shipit/fingerprint.cjs')
const { command, validateTarget, copyHeaders, fetchSource } = require('./shipit.cjs')

const OWNER = path.resolve(__dirname, '../../native/shipit')
const SOURCE_MANIFEST = path.join(OWNER, 'sources.json')
const MINIMUM_MACOS_VERSION = '13.0'
const ARCHITECTURES = { arm64: 'arm64', x64: 'x86_64' }
const INSTALL_NAME = '@rpath/Squirrel.framework/Squirrel'
const COMPILE_UNITS = [
  'NSBundle+SQRLVersionExtensions', 'NSError+SQRLVerbosityExtensions',
  'NSProcessInfo+SQRLVersionExtensions', 'RACSignal+SQRLTransactionExtensions',
  'SQRLAuthorization', 'SQRLCodeSignature', 'SQRLDirectoryManager', 'SQRLDownloadedUpdate',
  'SQRLShipItLauncher', 'SQRLShipItRequest', 'SQRLUpdate', 'SQRLUpdater', 'SQRLZipArchiver',
]
const FRAMEWORKS = [
  'Mantle', 'ReactiveObjC', 'Foundation', 'AppKit', 'CoreServices',
  'CFNetwork', 'CoreFoundation', 'IOKit', 'Security', 'ServiceManagement',
]

function exportsFromNm(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => line.trim().split(/\s+/).at(-1)).sort()
}
function assertAbi(original, replacement) {
  const missing = original.filter(symbol => !replacement.includes(symbol))
  if (missing.length) throw new Error(`Squirrel replacement removes exported ABI: ${missing.join(', ')}`)
}

function validateNativeLog(log) {
  for (const [stage, marker] of [
    ['contract-value', 'CONTRACT_DOWNSTREAM_VALUE'],
    ['contract-terminal', 'CONTRACT_DOWNSTREAM_TERMINAL'],
  ]) {
    const end = log.indexOf(`stage=${stage} event=end`)
    if (end < 0 || log.indexOf(marker) < end) throw new Error('Squirrel timing includes downstream work')
  }
  for (const [stage, result] of [
    ['contract-error', 'error'], ['contract-dispose', 'disposed'],
    ['write-archive', 'success'], ['unarchive', 'success'],
    ['unarchive', 'error'], ['find-bundle', 'error'],
  ]) {
    if (!log.includes(`stage=${stage} event=end result=${result}`))
      throw new Error(`Squirrel native contract missing ${stage}/${result}`)
  }
  const starts = [...log.matchAll(/id=(\d+) stage=([\w-]+) event=start/g)]
  const ends = [...log.matchAll(/id=(\d+) stage=([\w-]+) event=end/g)]
  if (!starts.length || starts.length !== ends.length || starts.some(start =>
    ends.filter(end => end[1] === start[1] && end[2] === start[2]).length !== 1))
    throw new Error('Squirrel native contract has unmatched stage events')
  if (!log.includes('HANDOFF_CONTRACT_PASSED')) throw new Error('Squirrel native fixture did not complete')
}

function verifyGrant(directory, common, executable, frameworks, fixtureFrameworks) {
  const testExecutable = path.join(directory, 'grant-test')
  command('/usr/bin/xcrun', [...common, '-UNDEBUG', '-o', testExecutable,
    path.join(OWNER, 'grant.test.m'), executable,
    ...FRAMEWORKS.flatMap(name => ['-framework', name]),
    `-Wl,-rpath,${fixtureFrameworks}`, `-Wl,-rpath,${frameworks}`], directory)
  command(testExecutable, [path.join(directory, 'grant-fixture')], directory)
}

async function buildSquirrel({ directory, electronDist, arch, sourceCache }) {
  const manifestBytes = fs.readFileSync(SOURCE_MANIFEST)
  const manifest = JSON.parse(manifestBytes)
  const version = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim()
  validateTarget(process.platform, arch, version, manifest.electronVersion)
  if (arch !== process.arch) throw new Error('Squirrel cross-architecture compilation is unsupported')
  fs.mkdirSync(directory, { recursive: true })
  const output = directory
  sourceCache = sourceCache || path.join(directory, 'sources')
  directory = fs.mkdtempSync(path.join(directory, 'build-'))
  const frameworks = path.join(electronDist, 'Electron.app', 'Contents', 'Frameworks')
  const original = path.join(frameworks, 'Squirrel.framework', 'Versions', 'A', 'Squirrel')
  const dependencies = {}
  for (const source of manifest.sources)
    dependencies[source.name] = await fetchSource(source, directory, sourceCache)
  const headers = path.join(directory, 'headers')
  copyHeaders(path.join(dependencies.reactive, 'ReactiveObjC'), path.join(headers, 'ReactiveObjC'))
  copyHeaders(path.join(dependencies.mantle, 'Mantle'), path.join(headers, 'Mantle'))
  const patch = path.join(directory, 'handoff.patch')
  const header = path.join(directory, 'handoff.h')
  fs.copyFileSync(path.join(OWNER, 'handoff.patch'), patch)
  fs.copyFileSync(path.join(OWNER, 'handoff.h'), header)
  command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', patch], directory, dependencies.squirrel)
  const overlays = {}
  for (const name of SQUIRREL_OVERLAYS) {
    const filename = path.join(directory, name)
    fs.copyFileSync(path.join(OWNER, name), filename)
    overlays[name] = await sha256(filename)
  }
  command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(directory, 'readiness.patch')], directory, dependencies.squirrel)
  for (const name of ['binding.patch', 'transfer.patch'])
    command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(directory, name)], directory, dependencies.squirrel)
  const executable = path.join(directory, 'Squirrel.dylib')
  const common = [
    'clang', '-arch', ARCHITECTURES[arch], `-mmacosx-version-min=${MINIMUM_MACOS_VERSION}`,
    '-O2', '-DNDEBUG', '-fobjc-arc', '-fobjc-weak', '-Wno-deprecated-declarations',
    `-I${headers}`, `-I${path.join(dependencies.reactive, 'ReactiveObjC', 'extobjc')}`,
    `-I${directory}`, `-I${path.join(dependencies.squirrel, 'Squirrel')}`, `-F${frameworks}`,
  ]
  command('/usr/bin/xcrun', [
    ...common, '-dynamiclib', '-Wl,-install_name,' + INSTALL_NAME,
    ...FRAMEWORKS.flatMap(name => ['-framework', name]),
    '-o', executable,
    ...COMPILE_UNITS.map(name => path.join(dependencies.squirrel, 'Squirrel', `${name}.m`)),
    path.join(directory, 'readiness.m'),
  ], directory)
  command('/usr/bin/codesign', ['--force', '--sign', '-', executable], directory)
  const exported = filename => exportsFromNm(command('/usr/bin/nm', ['-gU', filename], directory))
  const originalExports = exported(original)
  const replacementExports = exported(executable)
  assertAbi(originalExports, replacementExports)
  const abi = {
    originalExports, replacementExports,
    originalSha256: await sha256(original),
    installName: INSTALL_NAME,
  }
  fs.writeFileSync(path.join(directory, 'abi.json'), JSON.stringify(abi, null, 2) + '\n')
  // Load the actual dylib and run real RAC/ditto/error contracts. No installer or
  // launchd job is started, and the fixture's bundle has no application ID.
  const fixture = path.join(directory, 'handoff.test.m')
  fs.copyFileSync(path.join(OWNER, 'handoff.test.m'), fixture)
  const testExecutable = path.join(directory, 'handoff-test')
  const fixtureFrameworks = path.join(directory, 'frameworks')
  const fixtureFramework = path.join(fixtureFrameworks, 'Squirrel.framework')
  fs.mkdirSync(fixtureFramework, { recursive: true })
  fs.copyFileSync(executable, path.join(fixtureFramework, 'Squirrel'))
  command('/usr/bin/xcrun', [
    ...common, '-UNDEBUG', '-o', testExecutable, fixture, executable,
    ...FRAMEWORKS.flatMap(name => ['-framework', name]),
    `-Wl,-rpath,${fixtureFrameworks}`, `-Wl,-rpath,${frameworks}`,
  ], directory)
  command('/usr/bin/codesign', ['--force', '--sign', '-', testExecutable], directory)
  const nativeResult = spawnSync(testExecutable, [directory], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: directory }, timeout: 60_000,
  })
  const nativeLog = (nativeResult.stdout || '') + (nativeResult.stderr || '')
  fs.writeFileSync(path.join(directory, 'handoff-test.log'), nativeLog)
  if (nativeResult.error || nativeResult.status !== 0)
    throw new Error(`Squirrel native contracts failed: ${nativeResult.error || nativeLog}`)
  validateNativeLog(nativeLog)
  verifyGrant(directory, common, executable, frameworks, fixtureFrameworks)
  const licenses = []
  for (const source of manifest.sources) {
    const filename = path.join(directory, `${source.name}-LICENSE`)
    fs.copyFileSync(path.join(dependencies[source.name], source.license), filename)
    licenses.push({ name: source.name, path: filename, sha256: await sha256(filename) })
  }
  const metadata = {
    schema: 1, electronVersion: version, arch, executable,
    sha256: await sha256(executable), executableDigest: fingerprint(executable),
    sources: manifest.sources.map(({ name, commit, files }) => ({
      name, commit, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    })),
    sourceManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    patchSha256: await sha256(patch), headerSha256: await sha256(header), licenses,
    overlays,
    compiler: command('/usr/bin/xcrun', ['clang', '--version'], directory),
    sdk: command('/usr/bin/xcrun', ['--show-sdk-version'], directory), abi,
  }
  fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
  return metadata
}

module.exports = { buildSquirrel, exportsFromNm, assertAbi, validateNativeLog, verifyGrant }
