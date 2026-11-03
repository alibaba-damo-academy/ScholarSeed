#!/usr/bin/env node
// Development tools and locked dependencies; product runtimes keep their own owners.
const { timed } = require('../shared/timing.cjs')
const installedCache = require('../shared/dependencies.cjs')
const leases = require('../shared/lease.cjs')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { developmentPython, verifyDevelopmentPython } = require('../shared/python.cjs')
const { resolveVendoredCodex } = require('../../apps/desktop/runtime/codex.cjs')

const REPO = path.resolve(__dirname, '../..')
const DESKTOP_PARTS = ['apps', 'desktop']
const NODE_VERSION_FILE = '.node-version'
const PACKAGE_FILE = 'package.json'
const LOCK_FILE = 'package-lock.json'
const MANAGER_LOCK_FILES = { npm: LOCK_FILE, pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' }
const PNPM_CONFIG_FILE = 'pnpm-workspace.yaml'
const STAMP_PARTS = ['node_modules', '.scholarseed-package-lock.sha256']
const NPM_CLI_PARTS = ['node_modules', 'npm', 'bin', 'npm-cli.js']
const UNIX_NPM_CLI_PARTS = ['..', 'lib', ...NPM_CLI_PARTS]
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PROBE_TIMEOUT_MS = 15_000
const WINDOWS_PLATFORM = 'win32'
const NATIVE_EXECUTABLE_SUFFIXES = ['', '.exe', '.cmd', '.bat']
const DEFAULT_PACKAGE_MANAGER = 'pnpm'
const DEFAULT_PACKAGE_MANAGER_VERSION = '12.14.0'
const UV_POLICY = 'pyproject.toml [tool.uv].required-version'
const PYPROJECT_FILE = 'pyproject.toml'
const UV_SECTION = '[tool.uv]'
const UV_REQUIREMENT_PATTERN = /^required-version\s*=\s*["']>=(\d+\.\d+\.\d+)["']\s*(?:#.*)?$/
const ELECTRON_PROBE = 'console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node}))'
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies']
const MARKER_PROBLEM = 'dependency marker differs from lock/toolchain'
const STATIC_SPEC = /^(?:[~^]|[<>]=?|=)?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ALIAS_SPEC = /^npm:(?:@[^/@:\s]+\/)?[^/@:\s]+@(.+)$/

function objectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function staticDeclaration(value) {
  if (typeof value !== 'string') return false
  const range = value.match(ALIAS_SPEC)?.[1] || value
  return range.split('||').every(part => {
    const tokens = part.trim().replace(/([<>]=?|=)\s+(?=\d)/g, '$1').split(/\s+/)
    return tokens.length > 0 && tokens.every(token => STATIC_SPEC.test(token))
  })
}

function executable(name, environment = process.env, cwd = process.cwd()) {
  const candidates = path.isAbsolute(name) || name.includes('/') || name.includes('\\')
    ? [path.resolve(cwd, name)]
    : (environment.PATH || '').split(path.delimiter).map(directory => path.resolve(cwd, directory || '.', name))
  const suffixes = process.platform === WINDOWS_PLATFORM ? NATIVE_EXECUTABLE_SUFFIXES : ['']
  for (const candidate of candidates) {
    for (const suffix of suffixes) {
      const filename = candidate + suffix
      try {
        if (!fs.statSync(filename).isFile()) continue
        fs.accessSync(filename, fs.constants.X_OK)
        return fs.realpathSync(filename)
      } catch { /* Continue through the declared executable search path. */ }
    }
  }
  throw new Error(`executable not found: ${name}`)
}

function probe(command, args, repo = REPO, environment = process.env) {
  return execFileSync(command, args, { cwd: repo, encoding: 'utf8',
    env: environment, timeout: PROBE_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function npmCommand(environment = process.env) {
  const launcher = executable(environment.npm_execpath || 'npm', environment)
  const candidates = path.basename(launcher) === 'npm' || /\.cmd$|\.bat$/i.test(launcher)
    ? [path.join(path.dirname(launcher), ...NPM_CLI_PARTS),
        path.join(path.dirname(launcher), ...UNIX_NPM_CLI_PARTS)]
    : [launcher]
  const cli = candidates.find(candidate => path.basename(candidate) === 'npm-cli.js'
    && fs.existsSync(candidate) && fs.statSync(candidate).isFile())
  if (!cli) throw new Error(`npm must resolve to an installed npm-cli.js; checked: ${candidates.join(', ')}`)
  return { executable: process.execPath, args: [cli], path: cli }
}

function packageManagerName(environment = process.env) {
  const userAgent = String(environment.npm_config_user_agent || '')
  if (/^pnpm\//i.test(userAgent)) return 'pnpm'
  if (/^yarn\//i.test(userAgent)) return 'yarn'
  if (/^npm\//i.test(userAgent)) return 'npm'
  const executablePath = String(environment.npm_execpath || '').toLowerCase()
  if (executablePath.includes('pnpm')) return 'pnpm'
  if (executablePath.includes('yarn')) return 'yarn'
  if (executablePath.includes('npm')) return 'npm'
  return DEFAULT_PACKAGE_MANAGER
}

function packageManagerCommand(environment = process.env, selectedName) {
  const name = selectedName || packageManagerName(environment)
  if (!['npm', 'pnpm', 'yarn'].includes(name)) throw new Error('unsupported package manager')
  const currentName = packageManagerName(environment)
  const lookup = selectedName && currentName !== selectedName ? { ...environment, npm_execpath: undefined } : environment
  if (name === 'npm') return { ...npmCommand(lookup), name }
  const configuredLauncher = String(lookup.npm_execpath || '').toLowerCase()
  const launcher = executable(configuredLauncher.includes(name) ? lookup.npm_execpath : name, lookup)
  if (process.platform === WINDOWS_PLATFORM && /\.(cjs|mjs|js)$/i.test(launcher)) return { executable: process.execPath, args: [launcher], path: launcher, name }
  if (process.platform === WINDOWS_PLATFORM && /\.(cmd|bat)$/i.test(launcher)) {
    const candidates = [path.join(path.dirname(launcher), 'node_modules', name, 'bin', `${name}.cjs`),
      path.join(path.dirname(launcher), 'node_modules', name, 'bin', `${name}.js`)]
    const entry = candidates.find(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile())
    if (!entry) throw new Error(`resolve ${name} to its installed Node CLI or native executable before continuing`)
    return { executable: process.execPath, args: [entry], path: entry, name }
  }
  return { executable: launcher, args: [], path: launcher, name,
    shell: process.platform === WINDOWS_PLATFORM && /\.(cmd|bat)$/i.test(launcher) }
}

function expectedVersions(repo = REPO) {
  const desktop = path.join(repo, ...DESKTOP_PARTS)
  const node = fs.readFileSync(path.join(repo, NODE_VERSION_FILE), 'utf8').trim()
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, PACKAGE_FILE), 'utf8'))
  const packageManager = String(pkg.toolchain?.defaultPackageManager || '')
  const [defaultManager, defaultManagerVersion] = packageManager.split('@')
  const npm = pkg.engines?.npm || null
  if (!VERSION_PATTERN.test(node) || (npm !== null && !VERSION_PATTERN.test(npm))
      || defaultManager !== DEFAULT_PACKAGE_MANAGER
      || defaultManagerVersion !== DEFAULT_PACKAGE_MANAGER_VERSION
      || pkg.engines?.node !== node
      || fs.readFileSync(path.join(desktop, NODE_VERSION_FILE), 'utf8').trim() !== node) {
    throw new Error('toolchain declarations disagree: .node-version, toolchain.defaultPackageManager and engines.node')
  }
  return { node, npm, packageManager, defaultManager, defaultManagerVersion }
}

function checkVersion(name, actual, expected, filename) {
  if (actual !== expected) throw new Error(`${name} ${actual} at ${filename}; expected ${expected}. Install the declared ${name} version before continuing.`)
  return { version: actual, expected, path: filename }
}

function isVersionBelow(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] < minimum[index]
  }
  return false
}

function checkNode(repo = REPO) {
  return checkVersion('Node', process.versions.node, expectedVersions(repo).node, process.execPath)
}

function checkNpm(repo = REPO) {
  const expected = expectedVersions(repo).npm
  const environment = packageManagerName(process.env) === 'npm'
    ? process.env : { ...process.env, npm_execpath: 'npm' }
  try {
    const command = npmCommand(environment)
    const version = probe(command.executable, [...command.args, '--version'], repo)
    return expected ? checkVersion('npm', version, expected, command.path)
      : { version, expected: null, path: command.path }
  } catch (error) {
    if (expected) throw error
    return { version: null, expected: null, path: null }
  }
}

function checkUv(repo = REPO) {
  const filename = executable(process.env.UV || 'uv')
  // Read only the required exact pin; old uv can ignore an unrecognized config table.
  let inSection = false
  const pins = []
  for (const source of fs.readFileSync(path.join(repo, PYPROJECT_FILE), 'utf8').split(/\r?\n/)) {
    const line = source.trim()
    if (line.startsWith('[')) inSection = line === UV_SECTION
    if (inSection && UV_REQUIREMENT_PATTERN.test(line)) pins.push(line.match(UV_REQUIREMENT_PATTERN)[1])
  }
  if (pins.length !== 1) throw new Error(`${UV_POLICY} must declare one minimum version`)
  const actual = probe(filename, ['--version'], repo).split(/\s+/)[1]
  const minimum = pins[0].split('.').map(Number)
  const current = actual.split('.').map(Number)
  if (isVersionBelow(current, minimum)) {
    throw new Error(`uv ${actual} at ${filename}; requires >= ${pins[0]}`)
  }
  const checked = { version: actual, expected: pins[0], path: filename }
  // The supported uv additionally validates the entire configuration itself.
  probe(filename, ['cache', 'dir'], repo)
  return { ...checked, constraint: UV_POLICY }
}

function checkToolchain(repo = REPO) {
  const manager = packageManagerCommand()
  manager.version = probe(manager.executable, [...manager.args, '--version'], repo)
  const declared = expectedVersions(repo)
  if (manager.name === declared.defaultManager && manager.version !== declared.defaultManagerVersion) {
    throw new Error(`${manager.name} ${manager.version} at ${manager.path}; expected ${declared.defaultManagerVersion}. Install the declared ${manager.name} version before continuing.`)
  }
  return { node: checkNode(repo), npm: checkNpm(repo), manager, uv: checkUv(repo) }
}

function runPackageManager(args, repo = REPO, environment = process.env) {
  const command = packageManagerCommand(environment)
  const result = spawnSync(command.executable, [...command.args, ...args], {
    cwd: path.join(repo, ...DESKTOP_PARTS), stdio: 'inherit', windowsHide: true, env: environment, shell: command.shell
  })
  if (result.error || result.status !== 0) {
    const error = new Error(`${command.name} ${args[0]} failed: ${result.error?.message || result.status || result.signal}`)
    Object.assign(error, { exitCode: result.status ?? (result.signal === 'SIGINT' ? 130 : 1), origin: 'child', code: 'CHILD_EXIT' })
    throw error
  }
}

function runNpm(args, repo = REPO) { return runPackageManager(args, repo) }

function runPackageScript(args, directory = process.cwd(), environment = process.env) {
  const command = packageManagerCommand(environment)
  const result = spawnSync(command.executable, [...command.args, 'run', ...args], {
    cwd: directory, stdio: 'inherit', windowsHide: true, env: environment, shell: command.shell
  })
  if (result.error || result.status !== 0) {
    const error = new Error(`${command.name} run ${args[0]} failed: ${result.error?.message || result.status || result.signal}`)
    Object.assign(error, { exitCode: result.status ?? (result.signal === 'SIGINT' ? 130 : 1), origin: 'child', code: 'CHILD_EXIT' })
    throw error
  }
}

function dependencyState(repo, tools) {
  const desktop = path.join(repo, ...DESKTOP_PARTS)
  const marker = path.join(desktop, ...STAMP_PARTS)
  const lock = path.join(desktop, MANAGER_LOCK_FILES[tools.manager.name])
  const lockExists = fs.existsSync(lock)
  const input = lockExists ? lock : path.join(desktop, PACKAGE_FILE)
  const digest = crypto.createHash('sha256').update(fs.readFileSync(input))
  if (tools.manager.name !== 'npm') digest.update(fs.readFileSync(path.join(desktop, PACKAGE_FILE)))
  const config = path.join(desktop, PNPM_CONFIG_FILE)
  if (tools.manager.name === 'pnpm' && fs.existsSync(config)) digest.update(fs.readFileSync(config))
  const expected = `${digest.digest('hex')} node-v${tools.node.version} ${tools.manager.name}-v${tools.manager.version}`
  const actual = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''
  const vite = path.join(desktop, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const problems = []
  const fatal = []
  if (actual !== expected) problems.push(MARKER_PROBLEM)
  if (!fs.existsSync(vite)) problems.push('electron-vite executable missing')
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, PACKAGE_FILE), 'utf8'))
  const locked = tools.manager.name === 'npm' && lockExists ? JSON.parse(fs.readFileSync(lock, 'utf8')) : null
  const root = locked?.packages?.['']
  if (tools.manager.name === 'npm' && !objectMap(root)) fatal.push('lock root declaration missing or invalid')
  for (const field of DEPENDENCY_FIELDS) {
    const declared = Object.hasOwn(pkg, field) ? pkg[field] : {}
    const pinned = root && Object.hasOwn(root, field) ? root[field] : declared
    if (!objectMap(declared) || !objectMap(pinned)) {
      fatal.push(`${field}: dependency declaration map invalid`)
      continue
    }
    for (const name of new Set([...Object.keys(declared), ...Object.keys(pinned)])) {
      if (Object.hasOwn(declared, name) && !staticDeclaration(declared[name])) fatal.push(`${name}: unsupported declaration`)
      if (declared[name] !== pinned[name]) problems.push(`${name}: ${field} declaration differs from lock root`)
    }
  }
  problems.push(...fatal)
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const installed = path.join(desktop, 'node_modules', name, PACKAGE_FILE)
    const version = locked?.packages?.[`node_modules/${name}`]?.version
    if (!fs.existsSync(installed)) { problems.push(`${name}: installed package missing`); continue }
    if (version && JSON.parse(fs.readFileSync(installed, 'utf8')).version !== version) problems.push(`${name}: installed version differs from lock`)
  }
  return { desktop, marker, expected, problems, fatal }
}

