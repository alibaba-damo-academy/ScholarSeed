const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { compileNative, nativeSourceFiles } = require('../shared/native.cjs')
const { libraries } = require('../../native/libraries.cjs')

const SOURCE_ROOT = path.resolve(__dirname, '../../native')
const COMPILE_UNITS = [
  'shipit/preflight.m',
  'shipit/preparation.m',
  'shipit/cleanup.m',
  'shipit/readiness.m',
  'directory.c',
]
const ARCHITECTURES = { arm64: 'arm64', x64: 'x86_64' }
const COMPILER = '/usr/bin/xcrun'
const COMPILER_FLAGS = [
  '--sdk',
  'macosx',
  'clang',
  '--no-default-config',
  '-fobjc-arc',
  '-fblocks',
  '-Wno-deprecated-declarations',
  '-mmacosx-version-min=13.0',
  '-framework',
  'Foundation',
  '-framework',
  'AppKit',
]
const EXECUTABLE = 'scholarseed-recovery-probe'
const MANIFEST = 'manifest.json'
const SCHEMA = 1
const PRIVATE_DIRECTORY_MODE = 0o700
const MANIFEST_MODE = 0o600
const EXECUTABLE_MODE = 0o500
const PERMISSION_MASK = 0o7777
const SOURCE_LIMIT = 8 * 1024 * 1024
const MANIFEST_LIMIT = 1024 * 1024
const EXECUTABLE_LIMIT = 32 * 1024 * 1024
const COMPILE_TIMEOUT_MS = 120_000
const COMPILER_OUTPUT_LIMIT = 4 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const REPOSITORY = path.resolve(__dirname, '../../../..')
const BUILDER = path.resolve(__dirname, '../shared/native.cjs')
const RECIPE = path.join(__dirname, 'recovery.cjs')
const POLICY = path.join(SOURCE_ROOT, 'toolchain.json')
const MAINTENANCE_MANIFEST = 'maintenance.json'
const MAINTENANCE_SCHEMA = 1
const MAINTENANCE_KIND = 'recovery-maintenance'
const NATIVE_DIRECTORY = 'native'
const NATIVE_RECEIPT = 'build.json'
const NATIVE_RECEIPT_SCHEMA = 2
const LEASE_ADDON = 'lease.node'
const TERMINAL_ADDON = 'terminal.node'
const TERMINAL_UNITS = ['shipit/bridge.m', ...COMPILE_UNITS.slice(1)]
const TAR = '/usr/bin/tar'
const ARTIFACT_LIMIT = 64 * 1024 * 1024
const SOURCE_MODULES = [RECIPE, BUILDER, path.resolve(__dirname, '../pre/security.cjs')]

function target() {
  if (process.platform !== 'darwin' || !Object.hasOwn(ARCHITECTURES, process.arch)) {
    throw new Error('recovery probe requires a supported native macOS architecture')
  }
}

function absoluteOutput(output) {
  if (typeof output !== 'string' || !path.isAbsolute(output)) {
    throw new Error('recovery probe output requires an explicit absolute directory')
  }
  return path.resolve(output)
}

