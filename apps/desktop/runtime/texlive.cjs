// Product-owned TeX Live toolchain for the bundled literature-review skill.
// The archive is a reviewed vendor input; packaging verifies its SHA-256
// sidecar before staging it, and both launch surfaces resolve the platform
// binary directory so the skill's `shutil.which` lookups find the shipped
// engines instead of depending on the host having TeX installed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawn } = require('node:child_process')
const { nativeTar } = require('../../../scripts/python.cjs')

const VENDOR_RELATIVE = path.join('scripts', 'vendor', 'texlive')
const MANIFEST_NAME = 'manifest.json'
const CACHE_DIRECTORY = 'node_modules/.cache/scholarseed/texlive'
const CACHE_RECEIPT = 'archive.sha256'
const BACKEND_DIRECTORY = 'backend'
const TREE_DIRECTORY = 'texlive'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PROBE_TIMEOUT_MS = 60_000
const ARCH_ALIASES = { x86_64: 'x64' }
// A packaged app carries no repository checkout, so the staged layout is
// resolved here. Packaging asserts this map against the vendor manifest's
// `bin_relative`, which keeps the manifest authoritative without shipping it.
const PLATFORM_DIRECTORY = { darwin: 'universal-darwin', win32: 'windows' }
const WINDOWS_PLATFORM = 'win32'
// The archive is a Git LFS object. A checkout without `git lfs pull` leaves the
// pointer file in the working tree, and reporting that as a checksum mismatch
// would send whoever hits it hunting for a corrupt archive instead of a missing
// LFS payload.
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1'

function assertNotLfsPointer(archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const head = Buffer.alloc(LFS_POINTER_PREFIX.length)
    const bytesRead = fs.readSync(fd, head, 0, head.length, 0)
    if (bytesRead === head.length && head.toString('utf8') === LFS_POINTER_PREFIX) {
      throw new Error(`TeX Live archive is an unresolved Git LFS pointer: run git lfs pull (${archive})`)
    }
  } finally {
    fs.closeSync(fd)
  }
}

function executableName(name, platform = process.platform) {
  return platform === WINDOWS_PLATFORM ? `${name}.exe` : name
}

async function digest(filename) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

function vendorRoot(desktopRoot) {
  return path.resolve(desktopRoot, '..', '..', VENDOR_RELATIVE)
}

// `desktopRoot` is apps/desktop, so the vendor directory is reachable in
// development and during packaging.
function artifact(desktopRoot, platform = process.platform, arch = process.arch) {
  const document = JSON.parse(
    fs.readFileSync(path.join(vendorRoot(desktopRoot), MANIFEST_NAME), 'utf8'))
  const key = `${platform}-${ARCH_ALIASES[arch] || arch}`
  const selected = document.targets?.[key]
  if (!selected || !/^\d{4}$/.test(String(document.texlive))) {
    throw new Error(`no bundled TeX Live distribution for ${key}`)
  }
  const executables = document.executables
  if (!Array.isArray(executables) || executables.length === 0 ||
      !executables.every(name => typeof name === 'string' && name.length > 0)) {
    throw new Error('TeX Live manifest declares no executables')
  }
  const archive = path.join(vendorRoot(desktopRoot), selected.archive)
  assertNotLfsPointer(archive)
  const sidecar = fs.readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)
  if (!SHA256_PATTERN.test(sidecar[0]) || sidecar[1]?.replace(/^\*/, '') !== selected.archive) {
    throw new Error('TeX Live archive SHA-256 sidecar is invalid')
  }
  const platformDirectory = selected.bin_relative.split('/').slice(-2).join('/')
  if (platformDirectory !== `bin/${PLATFORM_DIRECTORY[platform]}`) {
    throw new Error(`TeX Live manifest layout differs from the product layout: ${selected.bin_relative}`)
  }
  return { ...selected, archive, key, sha256: sidecar[0], texlive: document.texlive, executables }
}

function binDirectory(treeRoot, selected, platform = process.platform) {
  const directory = path.join(treeRoot, ...selected.bin_relative.split('/'))
  for (const name of selected.executables) {
    fs.accessSync(path.join(directory, executableName(name, platform)), fs.constants.X_OK)
  }
  return directory
}