function checkNodeDependencies(repo = REPO) {
  const tools = checkToolchain(repo)
  const state = dependencyState(repo, tools)
  if (state.problems.length) throw new Error(`${state.problems.join('; ')}. Run ${tools.manager.name} install to prepare Node dependencies explicitly.`)
  return tools
}

function ensureNodeDependencies(repo = REPO) {
  const tools = checkToolchain(repo)
  const initial = dependencyState(repo, tools)
  if (initial.fatal.length) throw new Error(initial.fatal.join('; '))
  if (!initial.problems.length) return tools
  const reservation = leases.acquire({ mode: 'write', resources: [path.join(initial.desktop, 'node_modules')] })
  let mutationStarted = false
  try {
    const current = dependencyState(repo, tools)
    if (current.fatal.length) throw new Error(current.fatal.join('; '))
    if (current.problems.length) {
      mutationStarted = true
      installNodeDependencies(repo, tools, current)
    }
    reservation.release()
    return tools
  } catch (error) {
    if (!mutationStarted) {
      reservation.release()
      throw error
    }
    error.message += `; environment write reservation retained at ${reservation.directory} (${reservation.id}); verify environment and process cleanup before manual recovery`
    throw error
  }
}

function installNodeDependencies(repo, tools, { desktop, marker, expected }) {
  const root = tools.manager.name === 'npm' && process.platform === WINDOWS_PLATFORM && process.env.SCHOLARSEED_BUILD_CACHE_ROOT
    ? process.env.SCHOLARSEED_NPM_INSTALLED_CACHE || path.join(process.env.SCHOLARSEED_BUILD_CACHE_ROOT, 'npm-installed') : null
  const command = root ? npmCommand() : null
  const inputs = root ? installedCache.inputs(repo, tools, command) : null
  const verifyState = () => {
    const remaining = dependencyState(repo, tools).problems.filter(problem => problem !== MARKER_PROBLEM)
    if (remaining.length) throw new Error(`dependency preparation failed verification: ${remaining.join('; ')}`)
  }
  const verify = () => { verifyInstalledDependencies(desktop, command); verifyState() }
  if (inputs && installedCache.restore(root, inputs, desktop, verify)) {
    fs.writeFileSync(marker, `${expected}\n`)
    return tools
  }
  const installArgs = tools.manager.name === 'npm'
    ? ['ci', '--no-audit', '--no-fund']
    : tools.manager.name === 'pnpm'
      ? ['install', ...(fs.existsSync(path.join(desktop, MANAGER_LOCK_FILES.pnpm)) ? ['--frozen-lockfile'] : [])]
      : ['install', ...(fs.existsSync(path.join(desktop, 'yarn.lock'))
        ? [Number.parseInt(tools.manager.version, 10) >= 2 ? '--immutable' : '--frozen-lockfile'] : [])]
  timed(`${tools.manager.name}.install`, () => runPackageManager(installArgs, repo))
  verifyState()
  if (inputs) {
    timed('npm.installed-probes', verify)
    timed('npm.cache-publish', () => installedCache.publish(root, inputs, desktop))
  }
  fs.writeFileSync(marker, `${expected}\n`)
  return tools
}

