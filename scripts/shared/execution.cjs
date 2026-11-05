const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { constants } = require('node:os')
const { packageManagerCommand, packageManagerName } = require('../pre/toolchain.cjs')

const SIGNAL_EXIT = Object.fromEntries(Object.entries(constants.signals).map(([name, number]) => [name, 128 + number]))
const GROUP_POLL_MS = 50
const GROUP_SHUTDOWN_TIMEOUT_MS = 9000
const GROUP_TERMINATE_TIMEOUT_MS = 3000
const GROUP_FORCE_TIMEOUT_MS = 1000
const PROCESS_TREE_UNCONFIRMED_EXIT = 74

class CommandError extends Error {
  constructor(code, message, exitCode = 1, details = {}) {
    super(message)
    Object.assign(this, { code, exitCode, origin: 'cli', ...details })
  }
}

function childExitCode(result) {
  return result.status ?? SIGNAL_EXIT[result.signal] ?? 1
}

function childResult(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', shell: false, windowsHide: true, ...options })
  if (result.error) throw new CommandError('PREREQUISITE_MISSING', result.error.message)
  const exitCode = childExitCode(result)
  return { ...result, exitCode }
}

function forward(executable, args, options = {}) {
  return childResult(executable, args, options).exitCode
}

function launch(executable, args, options = {}) {
  const result = childResult(executable, args, options)
  const { exitCode } = result
  if (exitCode !== 0) throw new CommandError('CHILD_EXIT', `Task exited with ${exitCode}`, exitCode,
    { origin: 'child', signal: result.signal })
  return result
}

function launchLong(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    let interrupted = null
    let settled = false
    const signalTimers = []
    const cleanup = () => {
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTermination)
      signalTimers.forEach(timer => clearTimeout(timer))
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(result)
    }
    const forward = signal => {
      if (!child?.pid) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') finish(error)
      }
    }
    const onSignal = signal => {
      interrupted ||= signal
      if (process.platform !== 'win32' || signal !== 'SIGINT') forward(signal)
      if (signalTimers.length) return
      signalTimers.push(setTimeout(() => forward('SIGTERM'), GROUP_SHUTDOWN_TIMEOUT_MS))
      signalTimers.push(setTimeout(() => forward('SIGKILL'), GROUP_SHUTDOWN_TIMEOUT_MS + GROUP_TERMINATE_TIMEOUT_MS))
    }
    const onInterrupt = () => onSignal('SIGINT')
    const onTermination = () => onSignal('SIGTERM')
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTermination)
    try {
      child = spawn(executable, args, {
        stdio: 'inherit', shell: false, windowsHide: true,
        detached: process.platform !== 'win32', ...options
      })
    } catch (error) {
      finish(new CommandError('PREREQUISITE_MISSING', error.message, 1, { shutdownConfirmed: true }))
      return
    }
    if (interrupted) forward(interrupted)
    child.once('error', error => finish(new CommandError('PREREQUISITE_MISSING', error.message, 1, { shutdownConfirmed: true })))
    child.once('close', (status, signal) => {
      const complete = async () => {
        let shutdownConfirmed = process.platform !== 'win32'
        if (shutdownConfirmed && !(await waitForGroupExit(child.pid, GROUP_SHUTDOWN_TIMEOUT_MS))) {
          signalGroup(child.pid, 'SIGTERM')
          shutdownConfirmed = await waitForGroupExit(child.pid, GROUP_TERMINATE_TIMEOUT_MS)
          if (!shutdownConfirmed) {
            signalGroup(child.pid, 'SIGKILL')
            shutdownConfirmed = await waitForGroupExit(child.pid, GROUP_FORCE_TIMEOUT_MS)
          }
        }
        if (!shutdownConfirmed && process.platform !== 'win32') {
          finish(new CommandError('SHUTDOWN_UNCONFIRMED', 'Long-running process group has not exited', 1,
            { origin: 'child', signal: interrupted || signal, shutdownConfirmed: false }))
          return
        }
        const exitCode = interrupted ? SIGNAL_EXIT[interrupted] : status ?? SIGNAL_EXIT[signal] ?? 1
        const result = { status, signal: signal || interrupted || null, exitCode, shutdownConfirmed }
        if (exitCode !== 0) finish(new CommandError('CHILD_EXIT', `Task exited with ${exitCode}`, exitCode,
          { origin: 'child', signal: result.signal, shutdownConfirmed: result.shutdownConfirmed }))
        else finish(null, result)
      }
      complete().catch(error => finish(error))
    })
  })
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}

async function waitForGroupExit(pid, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (processGroupExited(pid)) return true
    await new Promise(resolve => setTimeout(resolve, GROUP_POLL_MS))
  }
  return processGroupExited(pid)
}

function processGroupExited(pid, kill = process.kill, hasMembers = processGroupHasMembers) {
  try { kill(-pid, 0); return false }
  catch (error) {
    if (error.code === 'ESRCH') return true
    if (error.code === 'EPERM') return !hasMembers(pid)
    throw error
  }
}

function processGroupHasMembers(pid, run = spawnSync) {
  const result = run('/bin/ps', ['-axo', 'pgid='], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    const detail = result.error?.message || result.stderr?.trim() || result.signal || result.status
    throw new CommandError('SHUTDOWN_UNCONFIRMED', `Cannot inspect process-group state: ${detail}`, 1,
      { origin: 'child', shutdownConfirmed: false })
  }
  return result.stdout.split(/\r?\n/).some(value => value.trim() === String(pid))
}

function repository(directory) {
  try {
    const repo = fs.realpathSync(directory)
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
    if (pkg.name !== 'scholarseed-workspace' || !fs.statSync(path.join(repo, 'apps/desktop/package.json')).isFile()) {
      throw new Error('not a ScholarSeed checkout')
    }
    return repo
  } catch {
    throw new CommandError('REPO_INVALID', 'Select a ScholarSeed checkout with --repo <path>')
  }
}

function managerContext(options, argv, environment = process.env) {
  const current = packageManagerName(environment)
  const requested = options.packageManager || current
  if (!['npm', 'pnpm'].includes(requested)) throw new CommandError('UNSUPPORTED', 'Use the registered npm or pnpm task executor')
  const executableHint = path.basename(environment.npm_execpath || '').toLowerCase()
  const declared = String(environment.npm_config_user_agent || '').split('/')[0]
  const hinted = executableHint.includes('pnpm') ? 'pnpm' : executableHint.includes('npm') ? 'npm' : null
  if (hinted && declared && hinted !== declared) throw new CommandError('PREREQUISITE_MISSING', 'Conflicting package-manager identity')
  if (environment.npm_execpath && current === requested) return null
  const command = packageManagerCommand(environment, requested)
  if (command.name !== requested) throw new CommandError('PREREQUISITE_MISSING', 'Cannot resolve selected package manager')
  const forwarded = ['--package-manager', requested, ...argv]
  const args = [...command.args, 'run', '--silent', 'ops', ...(requested === 'npm' ? ['--'] : []), ...forwarded]
  const managerEnvironment = { ...environment }
  for (const key of ['npm_execpath', 'npm_config_user_agent', 'npm_lifecycle_event', 'npm_lifecycle_script', 'npm_command']) delete managerEnvironment[key]
  return { executable: command.executable, args, options: { cwd: options.repo, env: managerEnvironment, shell: command.shell } }
}

module.exports = { CommandError, childExitCode, launch, launchLong, forward, waitForGroupExit, processGroupExited,
  processGroupHasMembers, repository, managerContext, PROCESS_TREE_UNCONFIRMED_EXIT }
