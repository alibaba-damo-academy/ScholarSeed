import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, constants, statSync } from 'node:fs'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import {
  boundedProfileRead,
  enableHistoryProfile,
  measureHistoryClick,
  oldSourceTimings,
  rendererHistoryPhases,
  sampleHistoryMemory,
} from './fixtures/profiling.mjs'

const STARTUP_TIMEOUT_MS = 30_000
const HEALTH_INTERVAL_MS = 500
const DEFAULT_ALERT_MS = 800
const DEFAULT_TIMEOUT_MS = 120_000
// Leave room under the macOS Unix socket path limit for the fixture home and Serve bridge.
const TEMP_PARENT_BYTE_LIMIT = 35
const MAX_SCROLL_ATTEMPTS = 100
const SCROLL_DELTA_Y_PX = -12_000
const SCROLL_SETTLE_MS = 100
const SCROLL_LOCATOR_TIMEOUT_MS = 5_000
const HEALTH_ROUTE = '/api/healthz/backend'
const RENDERER_PATH = '/'
const LOOPBACK = '127.0.0.1'
const SAMPLE_EXECUTABLE = '/usr/bin/sample'
const SAMPLE_DURATION_SECONDS = '3'
const SAMPLE_INTERVAL_MS = '10'
const PRODUCT_LOG_PREFIX = 'service.platform.latency:'
const LISTENER_EXECUTABLE = '/usr/sbin/lsof'
const NATIVE_PREFERENCES = 'renderer-preferences.json'
const PROFILE_SINGLETONS = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket'])
const FIXTURE_DIRECTORIES = ['home', 'profile', 'codex', 'workspace']

function contains(parent, path) {
  const rel = relative(parent, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function physicalDestination(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(await physicalDestination(dirname(path)), basename(path))
  }
}

async function fixtureAt(path) {
  const file = await realpath(path)
  const root = dirname(file)
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const allowed = [await realpath('/tmp'), resolve(repository, 'tmp')]
  if (!allowed.some((directory) => contains(directory, root))) {
    throw new Error(
      'Use a dedicated fixture directory under the operating system temp directory or checkout tmp'
    )
  }
  const data = JSON.parse(await readFile(file, 'utf8'))
  if (
    data.synthetic !== true ||
    !/^[\w-]+$/.test(data.sessionId) ||
    !Number.isSafeInteger(data.events) ||
    !Number.isSafeInteger(data.turns) ||
    data.events < data.turns ||
    data.turns < 1 ||
    !Number.isSafeInteger(data.port) ||
    !(data.port > 0 && data.port < 65536)
  )
    throw new Error('Invalid synthetic cold-recovery fixture')
  for (const key of FIXTURE_DIRECTORIES) {
    if (typeof data[key] !== 'string') throw new Error(`Missing fixture directory ${key}`)
    data[key] = await realpath(resolve(root, data[key]))
    if (!contains(root, data[key])) {
      throw new Error(`Fixture ${key} must be a dedicated subdirectory of the fixture root`)
    }
    await verifyFixtureTree(data[key], key === 'profile')
  }
  const roots = FIXTURE_DIRECTORIES.map((key) => data[key])
  if (
    roots.some((candidate, position) =>
      roots
        .slice(position + 1)
        .some(
          (other) => candidate === other || contains(candidate, other) || contains(other, candidate)
        )
    )
  )
    throw new Error('The fixture directories must be separate')
  return { ...data, file }
}

async function verifyFixtureTree(directory, profileRoot = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (profileRoot && PROFILE_SINGLETONS.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await verifyFixtureTree(path)
    else if (!entry.isFile()) throw new Error(`Unexpected fixture entry: ${path}`)
  }
}

function verifyGeneratedFixture(python, fixture) {
  if (!fixture.workspaceSha256) return
  const generator = fileURLToPath(new URL('./fixtures/history.py', import.meta.url))
  execFileSync(python, ['-I', '-B', generator, fixture.file, '--verify'], {
    encoding: 'utf8',
    timeout: STARTUP_TIMEOUT_MS,
  })
}

async function availablePort(port = 0) {
  const listener = net.createServer()
  await new Promise((resolve, reject) =>
    listener.once('error', reject).listen(port, LOOPBACK, resolve)
  )
  const bound = listener.address().port
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  )
  return bound
}

function processIdentity(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim()
  } catch {
    return ''
  }
}

function ownsListener(pid, port) {
  try {
    const listeners = execFileSync(
      LISTENER_EXECUTABLE,
      ['-nP', '-t', '-iTCP:' + port, '-sTCP:LISTEN'],
      {
        encoding: 'utf8',
        timeout: 1000,
      }
    )
      .trim()
      .split('\n')
    return listeners.length === 1 && Number(listeners[0]) === pid
  } catch {
    return false
  }
}

