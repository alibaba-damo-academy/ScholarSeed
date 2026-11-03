const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_VENV = '.venv'
const BUILD_TARGETS = ['apps/desktop/node_modules', 'apps/desktop/out']
const VENV_CONFIGURATION = 'pyvenv.cfg'
const VENV_INTERPRETERS = ['bin/python', 'Scripts/python.exe']

function stat(target) {
  try { return fs.lstatSync(target) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function inside(parent, target) {
  const relative = path.relative(parent, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function inspect(target) {
  const parsed = path.parse(target)
  let current = parsed.root
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const entry = stat(current)
    if (!entry) continue
    if (entry.isSymbolicLink()) throw new Error(`cleanup refuses symbolic link: ${current}`)
    if (!entry.isDirectory()) throw new Error(`cleanup requires a directory: ${current}`)
    if (fs.realpathSync(current) !== current) throw new Error(`cleanup refuses redirected path: ${current}`)
  }
  return stat(target)
}

function absoluteInput(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label} requires an explicit absolute path`)
  if (value.split(/[\\/]/).includes('..')) throw new Error(`${label} refuses parent traversal`)
  return path.resolve(value)
}

function repository(repo) {
  const target = absoluteInput(repo, 'repository')
  if (!inspect(target)) throw new Error('repository does not exist')
  return target
}

function planBuildCleanup(repo, venv) {
  const root = repository(repo)
  if (typeof venv !== 'string' || !venv.trim() || venv.split(/[\\/]/).some(component => component === '.' || component === '..')) throw new Error('invalid venv cleanup path')
  const environment = path.resolve(root, venv)
  const targets = [environment, ...BUILD_TARGETS.map(target => path.join(root, target))]
  for (const target of targets) {
    if (!inside(root, target)) throw new Error(`cleanup target must be inside repository: ${target}`)
    inspect(target)
  }
  const entry = stat(environment)
  if (!entry && venv !== DEFAULT_VENV) throw new Error('custom venv identity cannot be verified')
  if (entry) {
    const configuration = stat(path.join(environment, VENV_CONFIGURATION))
    if (!configuration || !configuration.isFile() || !/^home\s*=\s*\S+/m.test(fs.readFileSync(path.join(environment, VENV_CONFIGURATION), 'utf8'))) throw new Error('venv configuration identity missing')
    const interpreter = VENV_INTERPRETERS.some(relative => {
      const filename = path.join(environment, relative)
      inspect(path.dirname(filename))
      const executable = stat(filename)
      return executable && (executable.isFile() || (executable.isSymbolicLink() && fs.statSync(filename).isFile()))
    })
    if (!interpreter) throw new Error('venv interpreter identity missing')
  }
  for (const target of BUILD_TARGETS.map(relative => path.join(root, relative))) {
    if (environment === target || inside(environment, target) || inside(target, environment)) throw new Error('venv overlaps a fixed build target')
  }
  return targets
}

function planUserDataCleanup(repo, home) {
  const root = repository(repo)
  const target = absoluteInput(home, 'user data')
  if (target === path.parse(target).root || target === path.resolve(os.homedir()) || target === root || inside(target, root) || inside(root, target)) throw new Error(`protected user data path: ${target}`)
  return { path: target, exists: Boolean(inspect(target)) }
}

function deleteUserData(repo, home, confirmation) {
  const plan = planUserDataCleanup(repo, home)
  if (confirmation !== plan.path) throw new Error(`confirmation must exactly match preview path: ${plan.path}`)
  if (plan.exists) fs.rmSync(plan.path, { recursive: true, force: false })
}

module.exports = { planBuildCleanup, planUserDataCleanup, deleteUserData }