function noLinkedAncestors(filename) {
  let current = filename
  for (;;) {
    const stat = fs.lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('recovery probe requires directories without symbolic links')
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

function privateDirectory(directory) {
  noLinkedAncestors(directory)
  const stat = fs.lstatSync(directory)
  if (stat.uid !== process.getuid() || (stat.mode & PERMISSION_MASK) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error('recovery probe directory must be private and owned by the current user')
  }
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & PERMISSION_MASK }
}

function sameDirectory(directory, expected) {
  if (JSON.stringify(privateDirectory(directory)) !== JSON.stringify(expected)) {
    throw new Error('recovery probe output directory identity changed')
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readRegular(filename, limit, mode) {
  noLinkedAncestors(path.dirname(filename))
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  )
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.uid !== BigInt(process.getuid()) ||
      stat.size > BigInt(limit) ||
      (mode === undefined
        ? Number(stat.mode) & 0o022
        : (Number(stat.mode) & PERMISSION_MASK) !== mode)
    ) {
      throw new Error(
        'recovery probe requires a bounded, owned, regular single-link file with safe permissions'
      )
    }
    const buffer = Buffer.alloc(Number(stat.size) + 1)
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    const after = fs.fstatSync(descriptor, { bigint: true })
    const located = fs.lstatSync(filename, { bigint: true })
    if (
      BigInt(length) !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.uid !== stat.uid ||
      after.mode !== stat.mode ||
      after.nlink !== stat.nlink ||
      after.mtimeNs !== stat.mtimeNs ||
      after.ctimeNs !== stat.ctimeNs ||
      located.dev !== stat.dev ||
      located.ino !== stat.ino ||
      located.isSymbolicLink()
    ) {
      throw new Error('recovery probe file changed while reading')
    }
    const bytes = buffer.subarray(0, length)
    return {
      bytes,
      identity: {
        device: Number(stat.dev),
        inode: Number(stat.ino),
        uid: Number(stat.uid),
        nlink: Number(stat.nlink),
        mode: Number(stat.mode) & PERMISSION_MASK,
        bytes: bytes.length,
        sha256: digest(bytes),
      },
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function nativeFilesSnapshot(units) {
  const entries = new Map()
  function collect(relative) {
    const filename = path.resolve(SOURCE_ROOT, relative)
    const inside = path.relative(SOURCE_ROOT, filename)
    if (
      !inside ||
      inside === '..' ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    ) {
      throw new Error('recovery probe source include escapes the native owner')
    }
    const name = inside.split(path.sep).join('/')
    if (entries.has(name)) return
    const { bytes, identity } = readRegular(filename, SOURCE_LIMIT)
    entries.set(name, { path: name, bytes, sha256: identity.sha256 })
    const text = bytes.toString('utf8')
    for (const match of text.matchAll(/^\s*#\s*(?:import|include)\s+([^\r\n]+)/gm)) {
      const operand = match[1].trim()
      if (operand.startsWith('<')) continue
      const local = /^"([^"\r\n]+)"\s*(?:\/\/.*)?$/.exec(operand)
      if (!local || local[1].includes('\\') || path.isAbsolute(local[1])) {
        throw new Error('recovery probe source uses an unsupported local include')
      }
      collect(path.join(path.dirname(inside), local[1]))
    }
  }
  for (const relative of units) collect(relative)
  const files = [...entries.values()].sort((first, second) => first.path.localeCompare(second.path))
  return files
}

function sourceSnapshot() {
  const files = nativeFilesSnapshot(COMPILE_UNITS)
  const sources = files.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes.length,
    sha256: entry.sha256,
  }))
  const recipe = {
    compiler: COMPILER,
    flags: COMPILER_FLAGS,
    units: COMPILE_UNITS,
    arch: ARCHITECTURES[process.arch],
  }
  return { files, sources, fingerprint: digest(JSON.stringify({ recipe, sources })) }
}

function assertSources(snapshot) {
  if (sourceSnapshot().fingerprint !== snapshot.fingerprint) {
    throw new Error('recovery probe source fingerprint changed during compilation')
  }
}

function resolveRecoveryProbe(output) {
  target()
  const directory = absoluteOutput(output)
  const directoryIdentity = privateDirectory(directory)
  const manifest = path.join(directory, MANIFEST)
  const receipt = readRegular(manifest, MANIFEST_LIMIT, MANIFEST_MODE)
  const value = JSON.parse(receipt.bytes.toString('utf8'))
  const snapshot = sourceSnapshot()
  if (
    !value ||
    value.schema !== SCHEMA ||
    value.platform !== process.platform ||
    value.arch !== process.arch ||
    value.sourceFingerprint !== snapshot.fingerprint ||
    JSON.stringify(value.sources) !== JSON.stringify(snapshot.sources) ||
    JSON.stringify(value.directory) !== JSON.stringify(directoryIdentity) ||
    !value.executable ||
    !HASH.test(value.executable.sha256)
  ) {
    throw new Error('recovery probe manifest or source fingerprint is stale or invalid')
  }
  const executable = path.join(directory, EXECUTABLE)
  const binary = readRegular(executable, EXECUTABLE_LIMIT, EXECUTABLE_MODE)
  if (JSON.stringify(value.executable) !== JSON.stringify(binary.identity)) {
    throw new Error('recovery probe executable identity or digest differs from its manifest')
  }
  sameDirectory(directory, directoryIdentity)
  return { executable, manifest, manifestSha256: receipt.identity.sha256 }
}

