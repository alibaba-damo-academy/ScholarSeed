import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import electron from 'electron'
import { createServer } from 'vite'
import { compileCandidate, publishCandidate, candidateNative, DevelopmentPublicationRejected } from './development.mjs'
import nativePolicy from '../../native/toolchain.json' with { type: 'json' }
import { DevelopmentSupervisor } from '../../src/main/supervision.ts'
import { BackendMaintenanceRejected } from '../../src/main/backend-control.ts'
import { DEVELOPMENT_CONTROL_ARGUMENT, DEVELOPMENT_CONTROL_TIMEOUT_MS } from '../../src/main/development.ts'
import debugging from '../../../../scripts/dev/desktop.cjs'
import source from '../../../../scripts/shared/source.cjs'
import execution from '../../../../scripts/shared/execution.cjs'
import leasing from './runner.cjs'
import worker from './worker.cjs'

const DESKTOP_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const LOOPBACK = '127.0.0.1'
const POLL_MS = 250
const RELOAD_POLL_MS = 1000
const READY_TIMEOUT_MS = 60_000
const SIGNAL_STATUS = { SIGINT: 130, SIGTERM: 143 }
const WORKER_PATH = fileURLToPath(new URL('worker.cjs', import.meta.url))
const require = createRequire(import.meta.url)
const NATIVE_CACHE_PARTS = ['node_modules', '.cache', 'scholarseed-development']
const NATIVE_LIBRARY = 'lease.node'
const CACHE_COLLISIONS = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'])

function diagnostic(error) {
  return error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? ` (code=${error.code})` : ''
}

export function developmentArguments(argv) {
  if (argv.length !== 5 || argv[0] !== '--remoteDebuggingPort' || !/^[0-9]+$/.test(argv[1]) ||
      Number(argv[1]) < 1 || Number(argv[1]) > 65535 || argv[2] !== '--' ||
      argv[3] !== `--remote-debugging-address=${LOOPBACK}` || !argv[4].startsWith('--user-data-dir='))
    throw new Error('isolated development requires the registered debug port and absolute profile arguments')
  const profile = argv[4].slice('--user-data-dir='.length)
  if (!path.isAbsolute(profile) || profile.includes('\0')) throw new Error('isolated development requires an absolute profile')
  return { port: Number(argv[1]), profile }
}

