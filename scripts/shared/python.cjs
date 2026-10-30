#!/usr/bin/env node
// Shared Python distribution policy for development and Desktop packaging.
const fs = require('node:fs')
const path = require('node:path')
const leases = require('./lease.cjs')
const crypto = require('node:crypto')
const { execFile, execFileSync } = require('node:child_process')
const { ensureArtifact } = require('./artifacts.cjs')

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
const CI_PLATFORM = 'linux'
const CI_CONTEXT = 'ci'
const VENV_CONFIGURATION = 'pyvenv.cfg'
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
const CI_REQUIREMENT_PROBE = [
  'import pathlib, platform, sys, tomllib',
  'from packaging.specifiers import SpecifierSet',
  'project = tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
  'requirement = project["project"]["requires-python"]',
  'if platform.python_version() not in SpecifierSet(requirement):',
  '    raise SystemExit(f"CI Python {platform.python_version()} does not satisfy {requirement}")'
].join('\n')

function pythonRelease(repo, platform = process.platform, arch = process.arch) {
  const directory = path.join(repo, ...VENDOR_DIRECTORY)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_FILENAME), 'utf8'))
  const selected = manifest.targets?.[`${platform}-${ARCH_ALIASES[arch] || arch}`]
  if (!selected) throw new Error(`no Desktop Python distribution for ${platform}/${arch}`)
  if (!VERSION_PATTERN.test(manifest.python) || !VERSION_PATTERN.test(manifest.sqlite)
      || !/^\d{8}$/.test(manifest.release)) throw new Error('invalid Python runtime manifest')
  const filename = selected.archive
  if (filename !== `cpython-${manifest.python}+${manifest.release}-${selected.triple}-install_only.tar.gz`) {
    throw new Error('Python archive name differs from its runtime manifest')
  }
  const archive = path.join(directory, filename)
  if (!SHA256_PATTERN.test(selected.sha256) || typeof selected.url !== 'string' ||
      !Number.isSafeInteger(selected.bytes) || selected.bytes <= 0) {
    throw new Error('Python archive metadata is missing or invalid')
  }
  return { ...selected, python: manifest.python, sqlite: manifest.sqlite,
    platform, archive }
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

