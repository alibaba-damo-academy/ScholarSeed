const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { stageVerifiedTexlive } = require('../runtime/texlive.cjs')
const { writeSkillPythonLauncher } = require('../runtime/python.cjs')

const PROJECTS = [
  ['runtime', 'packages/runtime'],
  ['damoatrace', 'packages/damoatrace'],
  ['codex', 'packages/adapters/codex'],
  ['serve', 'apps/serve']
]
const PYTHON_INDEX = 'https://mirrors.aliyun.com/pypi/simple/'
const BINARY_PACKAGES = ['cryptography', 'pydantic-core', 'orjson', 'rpds-py']
const REQUIREMENTS_FILENAME = 'python-requirements.txt'
const INVENTORY_FILENAME = 'python-dependencies.json'
const VERIFIER_FILENAME = 'dependencies.py'

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options })
  if (result.error || result.status !== 0) {
    throw new Error(`backend bundle step failed: ${path.basename(executable)} (${result.status})`)
  }
}

function oneWheel(directory, name) {
  const files = fs.readdirSync(directory).filter(filename => filename.endsWith('.whl'))
  if (files.length !== 1) throw new Error(`expected exactly one wheel for ${name}`)
  return path.join(directory, files[0])
}

function executableOnPath(name) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : ''
  const command = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  const result = spawnSync(command, [name], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : ''
}

function resourcePath(root, relative) {
  return path.join(root, ...relative.split('/'))
}