function buildRecoveryProbe(output) {
  target()
  const directory = absoluteOutput(output)
  const snapshot = sourceSnapshot()
  noLinkedAncestors(path.dirname(directory))
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE })
  const directoryIdentity = privateDirectory(directory)
  if (fs.readdirSync(directory).length) throw new Error('recovery probe build output must be empty')
  const temporary = fs.mkdtempSync(path.join(directory, '.build-'))
  const executable = path.join(directory, EXECUTABLE)
  const manifest = path.join(directory, MANIFEST)
  let publishedExecutable = false
  let publishedManifest = false
  try {
    for (const source of snapshot.files) {
      const filename = path.join(temporary, source.path)
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      fs.writeFileSync(filename, source.bytes, { mode: MANIFEST_MODE, flag: 'wx' })
    }
    const compiled = path.join(temporary, EXECUTABLE)
    const result = spawnSync(
      COMPILER,
      [
        ...COMPILER_FLAGS,
        '-arch',
        ARCHITECTURES[process.arch],
        ...COMPILE_UNITS.map((unit) => path.join(temporary, unit)),
        '-o',
        compiled,
      ],
      {
        cwd: temporary,
        shell: false,
        env: { PATH: '/usr/bin:/bin', TMPDIR: temporary },
        encoding: 'utf8',
        timeout: COMPILE_TIMEOUT_MS,
        maxBuffer: COMPILER_OUTPUT_LIMIT,
      }
    )
    if (result.error || result.status !== 0) {
      throw new Error(
        `recovery probe compilation failed: ${result.error || result.stderr || result.stdout || result.status}`
      )
    }
    sameDirectory(directory, directoryIdentity)
    assertSources(snapshot)
    fs.chmodSync(compiled, EXECUTABLE_MODE)
    const binary = readRegular(compiled, EXECUTABLE_LIMIT, EXECUTABLE_MODE)
    fs.linkSync(compiled, executable)
    publishedExecutable = true
    fs.unlinkSync(compiled)
    const value = {
      schema: SCHEMA,
      platform: process.platform,
      arch: process.arch,
      directory: directoryIdentity,
      sourceFingerprint: snapshot.fingerprint,
      sources: snapshot.sources,
      executable: binary.identity,
    }
    sameDirectory(directory, directoryIdentity)
    assertSources(snapshot)
    const descriptor = fs.openSync(
      manifest,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      MANIFEST_MODE
    )
    publishedManifest = true
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n')
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return resolveRecoveryProbe(directory)
  } catch (error) {
    sameDirectory(directory, directoryIdentity)
    if (publishedManifest) fs.unlinkSync(manifest)
    if (publishedExecutable) fs.unlinkSync(executable)
    throw error
  } finally {
    sameDirectory(directory, directoryIdentity)
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

function maintenanceSnapshot() {
  const files = nativeFilesSnapshot([
    ...COMPILE_UNITS,
    ...TERMINAL_UNITS,
    ...nativeSourceFiles(process.platform),
  ])
  const sources = new Map(files.map((file) => [path.join(SOURCE_ROOT, file.path), file]))
  function moduleSource(filename) {
    filename = path.resolve(filename)
    const relative = path.relative(REPOSITORY, filename)
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('maintenance source dependency escapes its repository owner')
    }
    if (sources.has(filename)) return
    const { bytes, identity } = readRegular(filename, SOURCE_LIMIT)
    sources.set(filename, { bytes, sha256: identity.sha256 })
    for (const match of bytes.toString('utf8').matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      moduleSource(path.resolve(path.dirname(filename), match[1]))
    }
  }
  for (const filename of SOURCE_MODULES) moduleSource(filename)
  const inventory = [...sources]
    .map(([filename, source]) => ({
      path: path.relative(REPOSITORY, filename).split(path.sep).join('/'),
      bytes: source.bytes.length,
      sha256: source.sha256,
    }))
    .sort((first, second) => first.path.localeCompare(second.path))
  return { files, sources: inventory, fingerprint: digest(JSON.stringify(inventory)) }
}

