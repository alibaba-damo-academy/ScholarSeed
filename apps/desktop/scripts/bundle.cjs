const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { PLATFORM_DIRECTORY, stageVerifiedTexlive } = require('../runtime/texlive.cjs')
const { SKILL_PYTHON_MODULE, skillPythonLauncherPath, writeSkillPythonLauncher } = require('../runtime/python.cjs')
const { nativeTar, verifyPython } = require('../../../scripts/python.cjs')
const { ensureRipgrep } = require('../../../scripts/ripgrep.cjs')
const { RUNTIME_PROBE_SCRIPT } = require('./probe.cjs')
const {
  APP_COMPONENTS_FILENAME,
  COMPONENTS_DIRNAME,
  PYLIBS_DIRNAME,
  PYTHON_ENTRY_RELATIVE,
  PYTHON_KIND,
  PYTHON_TREE_DIRNAME,
  TEXLIVE_BIN_PARENT_RELATIVE,
  TEXLIVE_KIND,
  TEXLIVE_TREE_DIRNAME,
  appComponentsManifest,
  componentArchiveName,
  componentTarget,
  consoleScriptLauncherCommand,
  derivePythonContentId,
  deriveTexliveContentId,
  packComponentArchive,
  sha256FileSync,
  skillPythonLauncherCommand,
  writeProductLibraries
} = require('../runtime/components.cjs')

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
  // win32 组件化（proposal 108 §7.1）：产品 wheel 不进组件树，解包进 backend/pylibs，
  // 运行期经 PYTHONPATH 注入。组件内容 = 解释器 + 第三方 site-packages，只随
  // python 归档/requirements/lock 这些冻结输入变化 —— 否则每改一次后端 contentId 就变、
  // 组件永不命中。
  const componentsEnabled = process.platform === 'win32'
  const pylibs = path.join(backend, PYLIBS_DIRNAME)
  if (componentsEnabled) {
    writeProductLibraries(run, python, wheels, pylibs)
  } else {
    run(uv, ['pip', 'install', '--python', python, '--no-deps', '--no-index', ...wheels], {
      cwd: wheelsRoot, env: environment
    })
  }
  fs.copyFileSync(helper, path.join(backend, VERIFIER_FILENAME))
  const evidence = JSON.parse(fs.readFileSync(inventory, 'utf8'))
  context.pythonDependencies = {
    lock_sha256: evidence.lock_sha256,
    requirements_sha256: evidence.requirements_sha256,
    inventory_sha256: crypto.createHash('sha256').update(fs.readFileSync(inventory)).digest('hex'),
    verifier_sha256: crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
    distributions: Object.keys(evidence.packages).length
  }

  // 布局探针与 verify.cjs 的包内验证共用同一份脚本文本（scripts/probe.cjs）：产品模块
  // 必须落在正确的根、site-packages 无 editable 残留；win32 还证明产品发行物没有泄漏进
  // 组件树（组件命中语义的前提）。
  run(python, componentsEnabled ? ['-s', '-B', '-c', RUNTIME_PROBE_SCRIPT] : ['-I', '-B', '-c', RUNTIME_PROBE_SCRIPT], {
    cwd: backend,
    env: componentsEnabled
      ? { ...environment, PYTHONPATH: pylibs, SCHOLARSEED_PRODUCT_LIBS: pylibs }
      : environment
  })
  fs.rmSync(wheelsRoot, { recursive: true, force: true })

  fs.mkdirSync(bin, { recursive: true })
  const ripgrep = await ensureRipgrep(context.repo, target.platform, target.arch)
  const rg = ripgrep.executable
  fs.copyFileSync(rg, path.join(bin, target.ripgrepName))
  if (process.platform !== 'win32') fs.chmodSync(path.join(bin, target.ripgrepName), 0o755)
  fs.cpSync(context.binaries.codex.root, path.join(backend, 'codex-runtime'), { recursive: true })
  // The bundled literature-review skill compiles survey PDFs with these engines,
  // so the toolchain ships with the product instead of depending on the user's
  // machine having TeX. Staging verifies the reviewed archive digest, asserts
  // every declared engine is executable, and probes the reported versions.
  context.texlive = await stageVerifiedTexlive(backend, path.resolve(__dirname, '..'),
    target.platform, target.arch)
  if (componentsEnabled) {
    // contentId 由决定组件内容的冻结输入派生（内容寻址，跨构建可复现）；packWindowsComponents
    // 在所有需要松散树的验证步骤之后才真正打包并删除它们。
    const componentTargetName = componentTarget('win32', process.arch)
    context.componentPlan = {
      target: componentTargetName,
      pythonContentId: derivePythonContentId({
        target: componentTargetName,
        pythonArchiveSha256: context.runtime.sha256,
        requirementsSha256: context.pythonDependencies.requirements_sha256,
        lockSha256: context.pythonDependencies.lock_sha256,
        binaryPackages: BINARY_PACKAGES
      }),
      texliveContentId: deriveTexliveContentId({
        target: componentTargetName,
        archiveSha256: context.texlive.sha256,
        texlive: context.texlive.texlive
      }),
      texliveExecutables: context.texlive.executables
    }
  }
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'node.cmd'),
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%SCHOLARSEED_ELECTRON_EXECUTABLE%" %*\r\n')
  } else {
    fs.symlinkSync(`../${target.codexRelative}`, path.join(bin, 'codex'))
    fs.copyFileSync(path.join(__dirname, 'node.sh'), path.join(bin, 'node'))
    fs.chmodSync(path.join(bin, 'node'), 0o755)
  }
  writeConsoleScriptShells(python, bin, target,
    componentsEnabled ? { pylibs, plan: context.componentPlan } : null)
  if (componentsEnabled) {
    fs.writeFileSync(skillPythonLauncherPath(bin, 'win32'),
      skillPythonLauncherCommand(context.componentPlan.target,
        context.componentPlan.pythonContentId, SKILL_PYTHON_MODULE))
  } else {
    writeSkillPythonLauncher(bin, python, target.platform)
  }
}