function launch(executable, arguments_, options, logPath, evidence, onLine = () => {}) {
  evidence.signal.throwIfAborted()
  const child = spawn(executable, arguments_, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error: error.message }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (evidence.signal.aborted) return
      try {
        appendFileSync(logPath, `${line}\n`)
        onLine(line)
      } catch (error) {
        evidence.abort(error)
      }
    })
  }
  return { child, exited, identity: child.pid ? processIdentity(child.pid) : '' }
}

async function stop(owned) {
  if (!owned) return null
  const { child, exited } = owned
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  const outcome = await Promise.race([exited, delay(10_000, null, { ref: false })])
  if (outcome) return outcome
  if (owned.identity && processIdentity(child.pid) === owned.identity) child.kill('SIGKILL')
  return Promise.race([exited, delay(3_000, { error: 'Process did not exit' }, { ref: false })])
}

async function waitFor(signal, probe, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    signal.throwIfAborted()
    const result = await probe()
    signal.throwIfAborted()
    if (result) return result
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function requestKind(rawUrl, sessionId) {
  const url = new URL(rawUrl)
  const base = `/api/serve/sessions/${sessionId}`
  if (url.pathname === `/api/serve/history/${sessionId}`) return 'history'
  if (url.pathname === `${base}/events`) return 'session-sse'
  if (url.pathname === '/api/serve/notifications/events') return 'notification-sse'
  if (
    url.pathname.startsWith(`/api/assistant/sessions/${sessionId}/turns/`) &&
    url.pathname.endsWith('/sources')
  )
    return 'sources'
  return null
}

function rendererPage(candidate) {
  if (!candidate.url().startsWith(`http://${LOOPBACK}:`)) return false
  return new URL(candidate.url()).pathname === RENDERER_PATH
}

function observeNetwork(cdp, fixture, emit, profileHistory) {
  const requests = new Map()
  let heartbeatAt = null
  cdp.on('Network.requestWillBeSent', (event) => {
    const kind = requestKind(event.request.url, fixture.sessionId)
    if (!kind) return
    const url = new URL(event.request.url)
    const item = {
      kind,
      path: url.pathname,
      query: url.search,
      startedAt: event.wallTime * 1000,
      startedTick: event.timestamp,
    }
    requests.set(event.requestId, item)
    emit('renderer_request', { requestId: event.requestId, ...item })
  })
  cdp.on('Network.responseReceived', (event) => {
    const request = requests.get(event.requestId)
    if (!request) return
    const at = request.startedAt + (event.timestamp - request.startedTick) * 1000
    const serverRequestId = Object.entries(event.response.headers).find(
      ([key]) => key.toLowerCase() === 'x-scholarseed-request-id'
    )?.[1]
    request.serverRequestId = serverRequestId
    emit('renderer_headers', {
      requestId: event.requestId,
      kind: request.kind,
      status: event.response.status,
      at,
      serverRequestId,
    })
  })
  if (profileHistory)
    cdp.on('Network.loadingFinished', (event) => {
      const request = requests.get(event.requestId)
      if (request?.kind === 'history')
        emit('renderer_history_downloaded', {
          serverRequestId: request.serverRequestId,
          at: request.startedAt + (event.timestamp - request.startedTick) * 1000,
          encodedBytes: event.encodedDataLength,
        })
    })
  cdp.on('Network.eventSourceMessageReceived', (event) => {
    const request = requests.get(event.requestId)
    if (request?.kind !== 'session-sse' || event.eventName !== 'heartbeat') return
    const at = request.startedAt + (event.timestamp - request.startedTick) * 1000
    heartbeatAt ??= at
    emit('renderer_heartbeat', { requestId: event.requestId, at })
  })
  cdp.on('Network.loadingFailed', (event) => {
    const request = requests.get(event.requestId)
    if (!request) return
    emit('renderer_request_failed', {
      requestId: event.requestId,
      kind: request.kind,
      error: event.errorText,
      canceled: event.canceled,
    })
  })
  return () => heartbeatAt
}

function rendererDiagnostic(line, sessionId, emit) {
  for (const [token, name] of [
    ['[session-recovery]', 'recovery'],
    ['[session-stream]', 'sse_attempt'],
    ['[http-latency]', 'renderer_api_timing'],
  ]) {
    const marker = line.indexOf(token)
    if (marker < 0) continue
    const payload = line.slice(marker + token.length).trim()
    try {
      const data = JSON.parse(payload)
      if (
        data.sessionId === sessionId ||
        data.route === `/api/serve/history/${sessionId}` ||
        data.route === '/api/serve/history/{session_id}'
      ) {
        emit(name, { ...data, diagnosticEvent: data.event })
      }
    } catch {
      // Chromium may also echo this record as a quoted console line.
    }
    return
  }
}

async function copyFixture(fixture) {
  const temp = await realpath(tmpdir())
  const parent = Buffer.byteLength(temp) < TEMP_PARENT_BYTE_LIMIT ? temp : await realpath('/tmp')
  const root = await mkdtemp(join(parent, 'ss-cold-'))
  const paths = {
    root,
    home: join(root, 'home'),
    profile: join(root, 'profile'),
    codex: join(root, 'codex'),
  }
  for (const key of ['home', 'profile', 'codex']) {
    await cp(fixture[key], paths[key], {
      recursive: true,
      filter: (path) =>
        key !== 'profile' ||
        dirname(path) !== fixture.profile ||
        !PROFILE_SINGLETONS.has(basename(path)),
    })
  }
  for (const folder of ['trace', 'ledger']) await mkdir(join(root, folder), { mode: 0o700 })
  return paths
}

async function run(options, fixture, artifact) {
  verifyGeneratedFixture(options.python, fixture)
  await mkdir(artifact, { recursive: false, mode: 0o700 })
  const paths = await copyFixture(fixture)
  const origin = `http://${LOOPBACK}:${fixture.port}`
  const records = []
  const active = new Map()
  const sampling = []
  const evidence = new AbortController()
  const emit = (event, data = {}) => {
    const row = { ...data, observedAt: Date.now(), event }
    records.push(row)
    try {
      appendFileSync(join(artifact, 'timeline.jsonl'), `${JSON.stringify(row)}\n`)
    } catch (error) {
      evidence.abort(error)
    }
  }
  const product = JSON.parse(
    await readFile(join(options.desktop, 'resources', 'product.json'), 'utf8')
  )
  const env = {
    ...process.env,
    SCHOLARSEED_HOME: paths.home,
    SCHOLARSEED_CODEX_HOME: paths.codex,
    SCHOLARSEED_DEFAULT_WORKSPACE: fixture.workspace,
    SCHOLARSEED_CODEX_EXECUTABLE: options.codex,
    DAMOATRACE_HOME: join(paths.root, 'trace'),
    DAMOATRACE_LEDGER_ROOT: join(paths.root, 'ledger'),
    SCHOLARSEED_REPO: options.source,
    SCHOLARSEED_LOG_LEVEL: 'debug',
    SCHOLARSEED_ACCOUNT_BASE_URL: product.account_base_url ?? '',
    PYTHONPATH: ['apps/serve', 'packages/runtime', 'packages/adapters/codex', 'packages/damoatrace']
      .map((item) => join(options.source, item))
      .join(delimiter),
  }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'NODE_OPTIONS',
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'PYTHONHOME',
  ])
    delete env[key]
  const renderer = join(options.desktop, 'out', 'renderer')
  const index = await readFile(join(renderer, 'index.html'))
  const entry = index.toString().match(/(?:src|href)="\.?(\/assets\/index-[^"/]+\.js)"/)?.[1]
  if (!entry) throw new Error('Compiled renderer entry is missing')
  const rendererSha256 = createHash('sha256')
    .update(await readFile(join(renderer, entry)))
    .digest('hex')
  emit('variant', {
    revision: options.revision,
    rendererSha256,
    rendererEntry: entry,
    fixture: { id: fixture.sessionId, events: fixture.events, turns: fixture.turns },
  })
  await availablePort(fixture.port)
  const cdpPort = await availablePort()
  if (cdpPort === fixture.port)
    throw new Error('The chosen CDP port conflicts with the fixture origin')
  let serve,
    desktop,
    browser,
    healthTask,
    healthStopped = false
  let requestedSample = false
  let desktopStartedAt = null
  let visibleAt = null
  let heartbeatAt = null
  let observationEndedAt = null
  let prepared = false
  let stopMemory
  let memory
  let firstInteraction
  let projectionPhases
  let productPage
  let rendererSourcesBeforeHeartbeat = null
  let rendererObservationComplete = false
  let exitFailed = false
  let runFailure
  const stopChildren = () => {
    desktop?.child.kill('SIGTERM')
    serve?.child.kill('SIGTERM')
  }
  const stopOnInterrupt = () => {
    emit('interrupted')
    stopChildren()
  }
  evidence.signal.addEventListener('abort', stopChildren, { once: true })
  process.once('SIGTERM', stopOnInterrupt)
  process.once('SIGINT', stopOnInterrupt)
  const triggerSample = (reason, detail) => {
    if (requestedSample || process.platform !== 'darwin' || !serve?.identity) return
    if (
      processIdentity(serve.child.pid) !== serve.identity ||
      !ownsListener(serve.child.pid, fixture.port) ||
      serve.child.exitCode !== null
    )
      return
    requestedSample = true
    const sampleFile = join(artifact, `serve-${serve.child.pid}.sample.txt`)
    emit('sample_started', {
      pid: serve.child.pid,
      reason,
      detail,
      active: [...active.values()],
      recentRequests: records
        .filter((row) => row.event === 'serve_request')
        .slice(-12)
        .map(({ phase, record }) => ({
          phase,
          requestId: record.request_id,
          route: record.route,
          startedAt: record.started_at,
          headersMs: record.headers_ms,
          handlerPhasesMs: record.handler_phases_ms,
        })),
      sampleFile,
    })
    const sampler = launch(
      SAMPLE_EXECUTABLE,
      [
        String(serve.child.pid),
        SAMPLE_DURATION_SECONDS,
        SAMPLE_INTERVAL_MS,
        '-mayDie',
        '-file',
        sampleFile,
      ],
      {},
      join(artifact, 'sample.log'),
      evidence
    )
    sampling.push(
      sampler.exited
        .then((outcome) => {
          const bytes = statSync(sampleFile, { throwIfNoEntry: false })?.size ?? 0
          emit('sample_finished', { pid: serve.child.pid, ...outcome, bytes })
          if (outcome.error) throw new Error(`Could not start Serve sample: ${outcome.error}`)
        })
        .catch((error) => evidence.abort(error))
    )
  }
  try {
    serve = launch(
      options.python,
      [
        '-B',
        '-m',
        'service.cli.serve',
        '--host',
        LOOPBACK,
        '--port',
        String(fixture.port),
        '--log-level',
        'debug',
        '--no-auth',
        '--ownership-axis',
        'machine',
        '--renderer-dist',
        renderer,
      ],
      { cwd: fixture.workspace, env },
      join(artifact, 'serve.log'),
      evidence,
      (line) => {
        const replay = line.match(/sse\.replay_(started|finished)\s+session_id=([\w-]+)\s+(.*)/)
        if (replay?.[2] === fixture.sessionId) {
          emit('sse_replay', {
            phase: replay[1],
            details: Object.fromEntries(
              [...replay[3].matchAll(/(\w+)=(\S+)/g)].map((field) => field.slice(1))
            ),
          })
        }
        const marker = line.indexOf(PRODUCT_LOG_PREFIX)
        if (marker < 0) return
        let row
        try {
          row = JSON.parse(line.slice(marker + PRODUCT_LOG_PREFIX.length))
        } catch {
          return
        }
        if (row.event === 'loop_stall')
          triggerSample('loop_stall', {
            loopStallId: row.loop_stall_id,
            processLoopLagMs: row.process_loop_lag_ms,
          })
        if (
          row.event === 'loop_stall' ||
          row.event === 'loop_recovered' ||
          row.event === 'loop_lag'
        )
          emit('serve_loop', { phase: row.event, record: row })
        const ingress = active.get(row.request_id)
        if (row.event === 'received')
          active.set(row.request_id, {
            requestId: row.request_id,
            method: row.method,
            startedAt: row.started_at,
            ingressObservedAt: Date.now(),
          })
        if (row.event === 'headers')
          active.set(row.request_id, {
            requestId: row.request_id,
            method: row.method,
            route: row.route,
            startedAt: row.started_at,
            headersMs: row.headers_ms,
            handlerPhasesMs: row.handler_phases_ms,
          })
        if (row.event === 'finished') active.delete(row.request_id)
        if (
          row.route?.includes('/history/') ||
          row.route?.endsWith('/sources') ||
          row.route?.endsWith('/events') ||
          row.route === '/api/serve/sessions/open'
        ) {
          if (row.event === 'headers' && ingress)
            emit('serve_ingress_matched', { ...ingress, route: row.route })
          emit('serve_request', { phase: row.event, record: row })
        }
      }
    )
    const health = await waitFor(
      evidence.signal,
      async () => {
        if (serve.child.exitCode !== null || serve.child.signalCode !== null)
          throw new Error('Owned Serve exited before it was ready')
        try {
          const response = await fetch(`${origin}${HEALTH_ROUTE}`, {
            signal: AbortSignal.timeout(1000),
          })
          const body = await response.json()
          return response.ok &&
            body.ok &&
            body.workbench_ready &&
            body.cwd === fixture.workspace &&
            typeof body.service_instance_id === 'string' &&
            ownsListener(serve.child.pid, fixture.port)
            ? body
            : null
        } catch {
          return null
        }
      },
      STARTUP_TIMEOUT_MS,
      'isolated Serve'
    )
    emit('serve_ready', { pid: serve.child.pid, serviceInstanceId: health.service_instance_id })
    healthTask = (async () => {
      while (!healthStopped) {
        const started = performance.now()
        try {
          const response = await fetch(`${origin}${HEALTH_ROUTE}`, {
            signal: AbortSignal.timeout(options.alertMs),
          })
          await response.arrayBuffer()
          emit('health', { elapsedMs: performance.now() - started, status: response.status })
        } catch (error) {
          const elapsedMs = performance.now() - started
          if (healthStopped) return
          emit('health_error', { elapsedMs, error: error.name })
          if (elapsedMs >= options.alertMs) triggerSample('health_deadline', { elapsedMs })
        }
        await delay(HEALTH_INTERVAL_MS)
      }
    })().catch((error) => evidence.abort(error))
    desktopStartedAt = Date.now()
    desktop = launch(
      options.electron,
      [
        options.desktop,
        `--user-data-dir=${paths.profile}`,
        `--remote-debugging-port=${cdpPort}`,
        `--remote-debugging-address=${LOOPBACK}`,
      ],
      { cwd: options.desktop, env: { ...env, SCHOLARSEED_SERVE_URL: origin } },
      join(artifact, 'desktop.log'),
      evidence,
      (line) => rendererDiagnostic(line, fixture.sessionId, emit)
    )
    emit('desktop_started', { pid: desktop.child.pid, at: desktopStartedAt })
    if (options.profileHistory) stopMemory = sampleHistoryMemory(serve.child, desktop.child, emit)
    browser = await waitFor(
      evidence.signal,
      async () => {
        if (!ownsListener(desktop.child.pid, cdpPort)) return null
        try {
          return await chromium.connectOverCDP(`http://${LOOPBACK}:${cdpPort}`, { timeout: 1000 })
        } catch {
          return null
        }
      },
      STARTUP_TIMEOUT_MS,
      'owned Electron CDP'
    )
    const page = await waitFor(
      evidence.signal,
      () =>
        browser
          .contexts()
          .flatMap((context) => context.pages())
          .find(rendererPage),
      STARTUP_TIMEOUT_MS,
      'normal product page'
    )
    const cdp = await page.context().newCDPSession(page)
    productPage = page
    if (options.profileHistory) await boundedProfileRead(enableHistoryProfile(page))
    const firstHeartbeat = observeNetwork(cdp, fixture, emit, options.profileHistory)
    await cdp.send('Network.enable')
    emit('renderer_observer_attached', { origin: new URL(page.url()).origin })
    const deadline = desktopStartedAt + options.timeoutMs
    const remaining = () => Math.max(1, deadline - Date.now())
    const landing = page.getByTestId('landing-skip')
    const homeTask = page.getByTestId(`home-task-${fixture.sessionId}`)
    const skipGuide = page
      .locator('[data-ob="guide-home"]')
      .getByRole('button', { name: /^(Skip the guide|跳过引导)$/i })
    const dismissLanding = landing
      .waitFor({ state: 'visible', timeout: Math.min(5000, remaining()) })
      .then(
        async () => {
          await landing.click({ timeout: remaining() })
          emit('onboarding_skipped')
        },
        () => {}
      )
    if (options.prepare) {
      await dismissLanding
      const hasGuide = await skipGuide
        .waitFor({ state: 'visible', timeout: Math.min(5000, remaining()) })
        .then(
          () => true,
          () => false
        )
      if (hasGuide) await skipGuide.click({ timeout: remaining() })
      await homeTask.click({ timeout: remaining() })
      await waitFor(
        evidence.signal,
        async () => {
          try {
            const preferences = JSON.parse(
              await readFile(join(paths.profile, NATIVE_PREFERENCES), 'utf8')
            )
            return preferences.lastLocation?.sessionId === fixture.sessionId
          } catch {
            return false
          }
        },
        remaining(),
        'saved selection in the synthetic Desktop profile'
      )
      prepared = true
    }
    const historyVisible = page
      .waitForFunction(
        (tail) => {
          const turn = tail ? `[data-message-turn-id="${tail}"]` : '[data-message-turn-id]'
          const selector = `.conversation-stream ${turn}[data-message-kind="agent"] > div`
          const visible = [...document.querySelectorAll(selector)].some((element) => {
            const { left, right, top, bottom } = element.getBoundingClientRect()
            const x = (Math.max(0, left) + Math.min(innerWidth, right)) / 2
            const y = (Math.max(0, top) + Math.min(innerHeight, bottom)) / 2
            return element.contains(document.elementFromPoint(x, y)) && !!element.textContent.trim()
          })
          return visible ? Date.now() : false
        },
        fixture.lastTurnId ?? null,
        { timeout: remaining() }
      )
      .then((handle) => handle.jsonValue())
    const captureFirstScreen = historyVisible.then(async (at) => {
      visibleAt = at
      emit('history_visible', { elapsedMs: visibleAt - desktopStartedAt })
      if (options.profileHistory) {
        firstInteraction = await measureHistoryClick(
          page,
          fixture.lastTurnId,
          'firstClick',
          remaining()
        )
        emit('first_history_interaction', firstInteraction)
      }
      await page.screenshot({
        path: join(
          artifact,
          options.profileHistory ? 'history-after-first-click.png' : 'history-visible.png'
        ),
        timeout: 10_000,
      })
    })
    await Promise.all([captureFirstScreen, dismissLanding])
    if (!options.prepare) {
      try {
        await waitFor(evidence.signal, firstHeartbeat, remaining(), 'first session SSE heartbeat')
      } catch (error) {
        emit('heartbeat_unobserved', { reason: error.message })
      }
    }
    heartbeatAt = firstHeartbeat()
    observationEndedAt = Date.now()
    await page.screenshot({
      path: join(artifact, heartbeatAt === null ? 'observation-end.png' : 'connected.png'),
      timeout: 10_000,
    })
    if (options.oldTurn && !options.prepare) {
      const stream = page.locator('.conversation-stream')
      emit('older_turn_scroll_started', { turnId: options.oldTurn })
      await stream.hover({ timeout: Math.min(SCROLL_LOCATOR_TIMEOUT_MS, remaining()) })
      const oldTurn = stream.locator(`[data-message-turn-id="${options.oldTurn}"]`).first()
      // Scroll using native wheel input to exercise the production viewport observer.
      for (let count = 0; count < MAX_SCROLL_ATTEMPTS; count++) {
        const viewport = await stream.boundingBox()
        const row = await oldTurn.boundingBox()
        if (
          viewport &&
          row &&
          row.y >= viewport.y &&
          row.y + row.height <= viewport.y + viewport.height
        )
          break
        await page.mouse.wheel(0, SCROLL_DELTA_Y_PX)
        await delay(SCROLL_SETTLE_MS)
      }
      await oldTurn.waitFor({ state: 'visible', timeout: SCROLL_LOCATOR_TIMEOUT_MS })
      const viewport = await stream.boundingBox()
      const row = await oldTurn.boundingBox()
      if (
        !viewport ||
        !row ||
        row.y + row.height <= viewport.y ||
        row.y >= viewport.y + viewport.height
      ) {
        throw new Error(`Older turn ${options.oldTurn} did not enter the viewport`)
      }
      const oldVisibleAt = Date.now()
      emit('older_turn_visible', { turnId: options.oldTurn })
      await page.screenshot({ path: join(artifact, 'older-turn.png'), timeout: 10_000 })
      if (options.checkOldSources) {
        if (options.profileHistory) {
          const interaction = await measureHistoryClick(
            page,
            options.oldTurn,
            'olderClick',
            remaining()
          )
          emit('older_turn_sources_opened', {
            turnId: options.oldTurn,
            ...interaction,
            elapsedSinceVisibleMs: interaction.visibleAt - oldVisibleAt,
          })
        } else {
          const answer = stream
            .locator(`[data-message-turn-id="${options.oldTurn}"][data-message-kind="agent"]`)
            .last()
          const trigger = answer.locator('[data-answer-source-list]').getByRole('button').first()
          await trigger.click({ timeout: remaining() })
          const panel = page.locator('[data-citation-source-panel]').last()
          await panel
            .locator('[data-citation-source-entry]')
            .first()
            .waitFor({ state: 'visible', timeout: remaining() })
          emit('older_turn_sources_opened', {
            turnId: options.oldTurn,
            elapsedSinceVisibleMs: Date.now() - oldVisibleAt,
          })
        }
        await page.screenshot({ path: join(artifact, 'older-sources.png'), timeout: 10_000 })
      }
    }
  } catch (error) {
    runFailure = evidence.signal.reason ?? error
    emit('run_failed', { message: runFailure.message })
  } finally {
    healthStopped = true
    if (stopMemory)
      memory = await stopMemory(firstInteraction?.visibleAt).catch((error) => evidence.abort(error))
    if (options.profileHistory && productPage && !productPage.isClosed())
      projectionPhases = await boundedProfileRead(rendererHistoryPhases(productPage)).catch(
        () => []
      )
    await healthTask
    await Promise.allSettled(sampling)
    if (browser) await boundedProfileRead(browser.close()).catch(() => {})
    const desktopExit = await stop(desktop)
    const serveExit = await stop(serve)
    emit('desktop_exit', desktopExit ?? {})
    emit('serve_exit', serveExit ?? {})
    exitFailed = Boolean(desktopExit?.error || serveExit?.error)
    process.removeListener('SIGINT', stopOnInterrupt)
    process.removeListener('SIGTERM', stopOnInterrupt)
    evidence.signal.removeEventListener('abort', stopChildren)
    if (!runFailure && evidence.signal.aborted) {
      runFailure = evidence.signal.reason
      emit('run_failed', { message: runFailure.message })
    }
    const counts = Object.fromEntries(
      ['history', 'sources', 'session-sse'].map((kind) => [
        kind,
        records.filter((row) => row.event === 'renderer_request' && row.kind === kind).length,
      ])
    )
    const sources = records.filter(
      (row) =>
        row.event === 'serve_request' &&
        row.phase === 'headers' &&
        row.record.route?.endsWith('/sources')
    )
    const fromStart = (at) =>
      at === null || desktopStartedAt === null ? null : Math.round(at - desktopStartedAt)
    const open = records.find((row) => row.event === 'sse_attempt' && row.stage === 'live')
    const countSourcesStartedBy = (cutoffMs) => {
      if (cutoffMs === null) return null
      return sources.filter(
        ({ record }) => Number.isFinite(record.started_at) && record.started_at * 1000 <= cutoffMs
      ).length
    }
    const observerArmed = records.find((row) => row.event === 'renderer_observer_attached')
    rendererObservationComplete = Boolean(
      observerArmed &&
      counts.history > 0 &&
      !records.some(
        (row) =>
          row.event === 'renderer_api_timing' &&
          row.diagnosticEvent === 'fetch_started' &&
          row.timestamp_ms < observerArmed.observedAt
      )
    )
    rendererSourcesBeforeHeartbeat =
      heartbeatAt === null || !rendererObservationComplete
        ? null
        : records.filter(
            (row) =>
              row.event === 'renderer_request' &&
              row.kind === 'sources' &&
              row.startedAt <= heartbeatAt
          ).length
    let outcome
    if (options.prepare)
      outcome = prepared && visibleAt !== null ? 'profile_prepared' : 'prepare_failed'
    else if (heartbeatAt !== null) outcome = 'heartbeat_observed'
    else outcome = visibleAt !== null ? 'history_observed' : 'history_unobserved'
    const report = {
      revision: options.revision,
      rendererSha256,
      outcome,
      desktopStartedAt,
      historyVisibleMs: fromStart(visibleAt),
      ...(options.profileHistory
        ? {
            historyProfile: {
              memory,
              clientReads: records
                .filter(
                  (row) =>
                    row.event === 'renderer_api_timing' && row.diagnosticEvent === 'body_decoded'
                )
                .map((row) => {
                  const transfer = records.find(
                    (event) =>
                      event.event === 'renderer_history_downloaded' &&
                      event.serverRequestId === row.server_request_id
                  )
                  return {
                    caller: row.caller,
                    responseReadAndDecodeMs: row.body_elapsed_ms,
                    requestId: row.server_request_id,
                    encodedBytes: transfer?.encodedBytes ?? null,
                    decodedAt: row.timestamp_ms,
                    downloadedAt: transfer?.at ?? null,
                  }
                }),
              projectionPhases,
              olderSource: oldSourceTimings(records, options.oldTurn),
              failure: records.find((row) => row.event === 'run_failed')?.message ?? null,
              firstClickAfterStartMs: fromStart(firstInteraction?.inputAt ?? null),
              firstClickResponseAfterStartMs: fromStart(firstInteraction?.visibleAt ?? null),
              firstClickResponseMs: firstInteraction
                ? firstInteraction.visibleAt - firstInteraction.inputAt
                : null,
            },
          }
        : {}),
      onOpenMs: fromStart(open?.observedAt ?? null),
      firstHeartbeatMs: fromStart(heartbeatAt),
      rendererObservationComplete,
      rendererSourcesBeforeHeartbeat,
      serveSourcesWithHeadersBeforeHeartbeat: countSourcesStartedBy(heartbeatAt),
      serveSourcesWithHeadersAtObservationEnd: countSourcesStartedBy(observationEndedAt),
      counts,
      backendSources: sources.length,
      healthMaxMs: Math.max(
        0,
        ...records
          .filter((row) => row.event === 'health' || row.event === 'health_error')
          .map((row) => row.elapsedMs)
      ),
      sseAttempts: records
        .filter((row) => row.event === 'sse_attempt')
        .map(({ stage, sequence, attempt, observedAt }) => ({
          stage,
          sequence,
          attempt,
          elapsedMs: fromStart(observedAt),
        })),
      runtime: paths.root,
      ownedProcessesExited: !exitFailed,
      samples: sampling.length,
      successfulSamples: records.filter(
        (row) => row.event === 'sample_finished' && row.code === 0 && row.bytes > 0
      ).length,
    }
    await writeFile(join(artifact, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    }).catch((error) => evidence.abort(error))
  }
  if (runFailure) throw runFailure
  evidence.signal.throwIfAborted()
  if (exitFailed) throw new Error('Owned Desktop or Serve process did not exit')
  if (
    options.profileHistory &&
    (!firstInteraction ||
      (options.checkOldSources &&
        !Number.isFinite(oldSourceTimings(records, options.oldTurn)?.serveHeadersMs)) ||
      !memory?.rendererPeakKiB ||
      !memory.processPeaks.some((row) => row.role === 'serve') ||
      !projectionPhases?.some(
        (row) => row.caller === 'transcript' && row.phase === 'projectionToCommit'
      ) ||
      !projectionPhases?.some((row) => row.caller === 'resume' && row.phase === 'projection') ||
      !['transcript', 'resume'].every((caller) =>
        records.some(
          (row) =>
            row.event === 'renderer_api_timing' &&
            row.caller === caller &&
            row.diagnosticEvent === 'body_decoded'
        )
      ))
  )
    throw new Error('Incomplete renderer history profile; inspect the timeline and summary')
  verifyGeneratedFixture(options.python, fixture)
  if (
    options.maxSources !== undefined &&
    (rendererSourcesBeforeHeartbeat === null || rendererSourcesBeforeHeartbeat > options.maxSources)
  )
    throw new Error(
      `Expected complete renderer observation and at most ${options.maxSources} source requests before the first heartbeat`
    )
  if (prepared) {
    await cp(paths.profile, fixture.profile, {
      recursive: true,
      filter: (path) => dirname(path) !== paths.profile || !PROFILE_SINGLETONS.has(basename(path)),
    })
  }
}