function maintenancePolicy() {
  const policy = JSON.parse(readRegular(POLICY, MANIFEST_LIMIT).bytes.toString('utf8'))
  if (
    !policy ||
    !/^\d+\.\d+\.\d+$/.test(policy.node) ||
    policy.node !== process.versions.node ||
    !Number.isSafeInteger(policy.napi) ||
    policy.napi < 1 ||
    typeof policy.electron !== 'string' ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(policy.darwin?.deploymentTarget)
  ) {
    throw new Error('maintenance native policy or Node version is invalid')
  }
  for (const name of ['headers', 'license']) {
    const input = policy[name]
    if (
      !input ||
      !HASH.test(input.sha256) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > ARTIFACT_LIMIT ||
      typeof input.filename !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(input.filename) ||
      path.basename(input.filename) !== input.filename
    ) {
      throw new Error('maintenance native input policy is invalid')
    }
  }
  return policy
}

function assertMaintenanceSources(snapshot) {
  if (maintenanceSnapshot().fingerprint !== snapshot.fingerprint) {
    throw new Error('maintenance source fingerprint changed')
  }
}

function nativeReceipt(directory, policy, snapshot) {
  const filename = path.join(directory, NATIVE_RECEIPT)
  const receipt = readRegular(filename, MANIFEST_LIMIT, MANIFEST_MODE)
  const value = JSON.parse(receipt.bytes.toString('utf8'))
  const expectedSources = Object.fromEntries(
    nativeSourceFiles(process.platform).map((name) => {
      const relative = path
        .relative(REPOSITORY, path.join(SOURCE_ROOT, name))
        .split(path.sep)
        .join('/')
      return [name, snapshot.sources.find((source) => source.path === relative)?.sha256]
    })
  )
  const builder = snapshot.sources.find(
    (source) => source.path === path.relative(REPOSITORY, BUILDER).split(path.sep).join('/')
  )
  const expectedInputs = Object.fromEntries(
    ['headers', 'license'].map((name) => [
      name,
      { sha256: policy[name].sha256, bytes: policy[name].bytes },
    ])
  )
  const libraryNames = libraries(process.platform)
  if (
    !value ||
    value.schema !== NATIVE_RECEIPT_SCHEMA ||
    value.platform !== process.platform ||
    value.arch !== process.arch ||
    value.napi !== policy.napi ||
    value.electron !== policy.electron ||
    value.directory !== directory ||
    value.signed !== false ||
    value.builder_sha256 !== builder?.sha256 ||
    JSON.stringify(value.sources) !== JSON.stringify(expectedSources) ||
    JSON.stringify(value.inputs) !== JSON.stringify(expectedInputs) ||
    value.contracts?.directory !== 'not-requested' ||
    !Array.isArray(value.libraries) ||
    value.libraries.length !== libraryNames.length ||
    new Set(value.libraries.map((entry) => entry.path)).size !== libraryNames.length ||
    value.libraries.some(
      (entry) => !libraryNames.includes(entry.path) || !HASH.test(entry.sha256)
    ) ||
    !Array.isArray(value.licenses) ||
    value.licenses.length !== 1 ||
    value.licenses[0].path !== policy.license.filename ||
    value.licenses[0].sha256 !== policy.license.sha256
  ) {
    throw new Error('maintenance canonical native receipt is invalid or stale')
  }
  const records = { [NATIVE_RECEIPT]: receipt.identity }
  for (const entry of [...value.libraries, ...value.licenses]) {
    const mode = libraryNames.includes(entry.path) ? EXECUTABLE_MODE : MANIFEST_MODE
    const observed = readRegular(path.join(directory, entry.path), EXECUTABLE_LIMIT, mode)
    if (observed.identity.sha256 !== entry.sha256)
      throw new Error('maintenance native file digest differs from its receipt')
    records[entry.path] = observed.identity
  }
  return records
}

