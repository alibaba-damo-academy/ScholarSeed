// Windows Python component recipe. Hash this owner, not unrelated bundle orchestration.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const state = require('../shared/build-state.cjs')
const buildCache = require('./cache.cjs')
const wheelBuilder = require('./wheels.cjs')
const { pythonEnvironment, pythonPlatformArguments } = require('../../../../scripts/shared/platform.cjs')
const { prepareBuildDirectoryPermissions } = require('../../../../scripts/shared/permissions.cjs')
const { execFileSync, spawnSync } = require('node:child_process')
const { sha256FileSync } = require('../../runtime/components.cjs')

const PYTHON_INDEX = 'https://mirrors.aliyun.com/pypi/simple/'
const BINARY_PACKAGES = Object.freeze(['cryptography', 'pydantic-core', 'orjson', 'rpds-py'])
const BYTECODE_COMPILER = path.join(__dirname, 'bytecode.py')
const NORMALIZER = path.join(__dirname, 'normalize.py')
const BYTECODE_TIMEOUT_MS = 5 * 60 * 1000
const SOURCE_CACHE_SCHEMA = 2
const SOURCE_PROBE_TIMEOUT_MS = 15_000
const SOURCE_ENVIRONMENT = Object.freeze(['PATH', 'CC', 'CXX', 'AR', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS',
  'LDFLAGS', 'LDSHARED', 'CL', '_CL_', 'ARCHFLAGS', 'SDKROOT', 'DEVELOPER_DIR', 'MACOSX_DEPLOYMENT_TARGET',
  '_PYTHON_HOST_PLATFORM', 'INCLUDE', 'LIB', 'LIBPATH', 'VCToolsVersion', 'VCToolsInstallDir',
  'WindowsSdkDir', 'WindowsSDKVersion', 'UCRTVersion', 'SOURCE_DATE_EPOCH'])
const SOURCE_INTERPRETER_PROBE = [
  'import json, platform, sys, sysconfig',
  'print(json.dumps({"python": platform.python_version(), "implementation": sys.implementation.name,',
  '"platform": sys.platform, "machine": platform.machine(), "cacheTag": sys.implementation.cache_tag,',
  '"soabi": sysconfig.get_config_var("SOABI") or "",',
  '"gilDisabled": sysconfig.get_config_var("Py_GIL_DISABLED") or 0}))'
].join('\n')
const DELOCATE_RUNNER = 'from delocate.cmd.delocate_wheel import main; main()'
const SOURCE_PLATFORM_POLICY = path.join(__dirname, '../../../../scripts/shared/platform.cjs')
const SOURCE_WHEEL_BUILDER = path.join(__dirname, 'wheels.cjs')
const SOURCE_WHEEL_CACHE = path.join(__dirname, 'cache.cjs')

function sourceIdentity(uv, python, environment) {
  const options = {env: environment, encoding: 'utf8', windowsHide: true, timeout: SOURCE_PROBE_TIMEOUT_MS}
  const interpreter = JSON.parse(execFileSync(python, ['-I', '-B', '-c', SOURCE_INTERPRETER_PROBE], options))
  if (!/^\d+\.\d+\.\d+$/.test(interpreter.python) ||
      ['implementation', 'platform', 'machine', 'cacheTag'].some(key =>
        typeof interpreter[key] !== 'string' || !interpreter[key]) ||
      typeof interpreter.soabi !== 'string' || ![0, 1].includes(interpreter.gilDisabled))
    throw new Error('invalid source build interpreter identity')
  const installer = execFileSync(uv, ['--version'], options).trim()
  if (!/^uv \d+\.\d+\.\d+(?:\s.*)?$/.test(installer)) throw new Error('invalid source build installer identity')
  return {schema: SOURCE_CACHE_SCHEMA, interpreter, installer,
    recipe: sha256FileSync(__filename),
    environment: state.identity(SOURCE_ENVIRONMENT.map(key => [key, environment[key] || '']))}
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options })
  if (result.error || result.status !== 0)
    throw new Error(`Python component step failed: ${path.basename(executable)} (${result.status})`)
}

function synchronize(uv, python, requirements, cwd, environment) {
  run(uv, ['pip', 'sync', '--python', python, '--index-url', PYTHON_INDEX, '--no-sources',
    '--require-hashes', '--no-build', ...pythonPlatformArguments(environment), requirements], {
    cwd, env: { ...pythonEnvironment(environment), UV_INDEX_URL: PYTHON_INDEX }
  })
}