function verifyInstalledDependencies(desktop, command) {
  const options = { cwd: desktop, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  execFileSync(command.executable, [...command.args, 'ls', '--all', '--json'], options)
  const electron = path.join(desktop, 'node_modules', 'electron')
  const binary = path.join(electron, 'dist', fs.readFileSync(path.join(electron, 'path.txt'), 'utf8').trim())
  const actual = JSON.parse(execFileSync(binary, ['-e', ELECTRON_PROBE], {
    ...options, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }))
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, PACKAGE_FILE)))
  if (actual.electron !== pkg.devDependencies.electron) throw new Error('cached Electron version differs')
  const esbuild = `const e=require(${JSON.stringify(path.join(desktop, 'node_modules', 'esbuild'))});if(!e.transformSync('const x=1',{minify:true}).code)process.exit(1)`
  execFileSync(process.execPath, ['-e', esbuild], options)
}

async function diagnose(repo = REPO) {
  const checks = {}
  const tasks = {
    node: () => checkNode(repo), npm: () => checkNpm(repo), uv: () => checkUv(repo),
    python: () => verifyDevelopmentPython(repo, developmentPython(repo, process.env.VENV)),
    codex: async () => {
      const runtime = await resolveVendoredCodex(path.join(repo, ...DESKTOP_PARTS))
      return { version: runtime.reported_version, path: runtime.path, source: runtime.source,
        externalOverrideIgnored: Boolean(process.env.SCHOLARSEED_CODEX_EXECUTABLE) }
    },
    electron: () => {
      const directory = path.join(repo, ...DESKTOP_PARTS, 'node_modules', 'electron')
      const pkg = JSON.parse(fs.readFileSync(path.join(repo, ...DESKTOP_PARTS, PACKAGE_FILE), 'utf8'))
      const binary = path.join(directory, 'dist', fs.readFileSync(path.join(directory, 'path.txt'), 'utf8').trim())
      fs.accessSync(binary, fs.constants.X_OK)
      const actual = JSON.parse(probe(binary, ['-e', ELECTRON_PROBE], repo,
        { ...process.env, ELECTRON_RUN_AS_NODE: '1' }))
      return { ...checkVersion('Electron', actual.electron, pkg.devDependencies.electron, binary),
        embeddedNode: actual.node }
    }
  }
  for (const [name, task] of Object.entries(tasks)) {
    try { checks[name] = { ok: true, ...await task() } }
    catch (error) { checks[name] = { ok: false, error: error.message } }
  }
  return { ok: Object.values(checks).every(item => item.ok), checks }
}