function probeEngine(binDir, name, platform) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(binDir, executableName(name, platform)), ['--version'], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` }
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.once('error', error => reject(new Error(`TeX Live probe failed: ${name} (${error.message})`)))
    child.once('close', (code, signal) => (code === 0
      ? resolve((out || err).split(/\r?\n/)[0].trim())
      : reject(new Error(`TeX Live probe failed: ${name} (${signal || code})`))))
  })
}

// Engines are probed in parallel: each probe is exec + page-in latency, so a
// sequential loop would multiply that latency by the engine count.
async function probe(binDir, executables, texlive, platform = process.platform) {
  const lines = await Promise.all(executables.map(name => probeEngine(binDir, name, platform)))
  const reported = {}
  executables.forEach((name, index) => { reported[name] = lines[index] })
  const expected = `TeX Live ${texlive}`
  if (!Object.values(reported).some(line => line.includes(expected))) {
    throw new Error(`TeX Live version mismatch: expected ${expected}, got ${JSON.stringify(reported)}`)
  }
  return reported
}

// Development launcher: extract the reviewed archive into a per-checksum cache
// under node_modules, the same place the vendored Codex runtime caches.
async function resolveVendoredTexlive(desktopRoot, platform = process.platform,
  arch = process.arch, log = () => {}) {
  const selected = artifact(desktopRoot, platform, arch)
  const cache = path.join(desktopRoot, CACHE_DIRECTORY)
  // `bin_relative` is relative to the extraction root and already starts with
  // the tree directory, so the cache entry itself is what binDirectory resolves
  // against.
  const directory = path.join(cache, `${selected.texlive}-${selected.key}-${selected.sha256}`)
  const receipt = path.join(directory, CACHE_RECEIPT)
  if (fs.existsSync(directory)) {
    if (!fs.existsSync(receipt) || fs.readFileSync(receipt, 'utf8').trim() !== selected.sha256) {
      throw new Error(`TeX Live cache is incomplete or does not match its archive. Stop Desktop, move ${directory} aside, then relaunch.`)
    }
    const binDir = binDirectory(directory, selected, platform)
    const reported = await probe(binDir, selected.executables, selected.texlive, platform)
    log(`Vendored TeX Live ${selected.texlive} (cached): ${binDir}`)
    return { binDirectory: binDir, root: directory, reported, sha256: selected.sha256,
      texlive: selected.texlive }
  }
  // The cache key and the receipt already bind a cached tree to the reviewed
  // archive checksum, so the full archive digest is only paid on a cache miss.
  if (await digest(selected.archive) !== selected.sha256) {
    throw new Error('TeX Live archive SHA-256 mismatch')
  }
  fs.mkdirSync(cache, { recursive: true })
  const stage = fs.mkdtempSync(path.join(cache, 'resolve-'))
  try {
    execFileSync(nativeTar(platform), ['-xzf', selected.archive, '-C', stage], { stdio: 'pipe' })
    fs.writeFileSync(path.join(stage, CACHE_RECEIPT), `${selected.sha256}\n`, { flag: 'wx' })
    fs.renameSync(stage, directory)
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
  const binDir = binDirectory(directory, selected, platform)
  const reported = await probe(binDir, selected.executables, selected.texlive, platform)
  log(`Vendored TeX Live ${selected.texlive}: ${binDir}`)
  return { binDirectory: binDir, root: directory, reported, sha256: selected.sha256,
    texlive: selected.texlive }
}

// Packaging: stage the tree into resources/backend so it lands at
// backend/texlive/, matching the archive's top-level member.
function stageTexlive(backendDirectory, selected) {
  fs.mkdirSync(backendDirectory, { recursive: true })
  execFileSync(nativeTar(), ['-xzf', selected.archive, '-C', backendDirectory], { stdio: 'pipe' })
  return binDirectory(backendDirectory, selected)
}

// The single packaging entry point: verify the reviewed archive digest, stage
// it, assert every declared engine is executable, and probe their versions so a
// corrupt or foreign tree fails the build instead of the user's first survey.
async function stageVerifiedTexlive(backendDirectory, desktopRoot, platform = process.platform,
  arch = process.arch) {
  const selected = artifact(desktopRoot, platform, arch)
  if (await digest(selected.archive) !== selected.sha256) {
    throw new Error('TeX Live archive SHA-256 mismatch')
  }
  const binDir = stageTexlive(backendDirectory, selected)
  const reported = await probe(binDir, selected.executables, selected.texlive, platform)
  return { binDirectory: binDir, reported, sha256: selected.sha256, texlive: selected.texlive,
    executables: selected.executables }
}

// Packaged launcher: the tree is already staged under resources/backend/texlive.
function stagedBinDirectory(resourcesRoot, platform = process.platform) {
  const directory = PLATFORM_DIRECTORY[platform]
  if (!directory) throw new Error(`no bundled TeX Live layout for ${platform}`)
  return path.join(resourcesRoot, BACKEND_DIRECTORY, TREE_DIRECTORY, 'bin', directory)
}

function stagedEngines(resourcesRoot, platform, executables) {
  const binDir = stagedBinDirectory(resourcesRoot, platform)
  return executables.map(name => path.join(binDir, executableName(name, platform)))
}

function bundledTexlive(resourcesRoot, platform = process.platform) {
  const binDir = stagedBinDirectory(resourcesRoot, platform)
  fs.accessSync(path.join(binDir, executableName('xelatex', platform)), fs.constants.X_OK)
  return binDir
}

module.exports = { PLATFORM_DIRECTORY, TREE_DIRECTORY, artifact, binDirectory, bundledTexlive,
  digest, executableName, probe, resolveVendoredTexlive, stagedBinDirectory, stagedEngines,
  stageTexlive, stageVerifiedTexlive }