export async function attemptReload(state, operations) {
  if (state.disabled || (!state.dirty && !state.pending)) return
  if (!operations.canRestart) {
    state.disabled = true
    operations.report('Automatic reload unavailable: this host has no verified process-family exit proof; the current instance is retained.')
    return
  }
  if (state.dirty) {
    if (state.pending) { await operations.dispose(state.pending.candidate); state.pending = null }
    state.dirty = false
    let snapshot
    try { snapshot = operations.snapshot() }
    catch {
      operations.report('Source snapshot unavailable before candidate compilation; source stability could not be established.')
      return
    }
    let candidate
    try { candidate = await operations.compile() }
    catch (error) {
      operations.report(`Candidate compilation failed${diagnostic(error)}; the current instance is retained. Edit the source to retry.`)
      return
    }
    try {
      if (!operations.unchanged(snapshot, operations.snapshot())) {
        await operations.dispose(candidate)
        state.dirty = true
        operations.report('Source snapshot changed during candidate compilation; the current instance is retained and the candidate will be rebuilt.')
        return
      }
      state.pending = { candidate, snapshot }
    } catch {
      await operations.dispose(candidate)
      state.dirty = true
      operations.report('Source snapshot unavailable after candidate compilation; source stability could not be established and the candidate will be rebuilt.')
      return
    }
  }
  const pending = state.pending
  if (operations.interrupted?.()) return
  let generation
  try { generation = await state.instance.control.quiesceIfIdle() }
  catch (error) {
    if (operations.rejected(error)) return
    state.disabled = true
    operations.report('Reload admission outcome unavailable; the current instance is retained until explicit exit.')
    return
  }
  let previousStopped = false
  try {
    let stable = false
    try { stable = operations.unchanged(pending.snapshot, operations.snapshot()) } catch {}
    if (!stable || operations.interrupted?.()) {
      await state.instance.control.resume(generation)
      await operations.dispose(pending.candidate)
      state.pending = null
      state.dirty = true
      return
    }
    await state.instance.control.exit(generation)
    await operations.stopped(state.instance)
    previousStopped = true
    if (operations.interrupted?.()) return
    stable = false
    try { stable = operations.unchanged(pending.snapshot, operations.snapshot()) } catch {}
    if (!stable) {
      state.instance = await operations.launch()
      await operations.ready(state.instance)
      await operations.dispose(pending.candidate)
      state.pending = null
      state.dirty = true
      return
    }
    state.publication = await operations.publish(pending.candidate)
    if (operations.interrupted?.()) {
      await state.publication.rollback({ previousStopped: true })
      state.publication = null
      return
    }
    try {
      state.instance = await operations.launch()
      await operations.ready(state.instance)
    }
    catch (error) {
      if (!operations.terminated?.(state.instance)) throw error
      await operations.stopped(state.instance)
      await state.publication.rollback({ previousStopped: true })
      state.publication = null
      state.instance = await operations.launch()
      await operations.ready(state.instance)
      await operations.dispose(pending.candidate)
      state.pending = null
      operations.report('Replacement exited before readiness; previous outputs were restored and restarted.')
      return
    }
    await state.publication.commit()
    state.publication = null
    await operations.dispose(pending.candidate)
    state.pending = null
    operations.report('Development instance restarted after verified idle admission and process exit.')
  } catch (error) {
    if (previousStopped && !state.publication && operations.publicationRestored?.(error)) {
      try {
        state.instance = await operations.launch()
        await operations.ready(state.instance)
        await operations.dispose(pending.candidate)
        state.pending = null
        operations.report('Publication was rejected with verified old outputs intact; the previous outputs were restarted.')
        return
      } catch {}
    }
    state.disabled = true
    operations.report('Reload outcome unavailable; no process was forced to stop and pending outputs are retained for diagnosis.')
  }
}

export async function finishHost(state, operations) {
  let failed = false
  let stopped = !state.instance
  const protect = async operation => {
    try { await operation(); return true }
    catch { failed = true; return false }
  }
  await protect(operations.closeWatcher)
  if (state.instance) {
    if (operations.interrupted && (!state.instance.result || state.instance.family)) await protect(() => operations.signal(state.instance))
    stopped = await protect(() => operations.stopped(state.instance))
  }
  if (stopped && state.publication) {
    if (await protect(() => state.publication.rollback({ previousStopped: true }))) state.publication = null
  }
  await protect(() => operations.receipt(failed || state.publication ? 'retained' : 'settling'))
  await protect(() => state.instance?.control.close())
  await protect(operations.closeRenderer)
  if (!failed && !state.publication) {
    await protect(operations.dispose)
    if (!failed) await protect(operations.removeReceipt)
  }
  if (failed || state.publication) {
    await protect(() => operations.receipt('retained'))
    return execution.PROCESS_TREE_UNCONFIRMED_EXIT
  }
  return null
}

async function waitStopped(instance) {
  let timer
  try {
    await Promise.race([instance.closed, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('development child exit unconfirmed')), DEVELOPMENT_CONTROL_TIMEOUT_MS)
    })])
  } finally { clearTimeout(timer) }
  if (!instance.child.pid && instance.result?.spawnError) { instance.control.close(); return }
  if (instance.family) {
    const deadline = Date.now() + DEVELOPMENT_CONTROL_TIMEOUT_MS
    while (instance.family.active() !== 0) {
      if (Date.now() >= deadline) throw new Error('development Windows Job exit unconfirmed')
      await delay(POLL_MS)
    }
    instance.family.close()
    instance.family = null
    instance.familyClosed = true
  } else if (!instance.familyClosed && (process.platform === 'win32' || !await execution.waitForGroupExit(instance.child.pid, DEVELOPMENT_CONTROL_TIMEOUT_MS))) {
    throw new Error('development process-family exit unconfirmed')
  }
  instance.control.close()
  instance.child.stdin.destroy()
}

