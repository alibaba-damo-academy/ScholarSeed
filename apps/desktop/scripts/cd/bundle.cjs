const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const cache = require('../shared/component-cache.cjs')
const wheelCache = require('./wheels.cjs')
const { timed, timedAsync } = require('../../../../scripts/shared/timing.cjs')
const assembly = require('./assembly.cjs')
const compression = require('./compression.cjs')
const { ARCHIVES_DIRECTORY, runtimeTreeEvidence, runtimeComponent, freezeRuntimeManifest } = require('./windows-runtime.cjs')
const { officeContentId } = require('./payload.cjs')
const { OFFICE_COMPONENT_DIRECTORY, stageOfficeComponent } = require('../pre/office-assets.cjs')
const { artifact: texliveArtifact, probe: probeTexlive, PLATFORM_DIRECTORY, stageVerifiedTexlive } = require('../../runtime/texlive.cjs')
const { artifact: powershellArtifact, probe: probePowerShell, stageVerifiedPowerShell } = require('../../runtime/powershell.cjs')
const { SKILL_PYTHON_MODULE, skillPythonLauncherPath, writeSkillPythonLauncher } = require('../../runtime/python.cjs')
const { nativeTar, verifyPython } = require('../../../../scripts/shared/python.cjs')
const { ensureRipgrep } = require('../../../../scripts/shared/ripgrep.cjs')
const { RUNTIME_PROBE_SCRIPT } = require('../shared/probe.cjs')
const {
  APP_COMPONENTS_FILENAME,
  RUNTIME_ENTRIES,
  COMPONENTS_DIRNAME,
  PYLIBS_DIRNAME,
  POWERSHELL_ENTRY_RELATIVE,
  POWERSHELL_KIND,
  POWERSHELL_TREE_DIRNAME,
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
  derivePowerShellContentId,
  deriveTexliveContentId,
  sha256FileSync,
  skillPythonLauncherCommand,
  writeProductLibraries
} = require('../../runtime/components.cjs')

const PROJECTS = [
  ['runtime', 'packages/runtime'],
  ['damoatrace', 'packages/damoatrace'],
  ['codex', 'packages/adapters/codex'],
  ['serve', 'apps/serve']
]
const PYTHON_INDEX = 'https://mirrors.aliyun.com/pypi/simple/'
const BINARY_PACKAGES = assembly.BINARY_PACKAGES
const REQUIREMENTS_FILENAME = 'python-requirements.txt'
const INVENTORY_FILENAME = 'python-dependencies.json'
const VERIFIER_FILENAME = 'dependencies.py'
const ENTRY_POINT_REFERENCE = /^([^\[\]]+?)(?:\s*\[([^\[\]]*)\])?$/
const ENTRY_POINT_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
const ENTRY_POINT_FUNCTION = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENTRY_POINT_EXTRA = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const BYTECODE_COMPILER = assembly.BYTECODE_COMPILER
const COMPONENT_ARCHIVE_ENTRIES = Object.freeze([
  'python.exe',
  path.posix.join('bin', PLATFORM_DIRECTORY.win32, 'xelatex.exe'),
  'pwsh.exe'
])

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

