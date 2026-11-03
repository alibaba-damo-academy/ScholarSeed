// Product wheels: lock-derived build environment, source-keyed private cache.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { timedAsync } = require('../../../../scripts/shared/timing.cjs')
const state = require('../shared/build-state.cjs')
const { protectWindowsDirectory } = require('../../../../scripts/shared/permissions.cjs')
const cache = require('./cache.cjs')
const EPOCH = '315532800'
function source(project) {
  state.noLinks(project)
  const files = []
  function scan(directory, top = false) {
    state.regular(directory, true)
    for (const name of fs.readdirSync(directory).sort()) {
      // wheel.py removes top-level build/egg-info before every fresh build.
      // Python bytecode is not a package source input.
      if ((top && (name === 'build' || name.endsWith('.egg-info'))) || name === '__pycache__' || name.endsWith('.pyc')) continue
      const file = path.join(directory, name), stat = fs.lstatSync(file)
      if (stat.isDirectory() && !stat.isSymbolicLink()) scan(file)
      else files.push({path: path.relative(project, file).split(path.sep).join('/'), sha256: state.hashFile(file)})
    }
  }
  scan(project, true)
  return state.identity(files)
}
async function withBuilder(options, operation) {
  // macOS system Temp commonly starts with /var -> /private/var. Resolve only
  // that default; explicit roots must still pass the strict no-links contract.
  const root = options.temporaryRoot ? path.resolve(options.temporaryRoot)
    : process.platform === 'darwin' ? fs.realpathSync(os.tmpdir()) : path.resolve(os.tmpdir())
  state.noLinks(root)
  const directory = fs.mkdtempSync(path.join(root, 'wb-'))
  let primary
  try {
    if (process.platform === 'win32') protectWindowsDirectory(directory)
    else fs.chmodSync(directory, 0o700)
    state.assertPrivateDirectory(directory)
    const prepared = await prepare({...options, directory: path.join(directory, 'tools')})
    return await operation(prepared)
  } catch (error) {
    primary = error
    throw error
  } finally {
    try { fs.rmSync(directory, {recursive: true, force: true}) } catch (cleanup) {
      if (primary) throw new AggregateError([primary, cleanup], 'Wheel builder and cleanup failed')
      throw cleanup
    }
  }
}
async function prepare({directory, python, uv, buildConstraints, environment, run}) {
  fs.mkdirSync(directory)
  const requirements = path.join(directory, 'requirements.txt')
  fs.writeFileSync(requirements, buildConstraints, {flag: 'wx'})
  const venv = path.join(directory, 'venv')
  const builderPython = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  run(uv, ['venv', '--python', python, '--no-python-downloads', venv], {env: environment})
  run(uv, ['pip', 'sync', '--python', builderPython, '--no-sources', '--only-binary', ':all:',
    '--require-hashes', requirements], {env: environment})
  const builder = JSON.parse(execFileSync(builderPython, ['-I', '-B', '-c',
    'import sys,importlib.metadata,json;print(json.dumps([sys.version,importlib.metadata.version("pip")]))'],
  {env: environment, encoding: 'utf8', windowsHide: true}))
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^PIP_/i.test(name)))
  Object.assign(env, {PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PIP_NO_INDEX: '1', PIP_NO_CACHE_DIR: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', SOURCE_DATE_EPOCH: EPOCH})
  return {directory, python: builderPython, builder, buildConstraints, requirements, environment: env}
}
async function build({repo, project, output, python, pythonSha256, prepared, environment, run}) {
  return timedAsync(`wheel.${path.basename(project)}`, async () => {
    const recipe = path.join(repo, 'scripts/cd/wheel.py')
    const inputs = {project: path.relative(repo, project).split(path.sep).join('/'), source: source(project),
      pythonSha256, builder: prepared.builder, buildConstraints: prepared.buildConstraints, platform: process.platform, arch: process.arch, epoch: EPOCH,
      recipe: state.hashFile(recipe), owner: state.hashFile(__filename), lock: state.hashFile(path.join(repo, 'uv.lock'))}
    const data = cache.materialize(cache.root(environment), 'wheels', inputs, directory => {
      if (fs.readFileSync(prepared.requirements, 'utf8') !== prepared.buildConstraints)
        throw new Error('wheel build constraints changed')
      run(prepared.python, ['-I', '-B', recipe, '--builder', 'pip', '--no-build-isolation', '--outdir', directory, '--project', project],
        {env: prepared.environment})
      if (source(project) !== inputs.source) throw new Error('wheel source changed during build')
      const files = fs.readdirSync(directory)
      if (files.length !== 1 || !files[0].endsWith('.whl')) throw new Error('expected one product wheel')
    })
    for (const name of fs.readdirSync(data)) fs.copyFileSync(path.join(data, name), path.join(output, name), fs.constants.COPYFILE_EXCL)
    if (state.identity(state.inventory(data)) !== state.identity(state.inventory(output))) throw new Error('wheel cache copy mismatch')
    if (source(project) !== inputs.source) throw new Error('wheel source changed during restore')
  })
}
module.exports = { source, withBuilder, build }