async function main(argv) {
  const [action, ...args] = argv
  if (action === 'doctor' && !args.length) {
    const report = await diagnose()
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exitCode = 1
  } else if (action === 'codex' && !args.length) {
    console.log((await resolveVendoredCodex(path.join(REPO, ...DESKTOP_PARTS))).path)
  } else if (action === 'check' && !args.length) {
    console.log(JSON.stringify(checkToolchain()))
  } else if (action === 'frontend' && !args.length) {
    console.log(JSON.stringify({ node: checkNode(), npm: checkNpm() }))
  } else if (action === 'ensure' && !args.length) {
    ensureNodeDependencies()
  } else if (action === 'dependencies' && !args.length) {
    console.log(JSON.stringify(checkNodeDependencies()))
  } else if (action === 'npm' && args.length) {
    checkToolchain()
    runNpm(args)
  } else if (action === 'run' && args.length) {
    runPackageScript(args)
  } else {
    throw new Error('usage: node scripts/pre/toolchain.cjs check | dependencies | ensure | doctor | codex | npm <args> | run <script> [args]')
  }
}

module.exports = { executable, npmCommand, packageManagerName, packageManagerCommand, expectedVersions, checkVersion, checkNode,
  checkNpm, checkUv, checkToolchain, checkNodeDependencies, ensureNodeDependencies, diagnose }
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(`[toolchain] ${error.message}`)
  process.exitCode = error.exitCode ?? 1
})
