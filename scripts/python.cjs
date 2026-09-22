#!/usr/bin/env node
// Shared Python distribution policy for development and Desktop packaging.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const VENDOR_DIRECTORY = ['scripts', 'vendor', 'python-build-standalone']
const MANIFEST_FILENAME = 'manifest.json'
const CACHE_DIRECTORY = '.python'
const CACHE_RECEIPT = 'archive.sha256'
const DEFAULT_VENV = '.venv'
const UV_ENV = 'UV'
const UV_DEFAULT_INDEX_ENV = 'UV_DEFAULT_INDEX'
const PIP_INDEX_ENV = 'PIP_INDEX_URL'
const PYTHON_ENV = 'PYTHON'
const VENV_ENV = 'VENV'
const DESKTOP_GROUP = 'desktop'
const WINDOWS_PLATFORM = 'win32'
const PROBE_TIMEOUT_MS = 15_000
const FILESYSTEM_RETRY_DELAY_MS = 250
const FILESYSTEM_RETRY_ATTEMPTS = 20
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const ARCH_ALIASES = { x86_64: 'x64' }
const PUBLISH_COLLISIONS = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM'])
const PYTHON_PROBE = [
  'import json, platform, sqlite3, sys, sysconfig',
  'print(json.dumps({"python": platform.python_version(), "sqlite": sqlite3.sqlite_version,',
  '"platform": sys.platform, "machine": platform.machine(), "executable": sys.executable,',
  '"base_prefix": sys.base_prefix, "prefix": sys.prefix, "scripts": sysconfig.get_path("scripts")}))'
].join('\n')

function pythonRelease(repo, platform = process.platform, arch = process.arch) {
  const directory = path.join(repo, ...VENDOR_DIRECTORY)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_FILENAME), 'utf8'))
  const selected = manifest.targets?.[`${platform}-${ARCH_ALIASES[arch] || arch}`]
  if (!selected) throw new Error(`no Desktop Python distribution for ${platform}/${arch}`)
  if (!VERSION_PATTERN.test(manifest.python) || !VERSION_PATTERN.test(manifest.sqlite)
      || !/^\d{8}$/.test(manifest.release)) throw new Error('invalid Python runtime manifest')
  const filename = `cpython-${manifest.python}+${manifest.release}-${selected.triple}-install_only.tar.gz`
  const archive = path.join(directory, filename)
  const checksum = fs.readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)
  if (!SHA256_PATTERN.test(checksum[0]) || checksum[1]?.replace(/^\*/, '') !== filename) {
    throw new Error('Python archive checksum is missing or invalid')
  }
  return { ...selected, python: manifest.python, sqlite: manifest.sqlite,
    platform, archive, sha256: checksum[0] }
}

async function verifyPythonArchive(release) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(release.archive)) hash.update(chunk)
  if (hash.digest('hex') !== release.sha256) throw new Error('Python archive checksum differs')
  return release
}