// Runtime locks bind source bytes, but not the isolated build backend. Keep
// reviewed per-package builders separate from the host uv wheel cache.
async function repairedSource(uv, python, source, input, directory, cwd, environment, identity) {
  if (identity.interpreter.platform !== 'darwin') throw new Error('source wheel repair requires macOS')
  const selected = pythonEnvironment(environment, identity.interpreter.platform, identity.interpreter.machine)
  return wheelBuilder.withBuilder({python, uv, buildConstraints: source.buildConstraints, environment: selected, run}, async prepared => {
    const inputs = {...identity, source, minimum: selected.MACOSX_DEPLOYMENT_TARGET,
      policy: sha256FileSync(SOURCE_PLATFORM_POLICY), builder: prepared.builder,
      recipe: [identity.recipe, sha256FileSync(SOURCE_WHEEL_BUILDER), sha256FileSync(SOURCE_WHEEL_CACHE)]}
    const cached = buildCache.materialize(buildCache.root(selected), 'source-wheels', inputs, output => {
      const raw = path.join(output, 'raw'), repaired = path.join(output, 'repaired')
      fs.mkdirSync(raw)
      run(prepared.python, ['-I', '-B', '-m', 'pip', 'wheel', '--no-deps', '--no-build-isolation',
        '--require-hashes', '--no-binary', source.name, '--wheel-dir', raw, '--requirement', input],
      {cwd, env: {...prepared.environment, PIP_NO_INDEX: '0', PIP_INDEX_URL: PYTHON_INDEX}})
      const wheels = fs.readdirSync(raw)
      if (wheels.length !== 1 || !wheels[0].endsWith('.whl')) throw new Error('source build must produce exactly one wheel')
      run(prepared.python, ['-I', '-B', '-c', DELOCATE_RUNNER, '--require-archs', identity.interpreter.machine,
        '--wheel-dir', repaired, path.join(raw, wheels[0])], {cwd, env: prepared.environment})
      const fixed = fs.readdirSync(repaired)
      if (fixed.length !== 1 || !fixed[0].endsWith('.whl')) throw new Error('source repair must produce exactly one wheel')
      fs.copyFileSync(path.join(repaired, fixed[0]), path.join(output, fixed[0]), fs.constants.COPYFILE_EXCL)
      fs.rmSync(raw, {recursive: true})
      fs.rmSync(repaired, {recursive: true})
    })
    const wheels = fs.readdirSync(cached)
    if (wheels.length !== 1 || !wheels[0].endsWith('.whl')) throw new Error('invalid repaired source wheel cache')
    const wheel = path.join(cached, wheels[0])
    const requirement = path.join(directory, `${source.name}-wheel.txt`)
    fs.writeFileSync(requirement, `${source.name}==${source.version} --hash=sha256:${sha256FileSync(wheel)}\n`, {flag: 'wx'})
    run(uv, ['pip', 'install', '--python', python, '--no-index', '--find-links', cached, '--no-deps', '--require-hashes', '--reinstall-package', source.name,
      '--requirement', requirement], {cwd, env: selected})
  })
}

async function installSources(uv, python, requirements, directory, cwd, environment, sourceBuilds) {
  const locked = fs.readFileSync(requirements, 'utf8')
  let identity
  for (const source of sourceBuilds) {
    const requirement = `${source.name}==${source.version}`
    const stanza = locked.split(/\r?\n(?=[a-zA-Z0-9])/).find(value =>
      value.startsWith(requirement) && /[ ;\\\r\n]|^$/.test(value.slice(requirement.length, requirement.length + 1)))
    if (!stanza || !stanza.includes(`sha256:${source.sha256}`))
      throw new Error(`source build policy differs from runtime lock: ${source.name}`)
    identity ||= sourceIdentity(uv, python, environment)
    const policy = {...identity, source}
    const input = path.join(directory, `${source.name}.txt`)
    const constraints = path.join(directory, `${source.name}-build.txt`)
    fs.writeFileSync(input, `${requirement} --hash=sha256:${source.sha256}\n`, {flag: 'wx'})
    fs.writeFileSync(constraints, source.buildConstraints, {flag: 'wx'})
    if (source.repairWheel) {
      await repairedSource(uv, python, source, input, directory, cwd, environment, identity)
      continue
    }
    // setuptools adds its own long build paths below uv's cache. A short
    // directory name is only a locator; the complete policy still binds reuse.
    const cacheDirectory = state.ensurePrivateDirectory(path.join(buildCache.root(environment),
      'python-sdists', state.identity(policy).slice(0, 16)))
    const receipt = path.join(cacheDirectory, 'source-policy.json')
    const encoded = JSON.stringify(policy)
    try { fs.writeFileSync(receipt, encoded, {flag: 'wx', mode: 0o600}) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    state.assertPrivateFile(receipt)
    if (fs.readFileSync(receipt, 'utf8') !== encoded) throw new Error('source build cache policy differs')
    run(uv, ['pip', 'install', '--python', python, '--index-url', PYTHON_INDEX, '--no-sources',
      '--no-deps', '--require-hashes', '--no-binary', source.name, '--build-constraints', constraints,
      '--cache-dir', cacheDirectory, '--requirement', input],
    {cwd, env: {...environment, UV_INDEX_URL: PYTHON_INDEX}})
  }
}

// uv 0.12.11 copy-mode persistence still uses legacy-length paths even when
// --python has an extended prefix. Install in a private short tree, then copy
// the completed tree through Node's long-path-capable filesystem boundary.
async function stageSync(uv, python, requirements, cwd, environment, temporaryRoot = os.tmpdir(), sourceBuilds) {
  state.noLinks(path.resolve(temporaryRoot))
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'py-'))
  const staged = path.join(directory, 'python')
  const original = path.dirname(python)
  let primary
  try {
    prepareBuildDirectoryPermissions(directory)
    state.assertPrivateDirectory(directory)
    fs.cpSync(original, staged, {recursive: true, errorOnExist: true, force: false})
    await installSources(uv, path.join(staged, path.basename(python)), requirements, directory, cwd, environment, sourceBuilds)
    synchronize(uv, path.join(staged, path.basename(python)), requirements, cwd, environment)
    fs.rmSync(original, {recursive: true})
    fs.cpSync(staged, original, {recursive: true, errorOnExist: true, force: false})
    return {directory}
  } catch (error) {
    primary = error
    throw error
  } finally {
    try { fs.rmSync(directory, {recursive: true, force: true}) } catch (cleanup) {
      if (primary) throw new AggregateError([primary, cleanup], 'Python staging and cleanup failed')
      throw cleanup
    }
  }
}

