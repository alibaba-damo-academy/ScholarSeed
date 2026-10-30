const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { prepareDesktop } = require('../shared/desktop.cjs')
const { waitForGroupExit, PROCESS_TREE_UNCONFIRMED_EXIT } = require('../shared/execution.cjs')

const LOOPBACK = '127.0.0.1'
const MAX_PORT = 65535
const ID_LENGTH = 16
const DEBUG_ROOT = '.ss-debug'
const LOCK_FILE = 'launcher.json'
const WINDOWS = 'win32'
const SHUTDOWN_TIMEOUT_MS = 30000
const WINDOWS_SHUTDOWN_TIMEOUT_MS = 60000
const PROBE_TIMEOUT_MS = 1500
const WAIT_TIMEOUT_MS = 60000
const MAX_WAIT_TIMEOUT_MS = 600000
const WAIT_INTERVAL_MS = 250
const VITE_CLIENT_PATH = '/@vite/client'
const TERMINAL_STATES = new Set(['stopped', 'unknown', 'stale', 'orphaned'])
const STATE = Object.freeze({ stopped: 'stopped', unknown: 'unknown', starting: 'starting',
  stale: 'stale', running: 'running', orphaned: 'orphaned' })
const ISOLATION_ENV = [
  'SCHOLARSEED_HOME', 'DAMOATRACE_HOME', 'DAMOATRACE_LEDGER_ROOT',
  'SCHOLARSEED_CODEX_HOME', 'SCHOLARSEED_SERVE_URL', 'SCHOLARSEED_DEFAULT_WORKSPACE'
]
const RESTART_ROOTS = ['apps/desktop/src/main', 'apps/desktop/src/preload',
  'apps/desktop/electron.vite.config.ts', 'apps/desktop/endpoints.ts', 'apps/serve/service',
  'packages/runtime/scholarseed_runtime', 'packages/adapters']