async function bundle(context, target, environment) {
  const backend = resourcePath(context.resourceRoot, 'backend')
  const python = resourcePath(backend, target.pythonRelative)
  const defaults = resourcePath(context.resourceRoot, 'defaults')
  const config = path.join(defaults, 'config.json')
  const wheelsRoot = path.join(context.resourceRoot, '.wheels')
  const bin = path.join(backend, 'bin')
  const uv = executableOnPath(environment.UV || 'uv')
  if (!uv) throw new Error('Desktop packaging requires an independent uv executable on PATH or UV')
  const uvRelative = path.relative(backend, uv)
  if (uvRelative === '' || (!uvRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(uvRelative))) {
    throw new Error('uv must be outside the target Python environment being synchronized')
  }
  const helper = path.join(context.repo, 'scripts', VERIFIER_FILENAME)
  const requirements = path.join(backend, REQUIREMENTS_FILENAME)
  const inventory = path.join(backend, INVENTORY_FILENAME)
  const plan = path.join(context.runDirectory, 'python-plan.json')
  run(python, ['-I', '-B', helper, 'export', '--repo', context.repo, '--uv', uv,
    '--requirements', requirements, '--plan', plan], { env: environment })

  fs.mkdirSync(defaults, { recursive: true })
  fs.copyFileSync(context.config.path, config)
  if (process.platform !== 'win32') fs.chmodSync(config, 0o600)
  fs.mkdirSync(wheelsRoot, { recursive: true })

  const wheels = []
  for (const [name, relative] of PROJECTS) {
    const output = path.join(wheelsRoot, name)
    fs.mkdirSync(output, { recursive: true })
    run(python, ['-I', '-B', path.join(context.repo, 'scripts', 'wheel.py'),
      '--builder', 'pip', '--outdir', output, '--project', path.join(context.repo, relative)], {
      env: environment
    })
    wheels.push(oneWheel(output, name))
  }

  run(uv, ['pip', 'sync', '--python', python, '--index-url', PYTHON_INDEX, '--no-sources',
    '--require-hashes', ...BINARY_PACKAGES.flatMap(name => ['--only-binary', name]), requirements], {
    cwd: wheelsRoot,
    env: { ...environment, UV_INDEX_URL: PYTHON_INDEX }
  })
  run(python, ['-I', '-B', helper, 'snapshot', '--plan', plan, '--requirements', requirements, '--output', inventory,
    ...wheels.flatMap(wheel => ['--wheel', wheel])], { env: environment })
  run(uv, ['pip', 'install', '--python', python, '--no-deps', '--no-index', ...wheels], {
    cwd: wheelsRoot, env: environment
  })
  fs.copyFileSync(helper, path.join(backend, VERIFIER_FILENAME))
  const evidence = JSON.parse(fs.readFileSync(inventory, 'utf8'))
  context.pythonDependencies = {
    lock_sha256: evidence.lock_sha256,
    requirements_sha256: evidence.requirements_sha256,
    inventory_sha256: crypto.createHash('sha256').update(fs.readFileSync(inventory)).digest('hex'),
    verifier_sha256: crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
    distributions: Object.keys(evidence.packages).length
  }

  run(python, ['-I', '-B', '-c', [
    'import importlib, json, pathlib, sysconfig',
    'root = pathlib.Path(sysconfig.get_path("purelib")).resolve()',
    'names = ("scholarseed_runtime", "damoatrace", "service.cli.serve", "scholarseed_codex")',
    'assert not list(root.glob("__editable__*")) and not list(root.glob("*.egg-link"))',
    'assert not any(json.loads(item.read_text()).get("dir_info", {}).get("editable") is True for item in root.glob("*.dist-info/direct_url.json"))',
    'assert all(pathlib.Path(importlib.import_module(name).__file__).resolve().is_relative_to(root) for name in names)'
  ].join('; ')], { env: environment })
  fs.rmSync(wheelsRoot, { recursive: true, force: true })

  fs.mkdirSync(bin, { recursive: true })
  const rg = path.join(context.repo, 'scripts', 'vendor', 'ripgrep', target.triple, target.ripgrepName)
  const checksum = fs.readFileSync(`${rg}.sha256`, 'utf8').trim().split(/\s+/)[0]
  const actual = crypto.createHash('sha256').update(fs.readFileSync(rg)).digest('hex')
  if (checksum !== actual) throw new Error('vendored ripgrep checksum is invalid')
  fs.copyFileSync(rg, path.join(bin, target.ripgrepName))
  if (process.platform !== 'win32') fs.chmodSync(path.join(bin, target.ripgrepName), 0o755)
  fs.cpSync(context.binaries.codex.root, path.join(backend, 'codex-runtime'), { recursive: true })
  // The bundled literature-review skill compiles survey PDFs with these engines,
  // so the toolchain ships with the product instead of depending on the user's
  // machine having TeX. Staging verifies the reviewed archive digest, asserts
  // every declared engine is executable, and probes the reported versions.
  context.texlive = await stageVerifiedTexlive(backend, path.resolve(__dirname, '..'),
    target.platform, target.arch)
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'node.cmd'),
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%SCHOLARSEED_ELECTRON_EXECUTABLE%" %*\r\n')
  } else {
    fs.symlinkSync(`../${target.codexRelative}`, path.join(bin, 'codex'))
    fs.copyFileSync(path.join(__dirname, 'node.sh'), path.join(bin, 'node'))
    fs.chmodSync(path.join(bin, 'node'), 0o755)
  }
  writeConsoleScriptShells(python, bin, target)
  writeSkillPythonLauncher(bin, python, target.platform)
}