const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      [
        'source',
        'desktop',
        'electron',
        'python',
        'codex',
        'fixture',
        'output',
        'revision',
        'rounds',
        'alert-ms',
        'timeout-ms',
        'old-turn',
        'max-sources-before-heartbeat',
      ].map((name) => [name, { type: 'string' }])
    ),
    prepare: { type: 'boolean' },
    'check-old-sources': { type: 'boolean' },
    'profile-history': { type: 'boolean' },
    help: { type: 'boolean' },
  },
})
if (values.help) {
  console.log(`Usage: node apps/desktop/e2e/history.mjs \\
  --source CHECKOUT --desktop BUILT_DESKTOP --electron EXECUTABLE --python EXECUTABLE \\
  --codex EXECUTABLE --fixture MANIFEST --output ARTIFACT_DIR --revision REVISION

  --prepare                       Select the synthetic session in a fresh Desktop profile
  --rounds N                      Independent cold starts (default 2)
  --timeout-ms N                  Per-round observation window (default 120000)
  --alert-ms N                    Health deadline for macOS thread sampling (default 800)
  --old-turn ID                   Scroll to this turn after the cold measurement
  --check-old-sources             Open and capture the old turn's source list
  --profile-history               Measure projection, React commit, first source click and sampled RSS
  --max-sources-before-heartbeat N
                                   Fail if that many source requests are exceeded or the heartbeat is missing`)
  process.exit(0)
}
if (process.platform !== 'darwin')
  throw new Error('This Electron cold-recovery runner requires macOS')