export function spawnWorker({ executable, root, settings, environment, bootstrap, control, native }) {
  const env = { ...environment }
  for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID']) delete env[name]
  const child = spawn(process.execPath, [WORKER_PATH, '--executable', executable, '--root', root,
    '--port', String(settings.port), '--profile', settings.profile], {
    cwd: root, env, stdio: ['pipe', 'inherit', 'inherit', 'ipc'], windowsHide: true, detached: false
  })
  const instance = { child, control, result: null, family: null, protocolError: false, electronPid: null }
  let granted = false
  let phase = 'starting'
  let resolvePrepared
  let rejectPrepared
  const timer = setTimeout(() => failed(), DEVELOPMENT_CONTROL_TIMEOUT_MS)
  const failed = () => {
    clearTimeout(timer)
    instance.protocolError = true
    rejectPrepared(new Error('private development worker startup unavailable'))
    if (!granted && child.pid) child.kill()
  }
  instance.prepared = new Promise((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject })
  void instance.prepared.catch(() => {})
  instance.closed = new Promise(resolve => {
    child.once('error', () => { instance.result = { status: 1, signal: null, spawnError: true }; failed(); resolve(instance.result) })
    child.once('close', (status, signal) => {
      clearTimeout(timer)
      if (!instance.result?.spawnError) instance.result = { status, signal }
      if (phase !== 'closed') instance.protocolError = true
      if (phase !== 'closed') failed()
      resolve(instance.result)
    })
  })
  child.stdin.on('error', failed)
  child.on('message', value => {
    if (!value || JSON.stringify(value).length > worker.FRAME_BYTES || typeof value !== 'object') { failed(); return }
    if (phase === 'starting' && value.phase === 'waiting' && Object.keys(value).length === 2 && value.pid === child.pid) {
      try {
        instance.family = native.openFamily(child.pid)
        phase = 'attached'
        const bytes = Buffer.concat([Buffer.from([worker.START_BYTE]), bootstrap])
        child.stdin.write(bytes, error => { bytes.fill(0); bootstrap.fill(0); if (error) failed() })
        granted = true
      } catch { failed() }
    } else if (phase === 'attached' && value.phase === 'spawned' && Object.keys(value).length === 2 && Number.isSafeInteger(value.pid) && value.pid > 0) {
      phase = 'running'
      instance.electronPid = value.pid
      clearTimeout(timer)
      resolvePrepared()
    } else if (phase === 'running' && value.phase === 'closed' && Object.keys(value).length === 4 &&
      value.pid === instance.electronPid && (value.status === null || Number.isSafeInteger(value.status)) &&
      (value.signal === null || value.signal === 'SIGINT' || value.signal === 'SIGTERM' || value.signal === 'SIGKILL')) {
      phase = 'closed'
    } else failed()
  })
  return instance
}

async function cacheDirectory(directory) {
  const entry = await fs.lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(directory) !== directory)
    throw new Error('development native cache directory is redirected or invalid')
  return entry
}

