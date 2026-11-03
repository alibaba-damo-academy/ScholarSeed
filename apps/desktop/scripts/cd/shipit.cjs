// Build only the pinned Electron ShipIt helper; reuse Electron's dependency frameworks.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { sha256 } = require('../shared/digest.cjs')
const { fingerprint } = require('../../native/shipit/fingerprint.cjs')
const { ensureArtifact } = require('../../../../scripts/shared/artifacts.cjs')
const { SHIPIT_OVERLAYS } = require('../../native/shipit/overlays.cjs')

const OWNER = path.resolve(__dirname, '../../native/shipit')
const SOURCE_MANIFEST = path.join(OWNER, 'sources.json')
const DOWNLOAD_TIMEOUT_MS = 30_000
const DOWNLOAD_CONCURRENCY = 6
const MINIMUM_MACOS_VERSION = '13.0'
const ARCHITECTURES = { arm64: 'arm64', x64: 'x86_64' }
const COMPILE_UNITS = [
  'NSBundle+SQRLVersionExtensions', 'NSError+SQRLVerbosityExtensions',
  'NSProcessInfo+SQRLVersionExtensions', 'RACSignal+SQRLTransactionExtensions',
  'SQRLCodeSignature', 'SQRLInstaller', 'SQRLInstallerOwnedBundle',
  'SQRLShipItRequest', 'SQRLTerminationListener', 'ShipIt-main',
]
const FRAMEWORKS = ['Mantle', 'ReactiveObjC', 'Foundation', 'AppKit', 'IOKit', 'Security']
const RPATHS = ['@executable_path/../..', '@executable_path/../../../..']
const TIMING_TEST_SPANS = 7

function command(executable, args, directory, cwd = directory) {
  const result = spawnSync(executable, args, {
    cwd, env: { ...process.env, TMPDIR: directory }, encoding: 'utf8',
  })
  if (result.error || result.status !== 0)
    throw new Error(`ShipIt command failed: ${executable}: ${result.error || result.stderr}`)
  return result.stdout.trim()
}

function validateTarget(platform, arch, electronVersion, expectedVersion) {
  if (platform !== 'darwin' || !Object.hasOwn(ARCHITECTURES, arch))
    throw new Error('ShipIt compilation requires a supported native macOS architecture')
  if (electronVersion !== expectedVersion)
    throw new Error('ShipIt source does not match the Electron distribution version')
}

function copyHeaders(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const filename = path.join(source, entry.name)
    if (entry.isDirectory()) copyHeaders(filename, destination)
    else if (entry.isFile() && entry.name.endsWith('.h')) {
      const target = path.join(destination, entry.name)
      if (fs.existsSync(target) && !fs.readFileSync(target).equals(fs.readFileSync(filename)))
        throw new Error(`Conflicting ShipIt dependency header: ${entry.name}`)
      fs.copyFileSync(filename, target)
    }
  }
}

function verifyNativeTiming(directory, frameworks, headers) {
  const fixture = path.join(directory, 'timing.test.m')
  fs.copyFileSync(path.join(OWNER, 'timing.test.m'), fixture)
  const executable = path.join(directory, 'timing-test')
  command('/usr/bin/xcrun', [
    'clang', '-fobjc-arc', '-fobjc-weak', '-Wno-deprecated-declarations',
    `-I${headers}`, `-F${frameworks}`, '-framework', 'Foundation',
    '-framework', 'ReactiveObjC', '-framework', 'AppKit',
    `-Wl,-rpath,${frameworks}`, '-o', executable, fixture,
  ], directory)
  const result = spawnSync(executable, [], { encoding: 'utf8', env: { ...process.env, TMPDIR: directory } })
  fs.writeFileSync(path.join(directory, 'timing-test.log'), result.stderr || '')
  if (result.error || result.status !== 0) throw new Error('ShipIt native timing contract failed')
  const events = [...result.stderr.matchAll(/id=(\d+) stage=([\w-]+) event=(start|end)(?: result=(\w+))?/g)]
  const starts = events.filter(event => event[3] === 'start')
  const ends = events.filter(event => event[3] === 'end')
  if (starts.length !== TIMING_TEST_SPANS || ends.length !== starts.length ||
      new Set(starts.map(event => event[1])).size !== starts.length ||
      starts.some(start => ends.filter(end => end[1] === start[1]).length !== 1) ||
      ends.find(event => event[2] === 'error')?.[4] !== 'error' ||
      ends.find(event => event[2] === 'dispose')?.[4] !== 'disposed')
    throw new Error('ShipIt native timing events violate subscription/terminal contracts')
  for (const [stage, marker] of [['terminal', 'DOWNSTREAM_TERMINAL'], ['value', 'DOWNSTREAM_NEXT']]) {
    const end = result.stderr.indexOf(`stage=${stage} event=end`)
    const downstream = result.stderr.indexOf(marker)
    if (end < 0 || downstream < 0 || end >= downstream)
      throw new Error('ShipIt timing includes synchronous downstream work')
  }
}

