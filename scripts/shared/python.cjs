#!/usr/bin/env node
// Shared Python distribution policy for development and Desktop packaging.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const leases = require('./lease.cjs')
const crypto = require('node:crypto')
const { execFile, execFileSync } = require('node:child_process')
const { ensureArtifact } = require('./artifacts.cjs')
const { pythonEnvironment, pythonPlatformArguments } = require('./platform.cjs')
const { installSources } = require('../../apps/desktop/scripts/cd/assembly.cjs')

const VENDOR_DIRECTORY = ['scripts', 'vendor', 'python-build-standalone']
const MANIFEST_FILENAME = 'manifest.json'
const CACHE_DIRECTORY = '.python'
const CACHE_RECEIPT = 'archive.sha256'
const DEFAULT_VENV = '.venv'
const SOURCE_PREPARATION_PREFIX = 'scholarseed-sources-'
const UPGRADE_DIRECTORY_PREFIX = 'upgrade-'
const PREVIOUS_ENVIRONMENT_DIRECTORY = 'previous'
const DEPENDENCY_HELPER = path.resolve(__dirname, 'dependencies.py')
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

async function preparePython(repo, environment = process.env) {
  const release = pythonRelease(repo)
  await ensureArtifact(release.archive, release, {environment})
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

function stagePreviousEnvironment(repo, directory) {
  if (!fs.existsSync(directory)) return null
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.existsSync(path.join(directory, VENV_CONFIGURATION)))
    throw new Error('existing environment has no verified previous runtime')
  const executable = developmentPython(repo, directory)
  const actual = inspectPython(executable), release = pythonRelease(repo)
  if (sameRealPath(actual.base_prefix, path.join(cacheRoot(repo, release), 'python'))) {
    verifyDevelopmentPython(repo, executable)
    return null
  }
  const previousRoot = path.dirname(actual.base_prefix), previousHash = path.basename(previousRoot)
  if (!sameRealPath(actual.prefix, directory) || !SHA256_PATTERN.test(previousHash) ||
      !sameRealPath(previousRoot, cacheRoot(repo, {sha256: previousHash})) || previousHash === release.sha256)
    throw new Error('existing environment has no verified previous runtime')
  verifyCache(previousRoot, {...release, sha256: previousHash, python: actual.python, sqlite: actual.sqlite})
  const backup = fs.mkdtempSync(path.join(path.dirname(previousRoot), UPGRADE_DIRECTORY_PREFIX))
  const previous = path.join(backup, PREVIOUS_ENVIRONMENT_DIRECTORY)
  retryFilesystem(() => fs.renameSync(directory, previous))
  return {directory, backup, previous}
}

function restorePreviousEnvironment(staged) {
  if (fs.existsSync(staged.directory)) {
    if (fs.lstatSync(staged.directory).isSymbolicLink()) throw new Error('replacement environment became a symbolic link')
    cleanupTemporary(staged.directory)
  }
  retryFilesystem(() => fs.renameSync(staged.previous, staged.directory))
  cleanupTemporary(staged.backup)
}

async function prepareDevelopmentEnvironment(repo, environment = process.env) {
  const env = pythonEnvironment(environment)
  const pipIndex = configuredPipIndex(env)
  if (pipIndex) env[UV_DEFAULT_INDEX_ENV] = pipIndex
  const venv = env[VENV_ENV] || DEFAULT_VENV
  let runtime = env[PYTHON_ENV] || ''
  if (!runtime) runtime = await preparePython(repo, env)
  const reservation = leases.acquire({ mode: 'write', resources: [path.resolve(repo, venv)] })
  let preparation
  let previous
  try {
    if (!env[PYTHON_ENV]) {
      const directory = path.resolve(repo, venv)
      previous = stagePreviousEnvironment(repo, directory)
      if (!fs.existsSync(path.join(directory, VENV_CONFIGURATION)))
        execFileSync(uvExecutable(env), ['venv', '--python', runtime, '--no-python-downloads', directory], {cwd: repo, env, stdio: 'inherit', windowsHide: true})
      const python = developmentPython(repo, venv)
      verifyDevelopmentPython(repo, python)
      preparation = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), SOURCE_PREPARATION_PREFIX))
      const requirements = path.join(preparation, 'requirements.txt'), plan = path.join(preparation, 'plan.json')
      execFileSync(python, ['-I', '-B', DEPENDENCY_HELPER, 'export', '--repo', repo,
        '--uv', uvExecutable(env), '--requirements', requirements, '--plan', plan], {cwd: repo, env, stdio: 'inherit', windowsHide: true})
      const selected = JSON.parse(fs.readFileSync(plan, 'utf8'))
      await installSources(uvExecutable(env), python, requirements, preparation, repo, env, selected.source_builds)
    }
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
      ...pythonPlatformArguments(env),
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
    if (previous) console.log(`[python] previous environment retained at ${previous.previous}`)
    return result
  } catch (error) {
    if (previous) {
      try {restorePreviousEnvironment(previous)} catch (recovery) {
        throw new AggregateError([error, recovery], `Python environment preparation and recovery failed; previous environment: ${previous.previous}`)
      }
    }
    error.message += `; environment write reservation retained at ${reservation.directory} (${reservation.id}); verify environment and process cleanup before manual recovery`
    throw error
  } finally {
    if (preparation) cleanupTemporary(preparation)
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
  retryFilesystem, cleanupTemporary, configuredPipIndex, stagePreviousEnvironment, restorePreviousEnvironment }

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`[python] ${error.message}`)
    process.exitCode = 1
  })
}