for (const key of [
  'source',
  'desktop',
  'electron',
  'python',
  'codex',
  'fixture',
  'output',
  'revision',
]) {
  if (!values[key])
    throw new Error(
      `Pass --${key}; use an actual built Desktop and a named synthetic fixture manifest`
    )
}
for (const key of ['source', 'desktop', 'electron', 'python', 'codex', 'fixture', 'output'])
  values[key] = resolve(values[key])
values.output = await physicalDestination(values.output)
await Promise.all([
  access(join(values.source, 'apps/serve/service/cli/serve.py'), constants.R_OK),
  ...['electron', 'python', 'codex'].map((key) => access(values[key], constants.X_OK)),
])
const { rounds, alertMs, timeoutMs } = {
  rounds: Number(values.rounds ?? 2),
  alertMs: Number(values['alert-ms'] ?? DEFAULT_ALERT_MS),
  timeoutMs: Number(values['timeout-ms'] ?? DEFAULT_TIMEOUT_MS),
}
if (
  !Number.isSafeInteger(rounds) ||
  rounds < 1 ||
  !Number.isSafeInteger(alertMs) ||
  !Number.isSafeInteger(timeoutMs) ||
  !(alertMs > 0 && timeoutMs > 0)
)
  throw new Error('Invalid run limits')