function inspectPython(executable) {
  return JSON.parse(execFileSync(executable, ['-I', '-B', '-c', PYTHON_PROBE], {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim())
}

function verifyPython(executable, release) {
  const actual = inspectPython(executable)
  for (const field of ['python', 'sqlite', 'platform', 'machine']) {
    if (actual[field] !== release[field]) {
      throw new Error(`Python runtime mismatch: ${field}=${actual[field]}, expected ${release[field]}`)
    }
  }
  return actual
}

function sameRealPath(left, right, platform = process.platform) {
  const normalize = value => {
    const resolved = fs.realpathSync(value)
    return platform === WINDOWS_PLATFORM ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function cacheRoot(repo, release) {
  return path.join(repo, CACHE_DIRECTORY, release.sha256)
}

function archiveExecutable(root, release) {
  return path.join(root, ...release.executable.split('/'))
}

function verifyCache(root, release) {
  try {
    if (fs.readFileSync(path.join(root, CACHE_RECEIPT), 'utf8').trim() !== release.sha256) {
      throw new Error('Python cache does not match its archive')
    }
    const executable = archiveExecutable(root, release)
    const actual = verifyPython(executable, release)
    if (!sameRealPath(actual.base_prefix, path.join(root, 'python'))) {
      throw new Error('cached Python uses a different base runtime')
    }
    return executable
  } catch (error) {
    throw new Error(`${error.message}. Stop Desktop and Python processes using ${root}, move that cache directory aside, then run npm run install:python.`)
  }
}

function nativeTar(platform = process.platform, environment = process.env) {
  if (platform !== WINDOWS_PLATFORM) return '/usr/bin/tar'
  const systemRoot = environment.SystemRoot || environment.WINDIR
  if (!systemRoot) throw new Error('SystemRoot is required to find native Windows tar.exe')
  return path.win32.join(systemRoot, 'System32', 'tar.exe')
}

function waitForFilesystem() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FILESYSTEM_RETRY_DELAY_MS)
}

function retryFilesystem(operation) {
  let lastError
  for (let attempt = 0; attempt < FILESYSTEM_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      lastError = error
      if (!PUBLISH_COLLISIONS.has(error.code)) throw error
      waitForFilesystem()
    }
  }
  throw lastError
}

function cleanupTemporary(directory) {
  retryFilesystem(() => fs.rmSync(directory, { recursive: true, force: true }))
}

async function preparePython(repo) {
  const release = await verifyPythonArchive(pythonRelease(repo))
  const destination = cacheRoot(repo, release)
  if (fs.existsSync(destination)) return verifyCache(destination, release)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = fs.mkdtempSync(path.join(path.dirname(destination), '.prepare-'))
  try {
    execFileSync(nativeTar(), ['-xzf', release.archive, '-C', temporary], { stdio: 'pipe' })
    verifyPython(archiveExecutable(temporary, release), release)
    fs.writeFileSync(path.join(temporary, CACHE_RECEIPT), `${release.sha256}\n`, { flag: 'wx' })
    try {
      retryFilesystem(() => fs.renameSync(temporary, destination))
    } catch (error) {
      if (!PUBLISH_COLLISIONS.has(error.code) || !fs.existsSync(destination)) throw error
      verifyCache(destination, release)
    }
    return verifyCache(destination, release)
  } finally {
    cleanupTemporary(temporary)
  }
}

function verifyDevelopmentPython(repo, executable) {
  try {
    const release = pythonRelease(repo)
    const root = cacheRoot(repo, release)
    verifyCache(root, release)
    const actual = verifyPython(executable, release)
    if (!sameRealPath(actual.base_prefix, path.join(root, 'python'))) {
      throw new Error(`Python base differs from the repository runtime: ${actual.base_prefix}`)
    }
    if (sameRealPath(actual.prefix, actual.base_prefix)) throw new Error('Desktop requires a project virtual environment')
    return actual
  } catch (error) {
    throw new Error(`${error.message}. Run npm run install:python without PYTHON to synchronize the Desktop environment.`)
  }
}

function developmentPython(repo, venv = DEFAULT_VENV) {
  const release = pythonRelease(repo)
  return path.join(path.resolve(repo, venv), ...release.venvExecutable.split('/'))
}

function uvExecutable(environment = process.env) {
  return environment[UV_ENV] || 'uv'
}

function configuredPipIndex(environment = process.env) {
  if (environment[UV_DEFAULT_INDEX_ENV] || environment[PIP_INDEX_ENV]) return ''
  try {
    return execFileSync('pip3', ['config', 'get', 'global.index-url'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    }).trim().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

async function prepareDevelopmentEnvironment(repo, environment = process.env) {
  const env = { ...environment }
  const pipIndex = configuredPipIndex(env)
  if (pipIndex) env[UV_DEFAULT_INDEX_ENV] = pipIndex
  const venv = env[VENV_ENV] || DEFAULT_VENV
  let runtime = env[PYTHON_ENV] || ''
  if (!runtime) runtime = await preparePython(repo)
  execFileSync(uvExecutable(env), [
    'sync',
    '--locked',
    '--all-packages',
    '--extra',
    'serve',
    '--extra',
    'dev',
    '--group',
    DESKTOP_GROUP,
    '--no-python-downloads',
    '--python',
    runtime
  ], {
    cwd: repo,
    env: { ...env, UV_PROJECT_ENVIRONMENT: venv },
    stdio: 'inherit',
    windowsHide: true
  })
  if (!env[PYTHON_ENV]) return verifyDevelopmentPython(repo, developmentPython(repo, venv))
  return { python: runtime, external: true, venv: path.resolve(repo, venv) }
}

async function main(argv) {
  const repo = path.resolve(__dirname, '..')
  if (argv[0] === 'prepare' && argv.length === 1) {
    console.log(await preparePython(repo))
  } else if (argv[0] === 'prepare-dev' && argv.length === 1) {
    console.log(JSON.stringify(await prepareDevelopmentEnvironment(repo)))
  } else if (argv[0] === 'check' && argv.length <= 2) {
    const executable = developmentPython(repo, argv[1])
    console.log(JSON.stringify(verifyDevelopmentPython(repo, executable)))
  } else {
    throw new Error('usage: node scripts/python.cjs prepare | prepare-dev | check [venv]')
  }
}

module.exports = { pythonRelease, verifyPythonArchive, inspectPython, verifyPython,
  verifyDevelopmentPython, preparePython, prepareDevelopmentEnvironment,
  developmentPython, nativeTar, sameRealPath,
  retryFilesystem, cleanupTemporary, configuredPipIndex }

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[python] ${error.message}`)
    process.exitCode = 1
  })
}