// uv/pip generate installer-native launchers next to the interpreter:
// - POSIX: extensionless text scripts whose first line is an absolute shebang
//   pointing at the build-time interpreter.
// - Windows: `.exe` trampolines whose payload embeds the build-time Python
//   path (uv writes canonicalized paths; distlib writes a `#!path` header).
// Both encode the build-machine prefix and stop working when the bundled
// backend is relocated (installer install dir, Applications, ScholarSeed, …).
// We generate a second, product-owned set of launchers under backend/bin/ that
// invoke `<python> -m <module>` via a relative path, so relocation only has to
// keep the `backend/` layout intact. The uv-generated launchers stay in place
// to preserve `python-dependencies.json` inventory; PATH ordering makes ours
// win at resolution time.
function writeConsoleScriptShells(python, bin, target) {
  // pythonRelative is layout-anchored ("python/bin/python3" | "python/python.exe"),
  // so python is at <backend>/python/{bin/python3 | python.exe}. The dist-info
  // tree sits under python/lib/pythonX.Y/site-packages (POSIX) or
  // python/Lib/site-packages (Windows). We resolve pythonHome=<backend>/python
  // and then append the layout-appropriate site-packages root.
  const isPosixLayout = target.pythonRelative.startsWith('python/bin/')
  const pythonHome = isPosixLayout
    ? path.resolve(path.dirname(python), '..') // python/bin/ → python/
    : path.dirname(python) // python/python.exe → python/
  const siteRelative = isPosixLayout ? 'lib' : 'Lib/site-packages'
  const sitePackagesRoots = discoverSitePackagesRoots(pythonHome, siteRelative)
  const commands = collectConsoleScripts(sitePackagesRoots)
  for (const [name, entry] of Object.entries(commands)) {
    // pip's entry-point contract is `module:function`; the launcher must call
    // exactly that function. Using `python -m module` would only work when the
    // module happens to have an `if __name__ == "__main__"` guard that
    // dispatches to the same function — not guaranteed for new dependencies.
    const pyLaunch = `import sys; from ${entry.module} import ${entry.function} as _entry; sys.exit(_entry())`
    if (process.platform === 'win32') {
      const cmd = [
        '@echo off',
        'setlocal',
        'set "SCHOLARSEED_BRIDGE_DIR=%~dp0"',
        'if "%SCHOLARSEED_BRIDGE_DIR:~-1%"=="\\" set "SCHOLARSEED_BRIDGE_DIR=%SCHOLARSEED_BRIDGE_DIR:~0,-1%"',
        `"%~dp0..\\python\\python.exe" -c "${pyLaunch}" %*`,
        ''
      ].join('\r\n')
      fs.writeFileSync(path.join(bin, `${name}.cmd`), cmd)
    } else {
      const shell = [
        '#!/bin/sh',
        'set -eu',
        'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'export SCHOLARSEED_BRIDGE_DIR="$here"',
        `exec "$here/../python/bin/python3" -c '${pyLaunch}' "$@"`,
        ''
      ].join('\n')
      const shellPath = path.join(bin, name)
      fs.writeFileSync(shellPath, shell)
      fs.chmodSync(shellPath, 0o755)
    }
  }
}

function discoverSitePackagesRoots(pythonHome, relativeRoot) {
  const root = path.join(pythonHome, relativeRoot)
  if (!fs.existsSync(root)) return []
  // Windows: relativeRoot already points at site-packages.
  if (relativeRoot.endsWith('site-packages')) return [root]
  // POSIX: root is `.../python/lib/`; iterate pythonX.Y subdirectories.
  const versions = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('python'))
    .map(entry => path.join(root, entry.name, 'site-packages'))
    .filter(dir => fs.existsSync(dir))
  return versions
}

function collectConsoleScripts(sitePackagesRoots) {
  const scripts = {}
  for (const root of sitePackagesRoots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue
      const entryPointsPath = path.join(root, entry.name, 'entry_points.txt')
      if (!fs.existsSync(entryPointsPath)) continue
      const parsed = parseEntryPoints(fs.readFileSync(entryPointsPath, 'utf8'))
      for (const [name, target] of Object.entries(parsed.console_scripts || {})) {
        // Product shells own the console_scripts namespace for the bundle. If two
        // distributions ever registered the same name, the build should stop
        // rather than silently pick one.
        const existing = scripts[name]
        if (existing && (existing.module !== undefined) && `${existing.module}:${existing.function}` !== target) {
          throw new Error(`duplicate console_script ${name}: ${existing.module}:${existing.function} vs ${target}`)
        }
        const parts = target.split(':')
        const module = (parts[0] || '').trim()
        const func = (parts[1] || '').trim()
        if (!module || !func) throw new Error(`entry point must be module:function: ${name} = ${target}`)
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(module) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(func)) {
          throw new Error(`entry point uses unsupported identifier: ${name} = ${target}`)
        }
        scripts[name] = { module, function: func }
      }
    }
  }
  return scripts
}

function parseEntryPoints(source) {
  const groups = {}
  let current = null
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.split(/[#;]/)[0].trimEnd()
    if (!line.trim()) continue
    const section = line.match(/^\[(.+)\]\s*$/)
    if (section) {
      current = section[1].trim()
      groups[current] = groups[current] || {}
      continue
    }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const name = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (name) groups[current][name] = value
  }
  return groups
}

module.exports = { bundle, REQUIREMENTS_FILENAME, INVENTORY_FILENAME, VERIFIER_FILENAME }