const WATCH_EXCLUDED = new Set(['__pycache__', 'node_modules', 'out', 'dist', '.git', '.venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '__tests__'])
const WATCH_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.json', '.toml', '.yaml', '.yml'])
const WATCH_DEBOUNCE_MS = 250

function watchSourceSnapshot(directory, relative) {
  const files = new Map()
  const visit = name => {
    if (name.split(/[\\/]/).some(part => WATCH_EXCLUDED.has(part))) return
    const filename = path.join(directory, name)
    const stat = fs.lstatSync(filename, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(filename)) visit(path.posix.join(name, child))
    } else if (stat.isFile() && WATCH_EXTENSIONS.has(path.extname(name)) && !/(?:\.test\.|(?:^|[\\/])test_)/.test(name)) {
      files.set(name, createHash('sha256').update(fs.readFileSync(filename)).digest('hex'))
    }
  }
  visit(relative)
  return files
}

function watchRestartSources(directory, notify = message => console.error(message), onChanges = null) {
  const watchers = []
  const snapshots = new Map()
  const pending = new Set()
  let timer = null
  let closed = false
  const flush = () => {
    timer = null
    if (closed || !pending.size) return
    const changes = new Set()
    try {
      for (const relative of pending) {
        const before = snapshots.get(relative)
        const after = watchSourceSnapshot(directory, relative)
        for (const name of new Set([...before.keys(), ...after.keys()])) {
          if (before.get(name) !== after.get(name)) changes.add(name)
        }
        snapshots.set(relative, after)
      }
    } catch (error) {
      notify(`[debug] Source verification failed (${error.code || 'snapshot error'}). Restart manually after non-renderer changes.`)
      close()
      return
    }
    const changed = [...changes].sort()
    pending.clear()
    if (!changed.length) return
    if (onChanges) {
      notify(`[debug] ${new Date().toISOString()} Non-HMR source changed: ${JSON.stringify(changed)}; automatic reload requested.`)
      onChanges(changed)
    }
    else notify(`[debug] Non-HMR source changed: ${changed.join(', ')}. Finish the active conversation, then Ctrl+C and pnpm ops dev to restart. No process was restarted.`)
  }
  const close = () => {
    closed = true
    if (timer) clearTimeout(timer)
    pending.clear()
    for (const watcher of watchers) watcher.close()
  }
  try {
    for (const relative of RESTART_ROOTS) {
      const filename = path.join(directory, relative)
      const stat = fs.lstatSync(filename, { throwIfNoEntry: false })
      if (!stat && !WATCH_EXTENSIONS.has(path.extname(relative))) continue
      if (stat?.isSymbolicLink()) continue
      const isDirectory = stat?.isDirectory() ?? false
      const watched = isDirectory ? filename : path.dirname(filename)
      if (!fs.existsSync(watched)) continue
      snapshots.set(relative, watchSourceSnapshot(directory, relative))
      const watcher = fs.watch(watched, { recursive: isDirectory, persistent: false }, (_event, changed) => {
        const child = changed ? String(changed) : ''
        if (!isDirectory && child && child !== path.basename(filename)) return
        if (child.split(/[\\/]/).some(part => WATCH_EXCLUDED.has(part))) return
        pending.add(relative)
        if (!timer) { timer = setTimeout(flush, WATCH_DEBOUNCE_MS); timer.unref() }
      })
      watcher.on('error', error => {
        notify(`[debug] Source monitoring failed (${relative}): ${error.code || 'watch error'}. Restart manually after non-renderer changes.`)
        close()
      })
      watchers.push(watcher)
    }
    return close
  } catch (error) {
    close()
    throw error
  }
}

function debugPaths(directory, home = os.homedir()) {
  const repo = fs.realpathSync(directory)
  const id = createHash('sha256').update(repo).digest('hex').slice(0, ID_LENGTH)
  const root = path.join(home, DEBUG_ROOT, id)
  return { repo, root, home: path.join(root, 'home'), profile: path.join(root, 'electron'), lock: path.join(root, LOCK_FILE) }
}

function instanceLogs(directory, home = os.homedir()) {
  const paths = debugPaths(directory, home)
  const logs = path.join(paths.home, 'logs')
  const stat = fs.lstatSync(logs, { throwIfNoEntry: false })
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return []
  const boundary = fs.realpathSync(paths.root) + path.sep
  return fs.readdirSync(logs).filter(filename => filename.endsWith('.log')).sort().map(filename => path.join(logs, filename))
    .filter(filename => fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink() && fs.realpathSync(filename).startsWith(boundary))
}

function acquire(lock, owner) {
  let descriptor
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let existing
    try { existing = JSON.parse(fs.readFileSync(lock, 'utf8')) }
    catch { throw new Error(`debug lock is incomplete; inspect before removing: ${lock}`) }
    if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0) throw new Error(`invalid debug lock: ${lock}`)
    try { process.kill(existing.pid, 0) }
    catch (cause) {
      if (cause.code !== 'ESRCH') throw cause
      throw new Error(`stale debug lock; confirm Electron/Serve have exited before manually removing: ${lock}`)
    }
    console.log(`[debug] existing launcher PID ${existing.pid}; ${existing.port ? `CDP http://${LOOPBACK}:${existing.port}` : 'startup in progress'}`)
    return null
  }
  fs.writeFileSync(descriptor, JSON.stringify(owner))
  fs.closeSync(descriptor)
  return () => {
    const current = JSON.parse(fs.readFileSync(lock, 'utf8'))
    if (current.pid === owner.pid) fs.unlinkSync(lock)
  }
}

function freePort(port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new Error('invalid CDP port')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, LOOPBACK, () => {
      const selected = server.address().port
      server.close(error => error ? reject(error) : resolve(selected))
    })
  })
}

function debugArguments(port, profile) {
  return ['dev', '--remoteDebuggingPort', String(port), '--',
    `--remote-debugging-address=${LOOPBACK}`, `--user-data-dir=${profile}`]
}