function verifyAdmission(directory, frameworks, headers) {
  const executable = path.join(directory, 'admission-test')
  command('/usr/bin/xcrun', [
    'clang', '-fobjc-arc', '-fobjc-weak', '-Werror', '-Wno-deprecated-declarations',
    `-I${headers}`, `-I${OWNER}`, `-F${frameworks}`, '-framework', 'Foundation',
    '-framework', 'ReactiveObjC', `-Wl,-rpath,${frameworks}`,
    '-o', executable, path.join(OWNER, 'admission.test.m'),
  ], directory)
  command(executable, [], directory)
}

function verifyCleanup(directory) {
  for (const name of ['cleanup', 'path']) {
    const fixture = path.join(directory, `${name}.test.m`)
    fs.copyFileSync(path.join(OWNER, `${name}.test.m`), fixture)
    const executable = path.join(directory, `${name}-test`)
    command('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-framework', 'Foundation',
      path.join(directory, 'cleanup.m'), path.join(directory, 'preparation.m'), path.join(directory, 'readiness.m'), fixture, '-o', executable], directory)
    const result = spawnSync(executable, [path.join(directory, `${name}-fixture`)], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: directory },
    })
    fs.writeFileSync(path.join(directory, `${name}-test.log`), (result.stdout || '') + (result.stderr || ''))
    if (result.error || result.status !== 0) throw new Error(`ShipIt ${name} contract failed`)
  }
}

function verifyBinding(directory, frameworks, headers, source) {
  const executable = path.join(directory, 'binding-test')
  command('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wno-deprecated-declarations',
    `-I${headers}`, `-I${OWNER}`, `-I${path.join(source, 'Squirrel')}`, `-F${frameworks}`,
    '-framework', 'Foundation', '-framework', 'Mantle', '-framework', 'ReactiveObjC',
    `-Wl,-rpath,${frameworks}`, path.join(source, 'Squirrel', 'SQRLShipItRequest.m'),
    path.join(OWNER, 'preparation.m'), path.join(OWNER, 'readiness.m'), path.join(OWNER, 'binding.test.m'), '-o', executable], directory)
  command(executable, [path.join(directory, 'binding-fixture')], directory)
}

function verifyPreparation(directory) {
  for (const name of ['preparation', 'readiness', 'terminal']) {
    const fixture = path.join(directory, `${name}.test.m`)
    fs.copyFileSync(path.join(OWNER, `${name}.test.m`), fixture)
    const executable = path.join(directory, `${name}-test`)
    command('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-framework', 'Foundation', ...(name === 'readiness' ? ['readiness'] : ['preparation', 'readiness']).map(unit => path.join(directory, `${unit}.m`)), fixture, '-o', executable], directory)
    const result = spawnSync(executable, [path.join(directory, `${name}-fixture`)], {
      encoding: 'utf8', env: { ...process.env, TMPDIR: directory }, timeout: 60_000,
    })
    fs.writeFileSync(path.join(directory, `${name}-test.log`), (result.stdout || '') + (result.stderr || ''))
    if (result.error || result.status !== 0) throw new Error(`ShipIt ${name} contract failed: ${result.error || result.stderr}`)
  }
}