function resolveRecoveryMaintenance(output) {
  target()
  const directory = absoluteOutput(output)
  const directoryIdentity = privateDirectory(directory)
  const manifest = path.join(directory, MAINTENANCE_MANIFEST)
  const receipt = readRegular(manifest, MANIFEST_LIMIT, MANIFEST_MODE)
  const value = JSON.parse(receipt.bytes.toString('utf8'))
  const snapshot = maintenanceSnapshot()
  const policy = maintenancePolicy()
  const probe = resolveRecoveryProbe(directory)
  const native = path.join(directory, NATIVE_DIRECTORY)
  if (
    !value ||
    value.schema !== MAINTENANCE_SCHEMA ||
    value.kind !== MAINTENANCE_KIND ||
    value.platform !== process.platform ||
    value.arch !== process.arch ||
    value.sourceFingerprint !== snapshot.fingerprint ||
    JSON.stringify(value.sources) !== JSON.stringify(snapshot.sources) ||
    JSON.stringify(value.directory) !== JSON.stringify(directoryIdentity) ||
    value.probeManifestSha256 !== probe.manifestSha256 ||
    JSON.stringify(value.nativeDirectory) !== JSON.stringify(privateDirectory(native))
  ) {
    throw new Error('maintenance manifest or source fingerprint is invalid or stale')
  }
  const records = nativeReceipt(native, policy, snapshot)
  const terminal = path.join(directory, TERMINAL_ADDON)
  const terminalRecord = readRegular(terminal, EXECUTABLE_LIMIT, EXECUTABLE_MODE).identity
  if (
    JSON.stringify(value.nativeRecords) !== JSON.stringify(records) ||
    JSON.stringify(value.terminal) !== JSON.stringify(terminalRecord)
  ) {
    throw new Error('maintenance addon identity or digest changed')
  }
  assertMaintenanceSources(snapshot)
  sameDirectory(directory, directoryIdentity)
  if (
    JSON.stringify(readRegular(terminal, EXECUTABLE_LIMIT, EXECUTABLE_MODE).identity) !==
      JSON.stringify(terminalRecord) ||
    JSON.stringify(
      readRegular(path.join(native, LEASE_ADDON), EXECUTABLE_LIMIT, EXECUTABLE_MODE).identity
    ) !== JSON.stringify(records[LEASE_ADDON])
  ) {
    throw new Error('maintenance addon changed during resolution')
  }
  return {
    executable: probe.executable,
    lease: path.join(native, LEASE_ADDON),
    terminal,
    manifest,
    manifestSha256: receipt.identity.sha256,
  }
}