async function inspectDebug(directory, home, deadline = Date.now() + PROBE_TIMEOUT_MS) {
  const paths = debugPaths(directory, home)
  const result = { ...paths, state: STATE.stopped, launcherAlive: false, cdpReachable: false,
    rendererReady: false, renderers: [], reason: 'launcher_missing' }
  let owner
  try { owner = JSON.parse(fs.readFileSync(paths.lock, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') { result.state = STATE.unknown; result.reason = 'lock_unreadable'; result.error = error.message }
    return result
  }
  if (!owner || owner.repo !== paths.repo || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return { ...result, state: STATE.unknown, reason: 'lock_identity_invalid', error: 'invalid launcher identity; lock preserved' }
  }
  result.pid = owner.pid
  try { process.kill(owner.pid, 0); result.launcherAlive = true }
  catch (error) {
    if (error.code !== 'ESRCH') return { ...result, state: STATE.unknown, reason: 'launcher_probe_failed', error: error.message }
  }
  result.state = result.launcherAlive ? STATE.starting : STATE.stale
  result.reason = result.launcherAlive ? 'cdp_unavailable' : 'launcher_exited'
  if (!Number.isSafeInteger(owner.port) || owner.port < 1 || owner.port > MAX_PORT) return result
  result.cdp = `http://${LOOPBACK}:${owner.port}`
  result.attachCommand = `playwright-cli -s=scholarseed-${owner.port} attach --cdp=${result.cdp}`
  const request = url => fetch(url, {
    signal: AbortSignal.timeout(Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()))), redirect: 'error'
  })
  try {
    const response = await request(`${result.cdp}/json/list`)
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`)
    const targets = await response.json()
    if (!Array.isArray(targets)) throw new Error('invalid CDP response')
    result.renderers = targets.filter(target => target && target.type === 'page' && typeof target.id === 'string' &&
      target.id.length > 0 && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url))
      .map(target => ({ id: target.id, title: target.title, url: target.url }))
    result.cdpReachable = true
    result.state = result.launcherAlive ? STATE.running : STATE.orphaned
    if (!result.launcherAlive) return result
    if (result.renderers.length !== 1) {
      result.reason = result.renderers.length ? 'renderer_ambiguous' : 'renderer_missing'
      return result
    }
    result.renderer = result.renderers[0]
    const document = await request(result.renderer.url)
    const html = await document.text()
    result.rendererReady = document.ok && (document.headers.get('content-type') || '').startsWith('text/html') && html.includes(VITE_CLIENT_PATH)
    result.reason = result.rendererReady ? 'renderer_available' : 'renderer_document_unavailable'
  } catch (error) {
    result.reason = result.cdpReachable ? 'renderer_document_unavailable' : 'cdp_unavailable'
    result.probeError = error.message
  }
  return result
}

async function waitForRenderer(directory, options = {}) {
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? WAIT_INTERVAL_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_TIMEOUT_MS ||
    !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('invalid renderer wait budget')
  const started = Date.now()
  const deadline = started + timeoutMs
  while (true) {
    const status = await inspectDebug(directory, options.home, deadline)
    const terminal = TERMINAL_STATES.has(status.state)
    const timedOut = !status.rendererReady && !terminal && Date.now() >= deadline
    if (status.rendererReady || timedOut || terminal) {
      return { ...status, timedOut, waitedMs: Date.now() - started }
    }
    await delay(Math.min(intervalMs, deadline - Date.now()))
  }
}

async function supervise(invocation, observation = {}) {
  const child = spawn(invocation.executable, invocation.args, {
    ...invocation.options, detached: process.platform !== WINDOWS
  })
  let interrupted = null
  let observing = true
  let rendererObserved = false
  let observationError = null
  let shutdownTimer
  let resolveExit
  const observationController = new AbortController()
  const monitor = observation.observe ? (async () => {
    while (observing && !rendererObserved) {
      const state = await observation.observe()
      rendererObserved ||= !!state.rendererReady
      if (observing && !rendererObserved) await delay(observation.intervalMs || WAIT_INTERVAL_MS, undefined, { signal: observationController.signal })
    }
  })().catch(error => {
    if (error.name !== 'AbortError') observationError = error
  }) : Promise.resolve()
  const closeObservation = async () => {
    observing = false
    observationController.abort()
    await monitor
  }
  const stop = () => {
    if (!child.pid) return
    if (process.platform !== WINDOWS) {
      try { process.kill(-child.pid, 'SIGINT') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  const interrupt = signal => {
    interrupted ??= signal
    if (process.platform === WINDOWS && !shutdownTimer) shutdownTimer = setTimeout(() => {
      console.error('[debug] Windows development shutdown deadline exceeded; preserve the launcher lock and task-owned process receipts.')
      child.unref()
      resolveExit?.(PROCESS_TREE_UNCONFIRMED_EXIT)
    }, observation.shutdownTimeoutMs ?? WINDOWS_SHUTDOWN_TIMEOUT_MS)
    stop()
  }
  const handleInterrupt = () => interrupt('SIGINT')
  const handleTermination = () => interrupt('SIGTERM')
  process.on('SIGINT', handleInterrupt)
  process.on('SIGTERM', handleTermination)
  try {
    let code = await new Promise((resolve, reject) => {
      resolveExit = resolve
      child.once('error', reject)
      child.once('exit', (status, signal) => resolve(status ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)))
    })
    await closeObservation()
    if (code === 0 && interrupted) code = interrupted === 'SIGINT' ? 130 : 143
    if (code === 0 && observation.observe && (!rendererObserved || observationError)) {
      console.error('[debug] Startup failed: the launcher exited before a renderer was observed ready. Inspect build/preload prerequisites; readiness is not business acceptance.')
      code = 1
    }
    stop()
    if (process.platform !== WINDOWS) {
      if (!(await waitForGroupExit(child.pid, SHUTDOWN_TIMEOUT_MS)))
        throw new Error('debug process group has not exited; lock retained, inspect task-owned processes')
    }
    return code
  } finally {
    clearTimeout(shutdownTimer)
    await closeObservation()
    process.removeListener('SIGINT', handleInterrupt)
    process.removeListener('SIGTERM', handleTermination)
  }
}

async function main(argv, directory = path.resolve(__dirname, '../..')) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.length === 1 && args[0] === '--help') {
    console.log('pnpm ops dev [--port <1-65535>]\npnpm ops dev status [--wait [--timeout <1-600000 ms>]]\nRenderer HMR; isolated persistent worktree state; duplicate launches print existing launcher.\nrendererReady means one CDP page target and an accessible Vite document, not UI/backend/model acceptance.\nCtrl+C stops the launcher; state is retained. Main/preload/backend changes compile isolated candidates before requesting idle maintenance. Windows reload requires the owned native Job and verified process-family exit; native platform acceptance remains separate.')
    return 0
  }
  if (args[0] === '--status') {
    const waiting = args[1] === '--wait'
    const hasTimeout = args.length === 4 && args[2] === '--timeout' && /^[0-9]+$/.test(args[3])
    const timeoutMs = hasTimeout ? Number(args[3]) : WAIT_TIMEOUT_MS
    if (!((args.length === 1) || (waiting && (args.length === 2 || hasTimeout))) ||
      timeoutMs < 1 || timeoutMs > MAX_WAIT_TIMEOUT_MS) throw new Error('usage: pnpm ops dev status [--wait [--timeout <1-600000 ms>]]')
    const status = waiting ? await waitForRenderer(directory, { timeoutMs }) : await inspectDebug(directory)
    console.log(JSON.stringify(status, null, 2))
    return waiting && !status.rendererReady ? (status.timedOut ? 2 : 1) : 0
  }
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^[0-9]+$/.test(args[1]) || Number(args[1]) < 1 || Number(args[1]) > MAX_PORT)) {
    throw new Error('usage: pnpm ops dev [--port <1-65535>]')
  }
  const conflicts = ISOLATION_ENV.filter(name => process.env[name])
  if (conflicts.length) throw new Error(`isolated dev refuses shared overrides: ${conflicts.join(', ')}; unset these overrides before starting dev`)
  const paths = debugPaths(directory)
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 })
  const owner = { pid: process.pid, repo: paths.repo }
  const release = acquire(paths.lock, owner)
  if (!release) return 0
  let releaseAllowed = true
  try {
    owner.port = await freePort(args.length ? Number(args[1]) : undefined)
    fs.writeFileSync(paths.lock, JSON.stringify(owner))
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 })
    fs.mkdirSync(paths.profile, { recursive: true, mode: 0o700 })
    console.log(`[debug] worktree ${paths.repo}\n[debug] Home ${paths.home}\n[debug] profile ${paths.profile}\n[debug] CDP http://${LOOPBACK}:${owner.port}\n[debug] playwright-cli -s=scholarseed-${owner.port} attach --cdp=http://${LOOPBACK}:${owner.port}`)
    const environment = { ...process.env, SCHOLARSEED_HOME: paths.home, SCHOLARSEED_REPO: paths.repo }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.NODE_OPTIONS
    const invocation = prepareDesktop(paths.repo, debugArguments(owner.port, paths.profile), environment)
    releaseAllowed = false
    const code = await supervise(invocation, { observe: () => inspectDebug(paths.repo, undefined, Date.now() + PROBE_TIMEOUT_MS) })
    if (code === PROCESS_TREE_UNCONFIRMED_EXIT) return code
    await freePort(owner.port)
    releaseAllowed = true
    return code
  } finally {
    if (releaseAllowed) release()
    else console.error(`[debug] shutdown not confirmed; lock retained: ${paths.lock}`)
  }
}

module.exports = { debugPaths, instanceLogs, acquire, freePort, debugArguments, supervise, inspectDebug, waitForRenderer, watchRestartSources, main }
if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code }).catch(error => {
    console.error(`[debug] ${error.message}`)
    process.exitCode = 1
  })
}