async function fetchSource(source, directory, sourceCache) {
  const extracted = path.join(directory, source.name)
  fs.mkdirSync(extracted)
  let next = 0
  const results = await Promise.allSettled(Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
    while (next < source.files.length) {
      const entry = source.files[next++]
      if (!/^[a-f0-9]{64}$/.test(entry.sha256) || path.isAbsolute(entry.path) || entry.path.split('/').includes('..'))
        throw new Error('Invalid pinned ShipIt source entry')
      const target = path.join(extracted, entry.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const cached = path.join(sourceCache, source.name, entry.path)
      if (!fs.existsSync(cached)) {
        await ensureArtifact(cached, {
          url: `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${entry.path}`,
          sha256: entry.sha256, bytes: entry.bytes,
        }, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
      }
      if (await sha256(cached) !== entry.sha256)
        throw new Error(`ShipIt source cache digest mismatch: ${source.name}/${entry.path}`)
      fs.copyFileSync(cached, target)
      if (await sha256(target) !== entry.sha256)
        throw new Error(`ShipIt source digest mismatch: ${source.name}/${entry.path}`)
    }
  }))
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length) throw new AggregateError(failures, 'ShipIt source preparation failed')
  return extracted
}

async function buildShipIt({ directory, electronDist, arch, sourceCache }) {
  const manifestBytes = fs.readFileSync(SOURCE_MANIFEST)
  const manifest = JSON.parse(manifestBytes)
  const version = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim()
  validateTarget(process.platform, arch, version, manifest.electronVersion)
  if (arch !== process.arch) throw new Error('ShipIt cross-architecture compilation is unsupported')
  fs.mkdirSync(directory, { recursive: true })
  const output = directory
  sourceCache = sourceCache || path.join(directory, 'sources')
  directory = fs.mkdtempSync(path.join(directory, 'build-'))
  const frameworks = path.join(electronDist, 'Electron.app', 'Contents', 'Frameworks')
  const dependencies = {}
  for (const source of manifest.sources)
    dependencies[source.name] = await fetchSource(source, directory, sourceCache)
  const headers = path.join(directory, 'headers')
  copyHeaders(path.join(dependencies.reactive, 'ReactiveObjC'), path.join(headers, 'ReactiveObjC'))
  copyHeaders(path.join(dependencies.mantle, 'Mantle'), path.join(headers, 'Mantle'))
  const patch = path.join(directory, 'timing.patch')
  const header = path.join(directory, 'timing.h')
  fs.copyFileSync(path.join(OWNER, 'timing.patch'), patch)
  fs.copyFileSync(path.join(OWNER, 'timing.h'), header)
  command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', patch], directory, dependencies.squirrel)
  const overlays = {}
  for (const name of SHIPIT_OVERLAYS) {
    const filename = path.join(directory, name)
    fs.copyFileSync(path.join(OWNER, name), filename)
    overlays[name] = await sha256(filename)
  }
  command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(directory, 'cleanup.patch')], directory, dependencies.squirrel)
  command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(directory, 'preparation.patch')], directory, dependencies.squirrel)
  command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(directory, 'admission.patch')], directory, dependencies.squirrel)
  for (const name of ['binding.patch', 'authorization.patch', 'recovery.patch'])
    command('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', '-i', path.join(directory, name)], directory, dependencies.squirrel)
  const executable = path.join(directory, 'ShipIt')
  const args = [
    'clang', '-arch', ARCHITECTURES[arch], `-mmacosx-version-min=${MINIMUM_MACOS_VERSION}`,
    '-O2', '-DNDEBUG',
    '-fobjc-arc', '-fobjc-weak', '-Wno-deprecated-declarations', '-Wno-block-capture-autoreleasing',
    `-I${headers}`, `-I${path.join(dependencies.reactive, 'ReactiveObjC', 'extobjc')}`,
    `-I${directory}`, `-F${frameworks}`,
    ...FRAMEWORKS.flatMap(name => ['-framework', name]),
    ...RPATHS.map(value => `-Wl,-rpath,${value}`),
    '-o', executable,
    ...COMPILE_UNITS.map(name => path.join(dependencies.squirrel, 'Squirrel', `${name}.m`)),
    path.join(directory, 'cleanup.m'), path.join(directory, 'preparation.m'), path.join(directory, 'readiness.m'),
  ]
  command('/usr/bin/xcrun', args, directory)
  command('/usr/bin/codesign', ['--force', '--sign', '-', executable], directory)
  verifyNativeTiming(directory, frameworks, headers)
  verifyAdmission(directory, frameworks, headers)
  verifyBinding(directory, frameworks, headers, dependencies.squirrel)
  verifyCleanup(directory)
  verifyPreparation(directory)
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
    sdk: command('/usr/bin/xcrun', ['--show-sdk-version'], directory),
  }
  fs.writeFileSync(path.join(output, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

module.exports = { buildShipIt, validateTarget, command, copyHeaders, fetchSource, verifyAdmission, verifyBinding }