const fixture = await fixtureAt(values.fixture)
if (
  values['profile-history'] &&
  (values.prepare || !fixture.lastTurnId || !fixture.workspaceSha256)
)
  throw new Error(
    'History profiling requires a prepared generated fixture with a cited tail answer'
  )
if (
  fixture.lastTurnId !== undefined &&
  (typeof fixture.lastTurnId !== 'string' || !/^[\w-]+$/.test(fixture.lastTurnId))
)
  throw new Error('Invalid tail turn id')
if (
  FIXTURE_DIRECTORIES.some(
    (key) => values.output === fixture[key] || contains(fixture[key], values.output)
  )
)
  throw new Error('Use an evidence directory separate from the fixture state')
if (values.prepare && (await readdir(fixture.profile)).length > 0)
  throw new Error('Fixture preparation requires an empty dedicated Desktop profile')
if (!values.prepare) {
  try {
    const preferences = JSON.parse(
      await readFile(join(fixture.profile, NATIVE_PREFERENCES), 'utf8')
    )
    if (preferences.lastLocation?.sessionId !== fixture.sessionId)
      throw new Error('fixture selection mismatch')
  } catch {
    throw new Error(
      'Run --prepare to select the synthetic session in a dedicated Desktop profile before measuring'
    )
  }
}
const oldTurn = values['old-turn'] ?? fixture.oldTurnId
if (oldTurn !== undefined && (typeof oldTurn !== 'string' || !/^[\w-]+$/.test(oldTurn)))
  throw new Error('Invalid older turn id')
if (values['check-old-sources'] && !oldTurn)
  throw new Error('Older-source verification requires an older turn id')
const maxSources =
  values['max-sources-before-heartbeat'] === undefined
    ? undefined
    : Number(values['max-sources-before-heartbeat'])
if (maxSources !== undefined && (!Number.isSafeInteger(maxSources) || maxSources < 0))
  throw new Error('Invalid source request limit')
await mkdir(values.output, { recursive: true, mode: 0o700 })
for (let round = 1; round <= (values.prepare ? 1 : rounds); round++) {
  const label = values.prepare ? 'prepare' : `round-${round}`
  await run(
    {
      ...values,
      alertMs,
      timeoutMs,
      oldTurn,
      maxSources,
      checkOldSources: values['check-old-sources'],
      profileHistory: values['profile-history'],
    },
    fixture,
    join(values.output, label)
  )
  console.log(`Captured ${basename(values.output)}/${label}/summary.json`)
}