function executeBytecode({backend, python, compilerSha256 = sha256FileSync(BYTECODE_COMPILER)}, environment, modeArguments) {
  if (sha256FileSync(BYTECODE_COMPILER) !== compilerSha256)
    throw new Error('Python bytecode compiler changed after build inputs were frozen')
  const result = JSON.parse(execFileSync(python, ['-I', '-B', BYTECODE_COMPILER, backend, ...modeArguments], {
    encoding: 'utf8', env: environment, timeout: BYTECODE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024, windowsHide: true
  }))
  if (sha256FileSync(BYTECODE_COMPILER) !== compilerSha256)
    throw new Error('Python bytecode compiler changed during execution')
  return {...result, compiler_sha256: compilerSha256}
}

function freezeBytecode(inputs, environment) {
  return executeBytecode(inputs, environment, [])
}

function inspectBytecode(inputs, environment) {
  return executeBytecode(inputs, environment, ['--check'])
}

function finalize({repo, runDirectory, backend, python, plan, cached, installation}, environment) {
  if (sha256FileSync(BYTECODE_COMPILER) !== plan.bytecodeSha256)
    throw new Error('Python bytecode compiler changed after component identity was frozen')
  const toolsRoot = path.join(runDirectory, 'component-tools')
  const toolsPython = path.join(toolsRoot, 'Scripts', 'python.exe')
  const toolsRequirements = path.join(runDirectory, 'component-tools.txt')
  if (!cached) {
    run(plan.uv, ['export', '--locked', '--only-group', 'component-build', '--no-emit-project',
      '--no-emit-workspace', '--no-header', '--output-file', toolsRequirements], { cwd: repo, env: environment })
    run(plan.uv, ['venv', '--python', python, '--no-python-downloads', toolsRoot], { env: environment })
    run(plan.uv, ['pip', 'sync', '--python', toolsPython, '--index-url', PYTHON_INDEX, '--no-sources',
      '--only-binary', ':all:', '--require-hashes', toolsRequirements], { env: environment })
    run(toolsPython, ['-I', '-B', NORMALIZER, '--python', python, '--plan', plan.dependencyPlan], { env: environment })
  }
  const bytecode = cached?.evidence.bytecode || freezeBytecode({backend, python, compilerSha256: plan.bytecodeSha256}, environment)
  if (sha256FileSync(BYTECODE_COMPILER) !== plan.bytecodeSha256) {
    throw new Error('Python bytecode compiler changed during compilation')
  }
  if (!cached) run(toolsPython, ['-I', '-B', NORMALIZER, '--python', python, '--plan', plan.dependencyPlan, '--records-only', '--forbid-prefix', repo, '--forbid-prefix', runDirectory,
    ...(installation ? ['--forbid-prefix', installation.directory] : [])], { env: environment })
  bytecode.compiler_sha256 = plan.bytecodeSha256
  return bytecode
}

function archive(python, root, output, environment) {
  run(python, ['-I', '-B', path.join(__dirname, 'payload.py'), '--root', root,
    '--output', output, '--entry', 'python.exe', '--prefix', 'python', '--reproducible'], {env: environment})
}

module.exports = { BINARY_PACKAGES, BYTECODE_COMPILER, synchronize, installSources, stageSync, freezeBytecode, inspectBytecode, finalize, archive }