async function verifyNativeCache(directory, expected) {
  await cacheDirectory(directory)
  const names = await fs.readdir(directory)
  if (names.length !== 1 || names[0] !== NATIVE_LIBRARY) throw new Error('development native cache inventory differs')
  const library = path.join(directory, NATIVE_LIBRARY)
  const before = await fs.lstat(library, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('development native cache library is not a regular file')
  const bytes = await fs.readFile(library)
  const after = await fs.lstat(library, { bigint: true })
  if (!bytes.equals(expected) || before.dev !== after.dev || before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs || before.size !== after.size)
    throw new Error('development native cache library changed or differs from the candidate')
  return { directory, library }
}

export async function nativeCache(bytes, desktopRoot) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('development native cache requires candidate bytes')
  bytes = Buffer.from(bytes)
  let parent = await fs.realpath(desktopRoot)
  for (const part of NATIVE_CACHE_PARTS) {
    parent = path.join(parent, part)
    if (part !== NATIVE_CACHE_PARTS[0]) {
      try { await fs.mkdir(parent, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    await cacheDirectory(parent)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  const directory = path.join(parent, digest)
  let exists = true
  try { await fs.lstat(directory) }
  catch (error) { if (error.code !== 'ENOENT') throw error; exists = false }
  if (exists) return verifyNativeCache(directory, bytes)
  const staging = await fs.mkdtemp(path.join(parent, '.native-'))
  const identity = await fs.lstat(staging, { bigint: true })
  let published = false
  try {
    await fs.writeFile(path.join(staging, NATIVE_LIBRARY), bytes, { flag: 'wx', mode: 0o600 })
    await verifyNativeCache(staging, bytes)
    await cacheDirectory(parent)
    try {
      await fs.rename(staging, directory)
      published = true
    } catch (error) {
      if (!CACHE_COLLISIONS.has(error.code)) throw error
    }
    return await verifyNativeCache(directory, bytes)
  } finally {
    if (!published) {
      await cacheDirectory(parent)
      const current = await fs.lstat(staging, { bigint: true })
      if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isDirectory() || current.isSymbolicLink())
        throw new Error('development native cache staging ownership changed; preserve it')
      await verifyNativeCache(staging, bytes)
      await fs.rm(staging, { recursive: true })
    }
  }
}

async function hostFamily(candidate) {
  if (process.platform !== 'win32') return null
  if (process.versions.node !== nativePolicy.node || Number(process.versions.napi) < nativePolicy.napi)
    throw new Error('development Windows Job requires the registered Node and N-API toolchain')
  const bytes = await candidateNative(candidate)
  const { directory, library } = await nativeCache(bytes, DESKTOP_ROOT)
  const native = require(library)
  if (typeof native.openFamily !== 'function') throw new Error('development native process-family capability missing')
  return { native, directory }
}

function launchElectron(root, settings, rendererUrl, environment, familyHost) {
  return async () => {
    const control = new DevelopmentSupervisor()
    const bootstrap = await control.listen()
    const env = { ...environment, ELECTRON_RENDERER_URL: rendererUrl }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    if (familyHost) return spawnWorker({ executable: electron, root, settings, environment: env,
      bootstrap, control, native: familyHost.native })
    let child
    try {
      child = spawn(electron, [root, `--remote-debugging-port=${settings.port}`,
        `--remote-debugging-address=${LOOPBACK}`, `--user-data-dir=${settings.profile}`, DEVELOPMENT_CONTROL_ARGUMENT], {
        cwd: root, env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
        detached: process.platform !== 'win32'
      })
      const instance = { child, control, result: null }
      instance.closed = new Promise(resolve => {
        child.once('error', () => { instance.result = { status: 1, signal: null, spawnError: true }; resolve(instance.result) })
        child.once('close', (status, signal) => {
          if (!instance.result?.spawnError) instance.result = { status, signal }
          resolve(instance.result)
        })
      })
      child.stdin.on('error', () => { bootstrap.fill(0) })
      try { child.stdin.write(bootstrap, () => { bootstrap.fill(0) }) }
      catch { bootstrap.fill(0) }
      return instance
    } catch (error) {
      bootstrap.fill(0)
      control.close()
      throw error
    }
  }
}

async function ready(instance, repo, interrupted) {
  if (instance.prepared) await instance.prepared
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (instance.result || instance.protocolError) throw new Error('development child exited or its private worker became unavailable before readiness')
    if (interrupted()) throw new Error('development startup interrupted')
    const observation = await debugging.inspectDebug(repo, undefined, Date.now() + POLL_MS)
    if (observation.rendererReady) return
    await delay(POLL_MS)
  }
  throw new Error('development readiness unconfirmed')
}

export async function main(argv = process.argv.slice(2), desktopRoot = DESKTOP_ROOT) {
  const settings = developmentArguments(argv)
  const root = await fs.realpath(desktopRoot)
  const repo = path.resolve(root, '../..')
  const isolation = debugging.debugPaths(repo)
  if (path.resolve(settings.profile) !== isolation.profile || process.env.SCHOLARSEED_HOME !== isolation.home ||
      await fs.realpath(isolation.profile) !== isolation.profile || await fs.realpath(isolation.home) !== isolation.home)
    throw new Error('development host requires this worktree\'s exact isolated profile and home')
  const state = { instance: null, pending: null, publication: null, dirty: false, disabled: false }
  let renderer
  let closeWatcher = () => {}
  let interrupted = null
  const report = message => console.error(`[development] ${message}`)
  const signal = name => { interrupted ??= name }
  const interrupt = () => signal('SIGINT')
  const terminate = () => signal('SIGTERM')
  const stopMessage = value => {
    if (value && typeof value === 'object' && Object.keys(value).length === 3 &&
      value.kind === leasing.DEVELOPMENT_STOP && value.version === leasing.DEVELOPMENT_PROTOCOL_VERSION && Object.hasOwn(SIGNAL_STATUS, value.signal)) signal(value.signal)
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  process.on('message', stopMessage)
  let initial
  let familyHost
  try {
    closeWatcher = debugging.watchRestartSources(repo, report, () => { state.dirty = true })
    const snapshot = source.developmentSourceSnapshot(repo)
    initial = await compileCandidate({ desktopRoot: root })
    familyHost = await hostFamily(initial)
    if (!source.sourceUnchanged(snapshot, source.developmentSourceSnapshot(repo))) throw new Error('source changed during initial compilation; retry development')
    if (interrupted) return SIGNAL_STATUS[interrupted]
    renderer = await createServer(initial.rendererConfig)
    await renderer.listen()
    const addresses = renderer.resolvedUrls?.local || []
    const rendererUrl = addresses.find(address => new URL(address).hostname === LOOPBACK)
    if (!rendererUrl) throw new Error('renderer did not expose its registered loopback address')
    const launch = launchElectron(root, settings, rendererUrl, process.env, familyHost)
    const operations = {
      canRestart: process.platform !== 'win32' || !!familyHost,
      snapshot: () => source.developmentSourceSnapshot(repo), unchanged: source.sourceUnchanged,
      compile: () => compileCandidate({ desktopRoot: root }),
      dispose: candidate => fs.rm(candidate.directory, { recursive: true, force: true }),
      stopped: waitStopped,
      publish: candidate => publishCandidate(candidate, root, { previousStopped: true }),
      launch, ready: instance => ready(instance, repo, () => !!interrupted),
      terminated: instance => !!instance.result,
      rejected: error => error instanceof BackendMaintenanceRejected,
      publicationRestored: error => error instanceof DevelopmentPublicationRejected && error.previousOutputsIntact === true,
      interrupted: () => !!interrupted,
      report
    }
    if (interrupted) return SIGNAL_STATUS[interrupted]
    if (!source.sourceUnchanged(snapshot, source.developmentSourceSnapshot(repo))) throw new Error('source changed while preparing the renderer; retry development')
    state.publication = await operations.publish(initial)
    if (interrupted) {
      await state.publication.rollback({ previousStopped: true })
      state.publication = null
      return SIGNAL_STATUS[interrupted]
    }
    try {
      state.instance = await launch()
      await operations.ready(state.instance)
      await state.publication.commit()
      state.publication = null
      await operations.dispose(initial)
      initial = null
    } catch {
      if (!state.instance || state.instance.result) {
        if (state.instance) await operations.stopped(state.instance)
        await state.publication.rollback({ previousStopped: true })
        state.publication = null
        report('Initial startup failed; previous outputs were restored without claiming readiness.')
        return 1
      }
      state.disabled = true
      report('Initial readiness unconfirmed; the instance and pending publication are retained until explicit exit.')
    }
    while (!interrupted) {
      if (state.instance.result) {
        let familyAlive = false
        try { familyAlive = !!state.instance.family && state.instance.family.active() !== 0 }
        catch { familyAlive = true }
        if (familyAlive) {
          state.disabled = true
          if (!state.instance.familyExitReported) {
            report('The Windows worker exited while its owned Job is still occupied or uncertain; processes are retained until explicit exit.')
            state.instance.familyExitReported = true
          }
          await delay(RELOAD_POLL_MS)
          continue
        }
        return state.disabled ? state.instance.result.status || 1 : state.instance.result.status ?? 1
      }
      try { await attemptReload(state, operations) }
      catch {
        state.disabled = true
        report('Reload coordination failed; current processes and pending outputs are retained until explicit exit.')
      }
      await delay(RELOAD_POLL_MS)
    }
    return SIGNAL_STATUS[interrupted]
  } finally {
    const receipt = path.join(isolation.root, `development-${process.pid}.json`)
    let handle
    let identity
    const record = async phase => {
      if (!handle) {
        handle = await fs.open(receipt, 'wx', 0o600)
        identity = await handle.stat()
      }
      const bytes = Buffer.from(JSON.stringify({
            repo, home: isolation.home, profile: settings.profile, port: settings.port,
            hostPid: process.pid, childPid: state.instance?.child.pid ?? null,
            electronPid: state.instance?.electronPid ?? null, hostNative: familyHost?.directory ?? null,
            group: process.platform === 'win32' ? null : state.instance?.child.pid ?? null,
            phase, result: state.instance?.result ?? null,
            pendingCandidate: state.pending?.candidate.directory ?? initial?.directory ?? null,
            pendingPublication: state.publication?.directory ?? null,
          }, null, 2) + '\n')
      await handle.truncate(0)
      await handle.write(bytes, 0, bytes.length, 0)
      await handle.sync()
    }
    let finalStatus
    try {
      finalStatus = await finishHost(state, {
        interrupted, closeWatcher,
        signal: instance => {
          if (instance.family) instance.family.terminate()
          else if (process.platform === 'win32') instance.child.kill(interrupted)
          else {
            try { process.kill(-instance.child.pid, interrupted) }
            catch (error) { if (error.code !== 'ESRCH') throw error }
          }
        },
        stopped: waitStopped,
        receipt: record,
        closeRenderer: () => renderer?.close(),
        dispose: async () => {
          if (initial) await fs.rm(initial.directory, { recursive: true, force: true })
          if (state.pending) await fs.rm(state.pending.candidate.directory, { recursive: true, force: true })
        },
        removeReceipt: async () => {
          const observed = await fs.lstat(receipt)
          if (observed.dev !== identity.dev || observed.ino !== identity.ino || !observed.isFile()) throw new Error('development ownership receipt changed')
          await handle.close()
          handle = null
          await fs.unlink(receipt)
        }
      })
    } catch { finalStatus = execution.PROCESS_TREE_UNCONFIRMED_EXIT }
    try { await handle?.close() } catch { finalStatus = execution.PROCESS_TREE_UNCONFIRMED_EXIT }
    if (finalStatus !== null) {
      report(`Task shutdown or publication remains unconfirmed; preserve the launcher lock and environment lease; ownership receipt: ${receipt}.`)
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    process.removeListener('message', stopMessage)
    if (finalStatus === null && process.send && process.connected) {
      try {
        await new Promise((resolve, reject) => process.send({ kind: leasing.DEVELOPMENT_STOPPED, version: leasing.DEVELOPMENT_PROTOCOL_VERSION }, error => error ? reject(error) : resolve()))
      } catch {
        finalStatus = execution.PROCESS_TREE_UNCONFIRMED_EXIT
        try { await record('retained'); await handle?.close() } catch {}
      }
    }
    if (process.send && process.connected) process.disconnect()
    if (finalStatus !== null) return finalStatus
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error(`[development] ${error.message}`)
    process.exitCode = 1
  })
}
