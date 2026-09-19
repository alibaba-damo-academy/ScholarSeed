// Product-owned fixed Codex runtime. Archives are reviewed Git LFS inputs.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile, spawn, spawnSync } = require('node:child_process')
const { promisify } = require('node:util')
const { nativeTar } = require('../../../scripts/python.cjs')

const run = promisify(execFile)
const VENDOR_RELATIVE = path.join('scripts', 'vendor', 'codex')
const MANIFEST_NAME = 'manifest.json'
const CACHE_DIRECTORY = 'node_modules/.cache/scholarseed/codex'
const PROBE_TIMEOUT_MS = 15_000
const PROBE_BOOTSTRAP_TIMEOUT_MS = 60_000
const METADATA_LIMIT = 8 * 1024 * 1024
const RUNTIME_FILE_MODE = 0o755
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/

async function digest(filename, algorithm, encoding) {
  const hash = crypto.createHash(algorithm)
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest(encoding)
}

async function verifyArchive(filename, integrity) {
  if (!INTEGRITY_PATTERN.test(integrity) ||
      `sha512-${await digest(filename, 'sha512', 'base64')}` !== integrity) {
    throw new Error('Vendored Codex archive integrity mismatch')
  }
}

async function extractBinary(archive, member, destination) {
  const fd = fs.openSync(destination, 'wx', RUNTIME_FILE_MODE)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(nativeTar(), ['-xzOf', archive, member], { stdio: ['ignore', fd, 'pipe'],
        env: { ...process.env, COPYFILE_DISABLE: '1' } })
      let error = ''
      child.stderr.on('data', chunk => { error += chunk })
      child.once('error', reject)
      child.once('close', code => code === 0
        ? resolve()
        : reject(new Error(`Codex extraction failed: ${error}`)))
    })
    fs.fchmodSync(fd, RUNTIME_FILE_MODE)
  } finally {
    fs.closeSync(fd)
  }
}

function vendorRoot(desktopRoot) {
  return path.resolve(desktopRoot, '..', '..', VENDOR_RELATIVE)
}

function artifact(desktopRoot, platform, arch) {
  const root = vendorRoot(desktopRoot)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), 'utf8'))
  const key = `${platform}-${arch}`
  const selected = manifest.artifacts?.[key]
  if (manifest.package !== '@openai/codex' || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      !selected || !INTEGRITY_PATTERN.test(selected.integrity)) {
    throw new Error(`Unsupported vendored Codex platform: ${key}`)
  }
  const archive = path.join(root, selected.file)
  const sidecar = fs.readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)
  if (!SHA256_PATTERN.test(sidecar[0]) || sidecar[1]?.replace(/^\*/, '') !== selected.file) {
    throw new Error('Vendored Codex SHA-256 sidecar is invalid')
  }
  return { ...selected, archive, key, root, sha256: sidecar[0], version: manifest.version }
}

async function resolveVendoredCodex(
  desktopRoot,
  platform = process.platform,
  arch = process.arch,
  log = () => {}
) {
  const selected = artifact(desktopRoot, platform, arch)
  if (await digest(selected.archive, 'sha256', 'hex') !== selected.sha256) {
    throw new Error('Vendored Codex archive SHA-256 mismatch')
  }
  await verifyArchive(selected.archive, selected.integrity)
  const cache = path.join(desktopRoot, CACHE_DIRECTORY)
  fs.mkdirSync(cache, { recursive: true })
  const directory = path.join(cache, `${selected.version}-${selected.key}-${selected.sha256}`)
  const stage = fs.mkdtempSync(path.join(cache, 'resolve-'))
  try {
    const prefix = `package/vendor/${selected.target}/`
    const members = (await run(nativeTar(), ['-tzf', selected.archive], {
      maxBuffer: METADATA_LIMIT
    })).stdout.trim().split(/\r?\n/)
    const files = []
    const runtime = path.join(stage, 'runtime')
    for (const member of members.filter(name => name.startsWith(prefix) && !name.endsWith('/'))) {
      const relative = member.slice(prefix.length)
      if (!relative || relative.split('/').some(part => !part || part === '..' || part === '.') ||
          path.isAbsolute(relative)) {
        throw new Error('Unsafe Codex package member')
      }
      const destination = path.join(runtime, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      await extractBinary(selected.archive, member, destination)
      files.push({ path: relative, sha256: await digest(destination, 'sha256', 'hex'),
        mode: RUNTIME_FILE_MODE })
    }
    const packageManifest = JSON.parse(fs.readFileSync(path.join(runtime, 'codex-package.json')))
    if (packageManifest.target !== selected.target || typeof packageManifest.entrypoint !== 'string') {
      throw new Error('Codex runtime package manifest differs from its target')
    }
    const executable = path.join(runtime, packageManifest.entrypoint)
    const probe = spawnSync(executable, ['--version'], {
      timeout: PROBE_BOOTSTRAP_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: os.tmpdir() }
    })
    if (probe.error || probe.status !== 0) {
      throw new Error(`Codex runtime probe failed: ${probe.error?.message || probe.stderr || probe.signal || probe.status}`)
    }
    const reported = probe.stdout.trim()
    if (reported !== `codex-cli ${selected.version}`) {
      throw new Error(`Codex version mismatch: expected ${selected.version}, got ${reported}`)
    }
    if (!fs.existsSync(directory)) fs.renameSync(runtime, directory)
    for (const file of files) {
      const cached = path.join(directory, file.path)
      if (await digest(cached, 'sha256', 'hex') !== file.sha256) {
        throw new Error(`Cached Codex runtime was modified: ${file.path}`)
      }
      fs.chmodSync(cached, file.mode)
    }
    const destination = path.join(directory, packageManifest.entrypoint)
    log(`Vendored Codex ${selected.version}: ${destination}`)
    return {
      path: destination,
      root: directory,
      files,
      reported_version: selected.version,
      sha256: await digest(destination, 'sha256', 'hex'),
      source: { package: '@openai/codex', distribution: 'git-lfs',
        archive_sha256: selected.sha256, integrity: selected.integrity }
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

function bundledCodex(resourcesRoot, platform = process.platform) {
  const executable = path.join(resourcesRoot, 'backend', 'codex-runtime', 'bin',
    platform === 'win32' ? 'codex.exe' : 'codex')
  fs.accessSync(executable, fs.constants.X_OK)
  return executable
}

module.exports = { artifact, bundledCodex, resolveVendoredCodex, verifyArchive }