function uvExecutable(environment = process.env) {
  let name = environment.UV || 'uv'
  if (process.platform === 'win32') {
    // npm prepends shim directories to PATH. Native spawn cannot execute .cmd/.bat;
    // resolve the native tool instead of enabling shell interpretation.
    const extension = path.extname(name).toLowerCase()
    if (extension && extension !== '.exe') {
      throw new Error('Windows UV must select a native .exe executable')
    }
    if (!extension) name += '.exe'
  }
  if (path.isAbsolute(name)) {
    try {
      return fs.statSync(name).isFile() ? name : ''
    } catch { return '' }
  }
  const command = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  const result = spawnSync(command, [name], { encoding: 'utf8', env: environment })
  if (result.status !== 0) return ''
  return result.stdout.split(/\r?\n/).find(filename => {
    if (!filename || (process.platform === 'win32' && path.extname(filename).toLowerCase() !== '.exe')) return false
    try { return fs.statSync(filename).isFile() } catch { return false }
  }) || ''
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
  const uv = uvExecutable(environment)
  if (!uv) throw new Error('Desktop packaging requires an independent uv executable on PATH or UV')
  const uvRelative = path.relative(backend, uv)
  if (uvRelative === '' || (!uvRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(uvRelative))) {
    throw new Error('uv must be outside the target Python environment being synchronized')
  }
  const helper = path.join(context.repo, 'scripts', 'shared', VERIFIER_FILENAME)
  const requirements = path.join(backend, REQUIREMENTS_FILENAME)
  const inventory = path.join(backend, INVENTORY_FILENAME)
  const plan = path.join(context.runDirectory, 'python-plan.json')
  run(python, ['-I', '-B', helper, 'export', '--repo', context.repo, '--uv', uv,
    '--requirements', requirements, '--plan', plan], { env: environment })

  const componentsEnabled = process.platform === 'win32'
  const cacheEnabled = process.platform === 'win32' && context.componentCacheRoot
  const componentTargetName = componentsEnabled ? componentTarget('win32', process.arch) : null
  const prepared = JSON.parse(fs.readFileSync(plan, 'utf8'))
  const cacheRecipe = componentsEnabled ? cache.recipe(context.repo, {
    uv: execFileSync(uv, ['--version'], { encoding: 'utf8', env: environment }).trim()
  }) : null
  const texRecipe = componentsEnabled ? cache.recipe(context.repo, {}, TEXLIVE_KIND) : null
  const psRecipe = componentsEnabled ? cache.recipe(context.repo, {}, POWERSHELL_KIND) : null
  const recipes = { python: cacheRecipe, texlive: texRecipe, powershell: psRecipe }
  const cacheInputs = (kind, contentId, extra = {}) => ({ kind, target: componentTargetName,
    contentId, recipe: recipes[kind], ...extra })
  const pythonContentId = componentsEnabled ? derivePythonContentId({ target: componentTargetName,
    pythonArchiveSha256: context.runtime.sha256, requirementsSha256: prepared.requirements_sha256,
    lockSha256: prepared.lock_sha256, binaryPackages: BINARY_PACKAGES,
    bytecodeSha256: sha256FileSync(BYTECODE_COMPILER), recipe: cacheRecipe, skillWheels: prepared.skill_wheels.map(({path: _path, ...wheel}) => wheel) }) : null
  const pythonInputs = cacheInputs(PYTHON_KIND, pythonContentId,
    { skillWheels: prepared.skill_wheels.map(({path: _path, ...wheel}) => wheel) })
  const cachedPython = cacheEnabled ? cache.lookup(context.componentCacheRoot, pythonInputs, python, environment) : null
  if (cachedPython) cache.restore(cachedPython, backend, PYTHON_TREE_DIRNAME)
  context.componentCache = cacheEnabled ? { inputs: { python: pythonInputs }, entries: { python: cachedPython } } : null

  fs.mkdirSync(defaults, { recursive: true })
  fs.copyFileSync(context.config.path, config)
  if (process.platform !== 'win32') fs.chmodSync(config, 0o600)
  fs.mkdirSync(wheelsRoot, { recursive: true })

  const wheels = []
  await wheelCache.withBuilder({python, uv, buildConstraints: prepared.wheel_build_constraints,
    temporaryRoot: context.verificationRoot, environment, run}, async wheelTools => {
    for (const [name, relative] of PROJECTS) {
      const output = path.join(wheelsRoot, name)
      fs.mkdirSync(output, { recursive: true })
      await wheelCache.build({repo: context.repo, project: path.join(context.repo, relative),
        output, python, pythonSha256: context.runtime.sha256, prepared: wheelTools, environment, run})
      wheels.push(oneWheel(output, name))
    }
  })

  if (componentsEnabled) {
    if (cachedPython) assembly.synchronize(uv, python, requirements, wheelsRoot, environment)
    else context.pythonInstallation = assembly.stageSync(uv, python, requirements, wheelsRoot, environment,
      context.verificationRoot || undefined, prepared.source_builds)
  } else {
    assembly.installSources(uv, python, requirements, wheelsRoot, wheelsRoot, environment, prepared.source_builds)
    assembly.synchronize(uv, python, requirements, wheelsRoot, environment)
  }
  run(python, ['-I', '-B', helper, 'snapshot', '--plan', plan, '--requirements', requirements, '--output', inventory,
    ...wheels.flatMap(wheel => ['--wheel', wheel])], { env: environment })
  // win32 组件化（proposal 108 §7.1）：产品 wheel 不进组件树，解包进 backend/pylibs，
  // 运行期经 PYTHONPATH 注入。组件内容 = 解释器 + 第三方 site-packages，只随
  // python 归档/requirements/lock 这些冻结输入变化 —— 否则每改一次后端 contentId 就变、
  // 组件永不命中。
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

  // 布局探针与 verify.cjs 的包内验证共用同一份脚本文本（scripts/shared/probe.cjs）：产品模块
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
  const desktopRoot = path.resolve(__dirname, '../..')
  const selectedTex = texliveArtifact(desktopRoot, target.platform, target.arch)
  const texInputs = componentsEnabled ? cacheInputs(TEXLIVE_KIND, deriveTexliveContentId({
    target: componentTargetName, archiveSha256: selectedTex.sha256, texlive: selectedTex.texlive, recipe: texRecipe })) : null
  const cachedTex = cacheEnabled ? cache.lookup(context.componentCacheRoot, texInputs, python, environment) : null
  if (cachedTex) {
    cache.restore(cachedTex, backend, TEXLIVE_TREE_DIRNAME)
    const binDirectory = path.join(backend, ...selectedTex.bin_relative.split('/'))
    context.texlive = { binDirectory, reported: await probeTexlive(binDirectory, selectedTex.executables, selectedTex.texlive, target.platform),
      sha256: selectedTex.sha256, texlive: selectedTex.texlive, executables: selectedTex.executables }
  } else context.texlive = await stageVerifiedTexlive(backend, desktopRoot, target.platform, target.arch)
  if (componentsEnabled) {
    const selectedPS = powershellArtifact(desktopRoot, target.platform, target.arch)
    const psInputs = cacheInputs(POWERSHELL_KIND, derivePowerShellContentId({target: componentTargetName,
      archiveSha256: selectedPS.sha256, version: selectedPS.version, recipe: psRecipe }))
    const cachedPS = cacheEnabled ? cache.lookup(context.componentCacheRoot, psInputs, python, environment) : null
    if (cachedPS) {
      cache.restore(cachedPS, backend, POWERSHELL_TREE_DIRNAME)
      const executable = path.join(backend, ...selectedPS.entry.split('/'))
      context.powershell = { executable, root: path.dirname(executable), reported: await probePowerShell(executable, selectedPS.version),
        sha256: selectedPS.sha256, version: selectedPS.version }
    } else context.powershell = await stageVerifiedPowerShell(backend, desktopRoot, target.platform, target.arch)
    if (cacheEnabled) {
      Object.assign(context.componentCache.inputs, { texlive: texInputs, powershell: psInputs })
      Object.assign(context.componentCache.entries, { texlive: cachedTex, powershell: cachedPS })
    }
  }
  if (componentsEnabled) {
    // contentId 由决定组件内容的冻结输入派生（内容寻址，跨构建可复现）；packWindowsComponents
    // 在所有需要松散树的验证步骤之后才真正打包并删除它们。
    const componentTargetName = componentTarget('win32', process.arch)
    const bytecodeSha256 = sha256FileSync(BYTECODE_COMPILER)
    context.componentPlan = {
      target: componentTargetName,
      bytecodeSha256,
      recipe: cacheRecipe,
      dependencyPlan: plan,
      uv,
      pythonVersion: context.runtime.python,
      sqliteVersion: context.runtime.sqlite,
      texliveVersion: context.texlive.texlive,
      pythonContentId: derivePythonContentId({
        target: componentTargetName,
        pythonArchiveSha256: context.runtime.sha256,
        requirementsSha256: context.pythonDependencies.requirements_sha256,
        lockSha256: context.pythonDependencies.lock_sha256,
        binaryPackages: BINARY_PACKAGES,
        bytecodeSha256, recipe: cacheRecipe, skillWheels: prepared.skill_wheels.map(({path: _path, ...wheel}) => wheel)
      }),
      texliveContentId: deriveTexliveContentId({
        target: componentTargetName,
        archiveSha256: context.texlive.sha256,
        texlive: context.texlive.texlive, recipe: texRecipe
      }),
      texliveExecutables: context.texlive.executables,
      powershellContentId: derivePowerShellContentId({
        target: componentTargetName,
        archiveSha256: context.powershell.sha256,
        version: context.powershell.version, recipe: psRecipe
      }),
      powershellVersion: context.powershell.version
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
      skillPythonLauncherCommand(SKILL_PYTHON_MODULE))
  } else {
    writeSkillPythonLauncher(bin, python, target.platform)
  }
}

