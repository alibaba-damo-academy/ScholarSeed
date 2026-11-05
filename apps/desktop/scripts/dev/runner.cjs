const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const leases = require('../../../../scripts/shared/lease.cjs')
const python = require('../../../../scripts/shared/python.cjs')
const toolchain = require('../../../../scripts/pre/toolchain.cjs')
const { waitForGroupExit, PROCESS_TREE_UNCONFIRMED_EXIT } = require('../../../../scripts/shared/execution.cjs')

const DESKTOP = path.resolve(__dirname, '../..')
const ROOT = path.resolve(DESKTOP, '../..')
const DEVELOPMENT_STOP = 'development-stop'
const DEVELOPMENT_STOPPED = 'development-stopped'
const DEVELOPMENT_PROTOCOL_VERSION = 1
const MAX_EXIT_STATUS = 255

function desktopPythonPrefix(environment = process.env) {
  const repo = path.resolve(environment.SCHOLARSEED_REPO || ROOT)
  const executable = environment.SCHOLARSEED_PYTHON
    ? toolchain.executable(environment.SCHOLARSEED_PYTHON, environment, repo)
    : path.join(repo, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
  const prefix = python.inspectPython(executable).prefix
  if (!path.isAbsolute(prefix)) throw new Error('Desktop Python reported a non-absolute environment prefix')
  return { executable, prefix }
}

function command(binary, args) {
  if (binary === 'development') return path.join(__dirname, 'supervision.mjs')
  const packagePath = require.resolve(`${binary}/package.json`, { paths: [DESKTOP] })
  const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const entry = manifest.bin?.[binary]
  if (!entry) throw new Error(`missing ${binary} executable entry`)
  return path.resolve(path.dirname(packagePath), entry)
}

function main(argv = process.argv.slice(2), acquire = leases.acquire) {
  const [kind, binary, ...args] = argv
  if (!['desktop', 'modules'].includes(kind) || !binary) throw new Error('invalid leased Desktop command')
  if (binary === 'development' && kind !== 'desktop') throw new Error('development requires the full Desktop environment lease')
  const resources = [path.join(DESKTOP, 'node_modules')]
  let python
  if (kind === 'desktop') {
    python = desktopPythonPrefix()
    resources.push(python.prefix)
  }
  const lease = acquire({ mode: 'read', resources })
  try {
    if (python) {
      const current = desktopPythonPrefix()
      if (fs.realpathSync.native(current.prefix) !== fs.realpathSync.native(python.prefix)) {
        throw new Error('Desktop Python environment changed while acquiring its lease')
      }
    }
    return start(command(binary, args), args, lease)
  }
  catch (error) { lease.release(); throw error }
}

async function start(entry, args, lease) {
  let child
  const development = entry === path.join(__dirname, 'supervision.mjs')
  const controlled = development
  let developmentStopped = false
  let invalidReceipt = false
  let interrupted = false
  let interruptCode = 130
  const forward = signal => {
    interrupted = true
    interruptCode = signal === 'SIGTERM' ? 143 : 130
    try {
      if (!child) return
      if (controlled && process.platform === 'win32') {
        if (child.connected) child.send({ kind: DEVELOPMENT_STOP, version: DEVELOPMENT_PROTOCOL_VERSION, signal }, error => {
          if (error) invalidReceipt = true
        })
        else invalidReceipt = true
      } else if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if (controlled) invalidReceipt = true
      else if (error.code !== 'ESRCH') throw error
    }
  }
  const onInterrupt = () => forward('SIGINT')
  const onTerminate = () => forward('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  try {
    child = spawn(process.execPath, [...(development ? ['--experimental-transform-types'] : []), entry, ...args], {
      cwd: DESKTOP, env: process.env, stdio: controlled ? ['ignore', 'pipe', 'pipe', 'ipc'] : 'inherit', windowsHide: true,
      detached: controlled || process.platform !== 'win32'
    })
    if (controlled) {
      child.stdout.pipe(process.stdout, { end: false })
      child.stderr.pipe(process.stderr, { end: false })
    }
    if (controlled) child.on('message', message => {
      if (developmentStopped || !message || Array.isArray(message) ||
          Object.keys(message).length !== 2 || message.kind !== DEVELOPMENT_STOPPED || message.version !== DEVELOPMENT_PROTOCOL_VERSION) {
        invalidReceipt = true
        developmentStopped = false
      } else if (!invalidReceipt) developmentStopped = true
    })
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (status, signal) => resolve({ status, signal }))
    })
    if (development && result.status === PROCESS_TREE_UNCONFIRMED_EXIT) {
      console.error(`[desktop] Development process-family shutdown unconfirmed; environment lease retained at ${lease.directory}`)
      return PROCESS_TREE_UNCONFIRMED_EXIT
    }
    if (process.platform !== 'win32' && !(await waitForGroupExit(child.pid, interrupted ? 5000 : 1000))) {
      process.kill(-child.pid, 'SIGTERM')
      if (!(await waitForGroupExit(child.pid, 2000))) process.kill(-child.pid, 'SIGKILL')
      if (!(await waitForGroupExit(child.pid, 1000))) {
        console.error(`[desktop] Process shutdown was not confirmed; environment lease retained at ${lease.directory}`)
        return 1
      }
    }
    if (controlled
      ? !developmentStopped || invalidReceipt || !windowsShutdownConfirmed(result, interrupted, true)
      : process.platform === 'win32' && !windowsShutdownConfirmed(result, interrupted)) {
      console.error(`[desktop] Process-tree shutdown was not confirmed; environment lease retained at ${lease.directory}`)
      return PROCESS_TREE_UNCONFIRMED_EXIT
    }
    lease.release()
    return interrupted ? interruptCode : result.signal ? 1 : result.status ?? 1
  } catch (error) {
    if (child?.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM') } catch (failure) { if (failure.code !== 'ESRCH') throw failure }
      if (!(await waitForGroupExit(child.pid, 3000))) {
        console.error(`[desktop] Process shutdown was not confirmed; environment lease retained at ${lease.directory}`)
        throw error
      }
    }
    if (child?.pid && (development || process.platform === 'win32')) {
      console.error(`[desktop] Process-tree shutdown was not confirmed; environment lease retained at ${lease.directory}`)
    } else lease.release()
    throw error
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
}

function windowsShutdownConfirmed(result, interrupted, developmentStopped = false) {
  if (developmentStopped) return !result.signal && Number.isInteger(result.status) && result.status >= 0 &&
    result.status <= MAX_EXIT_STATUS && result.status !== PROCESS_TREE_UNCONFIRMED_EXIT
  return !interrupted && !result.signal && result.status === 0
}

module.exports = { command, desktopPythonPrefix, main, start, waitForGroupExit, windowsShutdownConfirmed,
  DEVELOPMENT_STOP, DEVELOPMENT_STOPPED, DEVELOPMENT_PROTOCOL_VERSION }
if (require.main === module) {
  Promise.resolve().then(() => main()).then(code => { process.exitCode = code }).catch(error => {
    console.error(`[desktop] ${error.message}`)
    process.exitCode = 1
  })
}