function inspectPythonAsync(executable) {
  return new Promise((resolve, reject) => {
    execFile(executable, ['-I', '-B', '-c', PYTHON_PROBE], {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true
    }, (error, stdout) => {
      if (error) return reject(error)
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

function validatePython(actual, release) {
  for (const field of ['python', 'sqlite', 'platform', 'machine']) {
    if (actual[field] !== release[field]) {
      throw new Error(`Python runtime mismatch: ${field}=${actual[field]}, expected ${release[field]}`)
    }
  }
  return actual
}

function verifyPython(executable, release) {
  return validatePython(inspectPython(executable), release)
}

function sameRealPath(left, right, platform = process.platform) {
  const normalize = value => {
    const resolved = fs.realpathSync.native(value)
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
    validateCacheReceipt(root, release)
    const executable = archiveExecutable(root, release)
    const actual = verifyPython(executable, release)
    validateCachedPython(root, actual)
    return executable
  } catch (error) {
    throw cacheError(root, error)
  }
}

function validateCacheReceipt(root, release) {
  if (fs.readFileSync(path.join(root, CACHE_RECEIPT), 'utf8').trim() !== release.sha256) {
    throw new Error('Python cache does not match its archive')
  }
}

function validateCachedPython(root, actual) {
  if (!sameRealPath(actual.base_prefix, path.join(root, 'python'))) {
    throw new Error('cached Python uses a different base runtime')
  }
}

function cacheError(root, error) {
  return new Error(`${error.message}. Stop Desktop and Python processes using ${root}, move that cache directory aside, then run pnpm ops pre install python.`)
}

function validateDevelopmentPython(root, actual) {
  if (!sameRealPath(actual.base_prefix, path.join(root, 'python'))) {
    throw new Error(`Python base differs from the repository runtime: ${actual.base_prefix}`)
  }
  if (sameRealPath(actual.prefix, actual.base_prefix)) throw new Error('Desktop requires a project virtual environment')
  return actual
}

function developmentError(error) {
  return new Error(`${error.message}. Run pnpm ops pre install python without PYTHON to synchronize the Desktop environment.`)
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
  const release = pythonRelease(repo)
  await ensureArtifact(release.archive, release)
  await verifyPythonArchive(release)
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

function verifyDevelopmentPython(repo, executable, options = {}) {
  try {
    if (options.context === CI_CONTEXT && process.platform === CI_PLATFORM) {
      const venv = options.venv || DEFAULT_VENV
      const selected = ciPython(repo, venv, options.environment)
      const actual = inspectPython(executable)
      if (!sameRealPath(selected, executable) || !sameRealPath(actual.prefix, path.resolve(repo, venv))) {
        throw new Error('CI Python differs from the explicitly selected virtual environment')
      }
      return actual
    }
    const release = pythonRelease(repo)
    const root = cacheRoot(repo, release)
    verifyCache(root, release)
    const actual = verifyPython(executable, release)
    return validateDevelopmentPython(root, actual)
  } catch (error) {
    throw developmentError(error)
  }
}

async function verifyDevelopmentPythonAsync(repo, executable, options = {}) {
  if (options.context === CI_CONTEXT && process.platform === CI_PLATFORM) {
    return verifyDevelopmentPython(repo, executable, options)
  }
  try {
    const release = pythonRelease(repo)
    const root = cacheRoot(repo, release)
    try {
      validateCacheReceipt(root, release)
      const cached = validatePython(await inspectPythonAsync(archiveExecutable(root, release)), release)
      validateCachedPython(root, cached)
    } catch (error) {
      throw cacheError(root, error)
    }
    const actual = validatePython(await inspectPythonAsync(executable), release)
    return validateDevelopmentPython(root, actual)
  } catch (error) {
    throw developmentError(error)
  }
}

function ciPython(repo, venv = DEFAULT_VENV, environment = process.env) {
  const directory = path.resolve(repo, venv)
  if (!fs.existsSync(path.join(directory, VENV_CONFIGURATION))) {
    throw new Error(`CI requires a prepared virtual environment: ${directory}`)
  }
  const executable = execFileSync(uvExecutable(environment), [
    'python', 'find', '--offline', '--no-python-downloads', '--project', repo, directory
  ], { cwd: repo, env: environment, encoding: 'utf8', windowsHide: true,
    timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const actual = inspectPython(executable)
  if (!sameRealPath(actual.prefix, directory) || sameRealPath(actual.prefix, actual.base_prefix)) {
    throw new Error('CI Python is not owned by the explicitly selected virtual environment')
  }
  execFileSync(executable, ['-I', '-B', '-c', CI_REQUIREMENT_PROBE, path.join(repo, 'pyproject.toml')], {
    cwd: repo, env: environment, timeout: PROBE_TIMEOUT_MS, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return executable
}

function developmentPython(repo, venv = DEFAULT_VENV, options = {}) {
  if (options.context === CI_CONTEXT && process.platform === CI_PLATFORM) {
    return ciPython(repo, venv, options.environment)
  }
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
  const reservation = leases.acquire({ mode: 'write', resources: [path.resolve(repo, venv)] })
  try {
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
    const result = !env[PYTHON_ENV]
      ? verifyDevelopmentPython(repo, developmentPython(repo, venv))
      : { python: runtime, external: true, venv: path.resolve(repo, venv) }
    reservation.release()
    return result
  } catch (error) {
    error.message += `; environment write reservation retained at ${reservation.directory} (${reservation.id}); verify environment and process cleanup before manual recovery`
    throw error
  }
}

async function main(argv) {
  const repo = path.resolve(__dirname, '../..')
  if (argv[0] === 'prepare' && argv.length === 1) {
    console.log(await preparePython(repo))
  } else if (argv[0] === 'prepare-dev' && argv.length === 1) {
    console.log(JSON.stringify(await prepareDevelopmentEnvironment(repo)))
  } else if (argv[0] === 'check' && argv.length <= 2) {
    const executable = developmentPython(repo, argv[1])
    console.log(JSON.stringify(verifyDevelopmentPython(repo, executable)))
  } else {
    throw new Error('usage: node scripts/shared/python.cjs prepare | prepare-dev | check [venv]')
  }
}

module.exports = { pythonRelease, verifyPythonArchive, inspectPython, inspectPythonAsync, verifyPython,
  verifyDevelopmentPython, verifyDevelopmentPythonAsync, preparePython, prepareDevelopmentEnvironment,
  developmentPython, ciPython, nativeTar, sameRealPath,
  retryFilesystem, cleanupTemporary, configuredPipIndex }

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[python] ${error.message}`)
    process.exitCode = 1
  })
}
