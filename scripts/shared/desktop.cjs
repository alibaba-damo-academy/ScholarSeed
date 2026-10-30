#!/usr/bin/env node
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { packageManagerCommand, ensureNodeDependencies, checkNodeDependencies } = require('../pre/toolchain.cjs')

const repo = path.resolve(__dirname, '../..')
const commandProfiles = {
  dev: { env: { SCHOLARSEED_DEVTOOLS: '1' } }
}
const PREPARATION_COMMANDS = new Set([
  'dev', 'dev:web', 'build', 'build:web', 'preview', 'preview:web', 'shoot',
  'prepare:python', 'bundle:backend', 'package:dir', 'package',
  'package:check', 'package:distribution', 'package:dist',
  'test:e2e:mr', 'test:e2e:live', 'test:e2e:update', 'native:contract'
])
const CI_COMMANDS = new Set(['typecheck', 'test:coverage', 'i18n:test', 'i18n:check', 'build', 'test:e2e'])

function prepareDesktop(directory, argv, environment = process.env, source = {}) {
  const [command, ...forwarded] = argv
  if (!command) throw new Error('usage: node scripts/shared/desktop.cjs <npm-script> [-- ...args]')
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'apps/desktop/package.json'), 'utf8'))
  if (!Object.hasOwn(pkg.scripts, command)) throw new Error(`unknown Desktop command: ${command}`)
  if (Object.keys(source).some(key => key !== 'recipe') || source.recipe && source.recipe !== 'gitlab') throw new Error('unsupported Desktop source recipe')
  if (source.recipe === 'gitlab') {
    if (!CI_COMMANDS.has(command)) throw new Error('Desktop command has no GitLab preparation recipe')
    if (command === 'test:e2e' && (forwarded.length !== 1 || forwarded[0] !== '--project=smoke')) {
      throw new Error('GitLab Desktop E2E requires only the fixed smoke project')
    }
  } else if (PREPARATION_COMMANDS.has(command)) ensureNodeDependencies(directory)
  else checkNodeDependencies(directory)
  const profile = Object.hasOwn(commandProfiles, command) ? commandProfiles[command] : undefined
  const runArgs = ['run', command]
  if (forwarded.length) {
    if (packageManagerCommand(environment).name === 'npm') runArgs.push('--')
    runArgs.push(...forwarded)
  }
  const env = { ...profile?.env, ...environment }
  const manager = packageManagerCommand(env)
  return {
    executable: manager.executable, args: [...manager.args, ...runArgs],
    options: { cwd: path.join(directory, 'apps', 'desktop'), stdio: 'inherit', env,
      windowsHide: true, shell: manager.shell }
  }
}
function runDesktop(directory, argv, environment = process.env, source = {}) {
  const invocation = prepareDesktop(directory, argv, environment, source)
  const result = spawnSync(invocation.executable, invocation.args, invocation.options)
  if (result.error) throw result.error
  return result.status ?? 1
}
module.exports = { runDesktop, prepareDesktop }
if (require.main === module) {
  try { process.exitCode = runDesktop(repo, process.argv.slice(2)) }
  catch (error) { console.error(`[desktop] ${error.message}`); process.exitCode = 1 }
}