/** Freeze build-only cache evidence and independent versioned runtime archives. */
async function packWindowsComponents(context, args, environment) {
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
  if (sha256FileSync(BYTECODE_COMPILER) !== plan.bytecodeSha256) {
    throw new Error('Python bytecode compiler changed after component identity was frozen')
  }
  const bytecode = assembly.finalize({repo: context.repo, runDirectory: context.runDirectory, backend, python, plan,
    cached: context.componentCache?.entries.python, installation: context.pythonInstallation}, environment)
  const componentsDirectory = path.join(backend, COMPONENTS_DIRNAME)
  fs.mkdirSync(componentsDirectory, { recursive: true })
  const pythonArchive = path.join(componentsDirectory, componentArchiveName(PYTHON_KIND, plan.pythonContentId))
  const texliveArchive = path.join(componentsDirectory, componentArchiveName(TEXLIVE_KIND, plan.texliveContentId))
  const powershellArchive = path.join(componentsDirectory,
    componentArchiveName(POWERSHELL_KIND, plan.powershellContentId))
  const archives = [pythonArchive, texliveArchive, powershellArchive]
  const kinds = [PYTHON_KIND, TEXLIVE_KIND, POWERSHELL_KIND]
  for (const [index, tree] of [PYTHON_TREE_DIRNAME, TEXLIVE_TREE_DIRNAME, POWERSHELL_TREE_DIRNAME].entries()) {
    const entry = context.componentCache?.entries[kinds[index]]
    if (entry) fs.copyFileSync(entry.archive, archives[index], fs.constants.COPYFILE_EXCL)
    else if (kinds[index] === PYTHON_KIND) assembly.archive(python, path.join(backend, tree), archives[index], environment)
    else run(python, ['-I', '-B', path.join(__dirname, 'payload.py'), '--root', path.join(backend, tree),
      '--output', archives[index], '--entry', COMPONENT_ARCHIVE_ENTRIES[index], '--prefix', tree, '--reproducible'],
    { env: environment })
  }
  const fullInventory = archives.map((archive, index) => {
    const entry = context.componentCache?.entries[kinds[index]]
    return entry ? cache.reuse(archive, entry.fullInventory) : cache.measure(python, archive, environment, kinds[index], true)
  })
  const measured = fullInventory.map(cache.summary)
  if (!Array.isArray(measured) || measured.length !== 3 ||
    measured.some(item => item?.format !== 'zip' || !Number.isSafeInteger(item.expandedBytes) ||
      item.expandedBytes <= 0 || !Number.isSafeInteger(item.fileCount) || item.fileCount <= 0)) {
    throw new Error('component archive inventory is incomplete')
  }
  if (context.componentCache) for (const [index, kind] of kinds.entries()) {
    const entry = context.componentCache.entries[kind]
    if (entry && JSON.stringify(entry.inventory) !== JSON.stringify(measured[index])) throw new Error('cached component changed before packing')
    if (!entry) cache.publish(context.componentCacheRoot, context.componentCache.inputs[kind], archives[index], measured[index],
      kind === PYTHON_KIND ? {bytecode} : {}, environment)
  }
  const runtimeInventory = measured.map(({ treeSha256: _tree, ...inventory }) => inventory)
  const manifest = appComponentsManifest(plan.target, [
    {
      kind: PYTHON_KIND,
      contentId: plan.pythonContentId,
      archive: path.basename(pythonArchive),
      ...runtimeInventory[0],
      entry: PYTHON_ENTRY_RELATIVE,
      python: plan.pythonVersion,
      sqlite: plan.sqliteVersion
    },
    {
      kind: TEXLIVE_KIND,
      contentId: plan.texliveContentId,
      archive: path.basename(texliveArchive),
      ...runtimeInventory[1],
      entry: `${TEXLIVE_BIN_PARENT_RELATIVE}/bin/${PLATFORM_DIRECTORY.win32}`,
      executables: plan.texliveExecutables,
      texlive: plan.texliveVersion
    },
    {
      kind: POWERSHELL_KIND,
      contentId: plan.powershellContentId,
      archive: path.basename(powershellArchive),
      ...runtimeInventory[2],
      entry: POWERSHELL_ENTRY_RELATIVE,
      version: plan.powershellVersion
    }
  ])
  const manifestPath = path.join(componentsDirectory, APP_COMPONENTS_FILENAME)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const trees = timed('components.tree-inventory', () => Object.fromEntries(kinds.map(kind => [kind, runtimeTreeEvidence(path.join(backend, kind))])))
  const finalDirectory = path.join(context.runDirectory, ARCHIVES_DIRECTORY)
  fs.mkdirSync(finalDirectory)
  for (const [index, kind] of kinds.entries()) fs.copyFileSync(archives[index], path.join(finalDirectory, `${kind}.zip`), fs.constants.COPYFILE_EXCL)
  const codexRoot = path.join(backend, 'codex-runtime')
  const receiptPath = path.join(codexRoot, 'resolve-receipt.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  if (receipt.entrypoint !== RUNTIME_ENTRIES.codex || !/^[a-f0-9]{64}$/.test(receipt.archive_sha256 || ''))
    throw new Error('invalid vendored Codex runtime receipt')
  const desktop = path.resolve(__dirname, '../..')
  const officeRoot = await stageOfficeComponent(desktop, path.join(context.runDirectory, OFFICE_COMPONENT_DIRECTORY))
  if (!context.electron) throw new Error('Windows component assembly requires prepared Electron')
  const extraContentIds = {codex: sha256FileSync(receiptPath), office: await officeContentId(officeRoot), electron: context.electron.contentId}
  for (const [kind, root] of [['codex', codexRoot], ['office', officeRoot], ['electron', context.electron.root]]) {
    fullInventory.push(compression.pack({cacheRoot: context.componentCacheRoot, repo: context.repo, kind, target: plan.target,
      contentId: extraContentIds[kind], pythonArchiveSha256: context.runtime.sha256, python, root,
      output: path.join(finalDirectory, `${kind}.zip`), entry: RUNTIME_ENTRIES[kind]}, environment))
  }
  const allKinds = [...kinds, 'codex', 'office', 'electron']
  for (const [index, kind] of allKinds.entries()) cache.reuse(path.join(finalDirectory, `${kind}.zip`), fullInventory[index])
  const componentInputs = {...extraContentIds, ...Object.fromEntries(manifest.components.map(component => [component.kind, component.contentId]))}
  const runtimeManifest = freezeRuntimeManifest(context, args,
    allKinds.map((kind, index) => runtimeComponent(kind, fullInventory[index])))
  return {
    target: plan.target,
    appComponentsSha256: sha256FileSync(manifestPath),
    components: runtimeManifest.components,
    buildTime: { imports: probe, python: pythonEvidence, bytecode, trees, componentInputs }
  }

}

// uv/pip generate installer-native launchers next to the interpreter:
// - POSIX: extensionless text scripts whose first line is an absolute shebang
//   pointing at the build-time interpreter.
// - Windows: `.exe` trampolines whose payload embeds the build-time Python
//   path (uv writes canonicalized paths; distlib writes a `#!path` header).
// Both encode the build-machine prefix and stop working when the bundled
// backend is relocated (installer install dir, Applications, ScholarSeed, …).
// Product-owned launchers under backend/bin/
// invoke `<python> -m <module>` via a relative path, so relocation only has to
// keep the `backend/` layout intact. Windows component finalization also rebuilds
// RECORD-owned native launchers with relative interpreters before freezing bytes.
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
      // 组件化命令继承 Desktop 已选定的解释器并注入 pylibs；
      // 传统布局保留相对寻址（backend/ 内自洽）。
      const cmd = component
        ? consoleScriptLauncherCommand(pyLaunch)
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
        const reference = target.match(ENTRY_POINT_REFERENCE)
        const extras = reference?.[2]?.trim()
        if (!reference || (extras && !extras.split(',').every(extra => ENTRY_POINT_EXTRA.test(extra.trim())))) {
          throw new Error(`entry point uses unsupported identifier: ${name} = ${target}`)
        }
        const parts = reference[1].split(':')
        const module = (parts[0] || '').trim()
        const func = (parts[1] || '').trim()
        if (parts.length !== 2 || !module || !func) throw new Error(`entry point must be module:function: ${name} = ${target}`)
        if (!ENTRY_POINT_MODULE.test(module) || !ENTRY_POINT_FUNCTION.test(func)) {
          throw new Error(`entry point uses unsupported identifier: ${name} = ${target}`)
        }
        const existing = scripts[name]
        if (existing && (existing.module !== module || existing.function !== func)) {
          throw new Error(`duplicate console_script ${name}: ${existing.module}:${existing.function} vs ${target}`)
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

module.exports = { uvExecutable, bundle, packWindowsComponents, collectConsoleScripts, writeConsoleScriptShells, BINARY_PACKAGES, COMPONENT_ARCHIVE_ENTRIES,
  REQUIREMENTS_FILENAME, INVENTORY_FILENAME, VERIFIER_FILENAME }
