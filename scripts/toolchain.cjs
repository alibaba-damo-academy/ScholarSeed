#!/usr/bin/env node
// Development tools and locked dependencies; product runtimes keep their own owners.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { developmentPython, verifyDevelopmentPython } = require('./python.cjs')
const { resolveVendoredCodex } = require('../apps/desktop/runtime/codex.cjs')

const REPO = path.resolve(__dirname, '..')
const DESKTOP_PARTS = ['apps', 'desktop']
const NODE_VERSION_FILE = '.node-version'
const PACKAGE_FILE = 'package.json'
const LOCK_FILE = 'package-lock.json'
const STAMP_PARTS = ['node_modules', '.scholarseed-package-lock.sha256']
const NPM_CLI_PARTS = ['node_modules', 'npm', 'bin', 'npm-cli.js']
const UNIX_NPM_CLI_PARTS = ['..', 'lib', ...NPM_CLI_PARTS]
const NPM_PREFIX = 'npm@'
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PROBE_TIMEOUT_MS = 15_000
const WINDOWS_PLATFORM = 'win32'
const NATIVE_EXECUTABLE_SUFFIXES = ['', '.exe', '.cmd', '.bat']
const UV_POLICY = 'pyproject.toml [tool.uv].required-version'
const PYPROJECT_FILE = 'pyproject.toml'
const UV_SECTION = '[tool.uv]'
const UV_REQUIREMENT_PATTERN = /^required-version\s*=\s*["']>=(\d+\.\d+\.\d+)["']\s*(?:#.*)?$/
const ELECTRON_PROBE = 'console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node}))'

function executable(name, environment = process.env) {
  const candidates = path.isAbsolute(name) || name.includes('/') || name.includes('\\')
    ? [path.resolve(name)]
    : (environment.PATH || '').split(path.delimiter).map(directory => path.join(directory, name))
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

function expectedVersions(repo = REPO) {
  const desktop = path.join(repo, ...DESKTOP_PARTS)
  const node = fs.readFileSync(path.join(repo, NODE_VERSION_FILE), 'utf8').trim()
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, PACKAGE_FILE), 'utf8'))
  const npm = String(pkg.packageManager || '').slice(NPM_PREFIX.length)
  if (!String(pkg.packageManager).startsWith(NPM_PREFIX) || !VERSION_PATTERN.test(npm)
      || !VERSION_PATTERN.test(node) || pkg.engines?.node !== node || pkg.engines?.npm !== npm
      || fs.readFileSync(path.join(desktop, NODE_VERSION_FILE), 'utf8').trim() !== node) {
    throw new Error('toolchain declarations disagree: .node-version, packageManager and engines')
  }
  return { node, npm }
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
  const command = npmCommand()
  return checkVersion('npm', probe(command.executable, [...command.args, '--version'], repo),
    expectedVersions(repo).npm, command.path)
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
  return { node: checkNode(repo), npm: checkNpm(repo), uv: checkUv(repo) }
}

function runNpm(args, repo = REPO) {
  const command = npmCommand()
  const result = spawnSync(command.executable, [...command.args, ...args], {
    cwd: path.join(repo, ...DESKTOP_PARTS), stdio: 'inherit', windowsHide: true
  })
  if (result.error || result.status !== 0) throw new Error(`npm ${args[0]} failed: ${result.error?.message || result.status || result.signal}`)
}

function ensureNodeDependencies(repo = REPO) {
  const tools = checkToolchain(repo)
  const desktop = path.join(repo, ...DESKTOP_PARTS)
  const marker = path.join(desktop, ...STAMP_PARTS)
  const lock = path.join(desktop, LOCK_FILE)
  const expected = `${crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')} node-v${tools.node.version} npm-v${tools.npm.version}`
  const actual = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''
  const vite = path.join(desktop, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  if (actual === expected && fs.existsSync(vite)) return tools
  runNpm(['ci', '--no-audit', '--no-fund'], repo)
  fs.writeFileSync(marker, `${expected}\n`)
  return tools
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
  } else if (action === 'npm' && args.length) {
    checkToolchain()
    runNpm(args)
  } else {
    throw new Error('usage: node scripts/toolchain.cjs check | ensure | doctor | codex | npm <args>')
  }
}

module.exports = { executable, npmCommand, expectedVersions, checkVersion, checkNode,
  checkNpm, checkUv, checkToolchain, ensureNodeDependencies, diagnose }
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(`[toolchain] ${error.message}`)
  process.exitCode = 1
})