/**
 * win32 组件化收尾（build.cjs 在所有需要松散 python/texlive 树的验证步骤之后调用）：
 * 冻结构建期运行证据 → 打组件 zip → 写 app-components.json → 删除松散树。包内从此只有
 * 组件载荷；安装后的运行期展开与命中判定归 Desktop 的组件存储（src/main/components.ts）。
 */
function packWindowsComponents(context, args, environment) {
  const plan = context.componentPlan
  if (!plan) throw new Error('win32 packaging requires the component plan produced by bundle()')
  const backend = resourcePath(context.resourceRoot, 'backend')
  const python = resourcePath(backend, args.target.pythonRelative)
  const pylibs = path.join(backend, PYLIBS_DIRNAME)
  const probe = JSON.parse(execFileSync(python, ['-s', '-B', '-c', RUNTIME_PROBE_SCRIPT], {
    cwd: backend,
    encoding: 'utf8',
    env: {
      ...environment,
      PYTHONPATH: pylibs,
      SCHOLARSEED_PRODUCT_LIBS: pylibs,
      SCHOLARSEED_PRODUCT_MANIFEST: context.product.path
    }
  }).trim())
  const pythonEvidence = verifyPython(python, context.runtime)
  const componentsDirectory = path.join(backend, COMPONENTS_DIRNAME)
  fs.mkdirSync(componentsDirectory, { recursive: true })
  const tar = nativeTar()
  const pythonArchive = path.join(componentsDirectory, componentArchiveName(PYTHON_KIND, plan.pythonContentId))
  const texliveArchive = path.join(componentsDirectory, componentArchiveName(TEXLIVE_KIND, plan.texliveContentId))
  packComponentArchive(backend, PYTHON_TREE_DIRNAME, pythonArchive, tar)
  packComponentArchive(backend, TEXLIVE_TREE_DIRNAME, texliveArchive, tar)
  const manifest = appComponentsManifest(plan.target, [
    {
      kind: PYTHON_KIND,
      contentId: plan.pythonContentId,
      archive: path.basename(pythonArchive),
      archiveSha256: sha256FileSync(pythonArchive),
      archiveBytes: fs.statSync(pythonArchive).size,
      entry: PYTHON_ENTRY_RELATIVE
    },
    {
      kind: TEXLIVE_KIND,
      contentId: plan.texliveContentId,
      archive: path.basename(texliveArchive),
      archiveSha256: sha256FileSync(texliveArchive),
      archiveBytes: fs.statSync(texliveArchive).size,
      entry: `${TEXLIVE_BIN_PARENT_RELATIVE}/bin/${PLATFORM_DIRECTORY.win32}`,
      executables: plan.texliveExecutables
    }
  ])
  const manifestPath = path.join(componentsDirectory, APP_COMPONENTS_FILENAME)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.rmSync(path.join(backend, PYTHON_TREE_DIRNAME), { recursive: true, force: true })
  fs.rmSync(path.join(backend, TEXLIVE_TREE_DIRNAME), { recursive: true, force: true })
  return {
    target: plan.target,
    appComponentsSha256: sha256FileSync(manifestPath),
    components: manifest.components,
    buildTime: { imports: probe, python: pythonEvidence }
  }
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
function writeConsoleScriptShells(python, bin, target, component) {
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
  // win32 组件化：产品发行物的 dist-info 在 pylibs，console_scripts 也要从那里收集。
  if (component) sitePackagesRoots.push(component.pylibs)
  const commands = collectConsoleScripts(sitePackagesRoots)
  for (const [name, entry] of Object.entries(commands)) {
    // pip's entry-point contract is `module:function`; the launcher must call
    // exactly that function. Using `python -m module` would only work when the
    // module happens to have an `if __name__ == "__main__"` guard that
    // dispatches to the same function — not guaranteed for new dependencies.
    const pyLaunch = `import sys; from ${entry.module} import ${entry.function} as _entry; sys.exit(_entry())`
    if (process.platform === 'win32') {
      // 组件化布局下解释器在用户 home 的组件仓库，launcher 经 env 寻址并注入 pylibs；
      // 传统布局保留相对寻址（backend/ 内自洽）。
      const cmd = component
        ? consoleScriptLauncherCommand(component.plan.target, component.plan.pythonContentId, pyLaunch)
        : [
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

module.exports = { bundle, packWindowsComponents, BINARY_PACKAGES,
  REQUIREMENTS_FILENAME, INVENTORY_FILENAME, VERIFIER_FILENAME }