async function buildRecoveryMaintenance(output, inputs) {
  target()
  const directory = absoluteOutput(output)
  const policy = maintenancePolicy()
  if (
    !inputs ||
    typeof inputs !== 'object' ||
    Object.keys(inputs).length !== 2 ||
    Object.keys(inputs).some((name) => !['headers', 'license'].includes(name))
  ) {
    throw new Error('maintenance requires explicit verified local headers and license inputs')
  }
  const artifacts = {}
  for (const name of ['headers', 'license']) {
    try {
      const filename = absoluteOutput(inputs[name])
      artifacts[name] = readRegular(filename, policy[name].bytes)
      if (
        artifacts[name].identity.bytes !== policy[name].bytes ||
        artifacts[name].identity.sha256 !== policy[name].sha256
      ) {
        throw new Error('artifact digest differs from policy')
      }
    } catch (cause) {
      throw new Error(`maintenance ${name} input is not a verified local artifact`, { cause })
    }
  }
  const snapshot = maintenanceSnapshot()
  const probe = buildRecoveryProbe(directory)
  const directoryIdentity = privateDirectory(directory)
  const temporary = fs.mkdtempSync(path.join(directory, '.maintenance-'))
  const native = path.join(directory, NATIVE_DIRECTORY)
  const terminal = path.join(directory, TERMINAL_ADDON)
  const manifest = path.join(directory, MAINTENANCE_MANIFEST)
  let published = false
  try {
    const selected = {}
    for (const name of ['headers', 'license']) {
      selected[name] = path.join(temporary, policy[name].filename)
      fs.writeFileSync(selected[name], artifacts[name].bytes, { mode: MANIFEST_MODE, flag: 'wx' })
    }
    await compileNative({
      directory: native,
      artifacts: selected,
      environment: {
        PATH: '/usr/bin:/bin',
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
        SCHOLARSEED_NATIVE_BUILD_ROOT: path.join(temporary, 'compiler'),
      },
      runContract: false,
      runDirectoryContract: false,
    })
    assertMaintenanceSources(snapshot)
    for (const name of [...libraries(process.platform), policy.license.filename, NATIVE_RECEIPT]) {
      const filename = path.join(native, name)
      readRegular(filename, EXECUTABLE_LIMIT)
      fs.chmodSync(
        filename,
        libraries(process.platform).includes(name) ? EXECUTABLE_MODE : MANIFEST_MODE
      )
    }
    const records = nativeReceipt(native, policy, snapshot)
    for (const source of snapshot.files) {
      const filename = path.join(temporary, 'sources', source.path)
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
      fs.writeFileSync(filename, source.bytes, { mode: MANIFEST_MODE, flag: 'wx' })
    }
    const headers = path.join(temporary, 'headers')
    fs.mkdirSync(headers, { mode: PRIVATE_DIRECTORY_MODE })
    const environment = { PATH: '/usr/bin:/bin', TMPDIR: temporary }
    const settings = {
      cwd: temporary,
      shell: false,
      env: environment,
      encoding: 'utf8',
      timeout: COMPILE_TIMEOUT_MS,
      maxBuffer: COMPILER_OUTPUT_LIMIT,
    }
    for (const [command, args] of [
      [TAR, ['-xf', selected.headers, '-C', headers]],
      [
        COMPILER,
        [
          ...COMPILER_FLAGS.filter((argument) => !argument.startsWith('-mmacosx-version-min=')),
          `-mmacosx-version-min=${policy.darwin.deploymentTarget}`,
          '-Wall',
          '-Wextra',
          '-Werror',
          '-arch',
          ARCHITECTURES[process.arch],
          '-bundle',
          '-undefined',
          'dynamic_lookup',
          `-DNAPI_VERSION=${policy.napi}`,
          '-DNODE_GYP_MODULE_NAME=terminal',
          '-I',
          path.join(headers, `node-v${policy.node}`, 'include', 'node'),
          ...TERMINAL_UNITS.map((unit) => path.join(temporary, 'sources', unit)),
          '-o',
          terminal,
        ],
      ],
    ]) {
      const result = spawnSync(command, args, settings)
      if (result.error || result.status !== 0)
        throw new Error(
          `maintenance native command failed: ${result.error || result.stderr || result.stdout || result.status}`
        )
    }
    fs.chmodSync(terminal, EXECUTABLE_MODE)
    const terminalRecord = readRegular(terminal, EXECUTABLE_LIMIT, EXECUTABLE_MODE).identity
    assertMaintenanceSources(snapshot)
    sameDirectory(directory, directoryIdentity)
    const value = {
      schema: MAINTENANCE_SCHEMA,
      kind: MAINTENANCE_KIND,
      platform: process.platform,
      arch: process.arch,
      directory: directoryIdentity,
      sourceFingerprint: snapshot.fingerprint,
      sources: snapshot.sources,
      probeManifestSha256: probe.manifestSha256,
      nativeDirectory: privateDirectory(native),
      nativeRecords: records,
      terminal: terminalRecord,
    }
    const descriptor = fs.openSync(
      manifest,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      MANIFEST_MODE
    )
    published = true
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n')
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return resolveRecoveryMaintenance(directory)
  } catch (error) {
    sameDirectory(directory, directoryIdentity)
    if (published) fs.unlinkSync(manifest)
    throw error
  } finally {
    sameDirectory(directory, directoryIdentity)
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

module.exports = {
  buildRecoveryProbe,
  resolveRecoveryProbe,
  buildRecoveryMaintenance,
  resolveRecoveryMaintenance,
}
