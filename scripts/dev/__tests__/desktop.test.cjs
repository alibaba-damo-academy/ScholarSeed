const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')
const child = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream')
const { openOutput, removeOutput } = require('../output.cjs')
const { randomUUID } = require('node:crypto')
const test = require('node:test')
const toolchain = require('../../pre/toolchain.cjs')
const leases = require('../../shared/lease.cjs')
const { debugPaths, debugEnvironment, acquire, freePort, debugArguments, supervise, inspectDebug, waitForRenderer,
  monitorLauncher, recoverLauncher, requestLauncherStop } = require('../desktop.cjs')

test('automatic reload reports its triggering paths before notifying the supervisor', async context => {
  const watchers = []
  const events = []
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-source-'))
  const main = path.join(directory, 'apps/desktop/src/main')
  fs.mkdirSync(main, { recursive: true })
  fs.writeFileSync(path.join(main, 'index.ts'), 'before')
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  context.mock.method(fs, 'watch', (filename, options, listener) => {
    const watcher = new EventEmitter()
    watcher.close = () => {}
    watchers.push({ filename, listener })
    return watcher
  })
  const { watchRestartSources } = require('../desktop.cjs')
  let resolveChange
  const changed = new Promise(resolve => { resolveChange = resolve })
  const close = watchRestartSources(directory, message => events.push(message), paths => {
    events.push(paths)
    resolveChange()
  })
  context.after(close)
  assert.equal(watchers.some(watcher => watcher.filename.includes('src/renderer')), false)
  fs.writeFileSync(path.join(main, 'index.ts'), 'after')
  watchers.find(watcher => watcher.filename.endsWith('src/main')).listener('change', 'index.ts')
  await Promise.race([changed, new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watch notification timed out')), 2000)
    context.after(() => clearTimeout(timer))
  })])
  assert.equal(events.length, 2)
  assert.match(events[0], /automatic reload requested/)
  assert.match(events[0], /apps\/desktop\/src\/main\/index\.ts/)
  assert.deepEqual(events[1], ['apps/desktop/src/main/index.ts'])
})

test('restart monitoring verifies content and handles nameless events, directories and atomic saves', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-content-'))
  const desktop = path.join(directory, 'apps/desktop')
  const main = path.join(desktop, 'src/main')
  const config = path.join(desktop, 'electron.vite.config.ts')
  fs.mkdirSync(main, { recursive: true })
  fs.writeFileSync(path.join(main, 'index.ts'), 'before')
  fs.writeFileSync(config, 'before')
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const watchers = []
  const changes = []
  context.mock.method(fs, 'watch', (filename, options, listener) => {
    const watcher = new EventEmitter()
    watcher.close = () => {}
    watchers.push({ filename, listener })
    return watcher
  })
  const { watchRestartSources } = require('../desktop.cjs')
  const close = watchRestartSources(directory, () => {}, paths => changes.push(paths))
  context.after(close)
  const emitMain = name => watchers.find(watcher => watcher.filename === main).listener('change', name)
  const emitConfig = () => {
    const watcher = watchers.find(watcher => watcher.filename === config || watcher.filename === desktop)
    watcher.listener('change', path.basename(config))
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 350))
  emitMain('index.ts')
  emitConfig()
  await flush()
  assert.deepEqual(changes, [])
  const index = path.join(main, 'index.ts')
  const before = fs.statSync(index)
  fs.utimesSync(index, new Date(), new Date())
  emitMain('index.ts')
  await flush()
  assert.deepEqual(changes, [])
  fs.writeFileSync(index, 'after!')
  fs.utimesSync(index, before.atime, before.mtime)
  emitMain(null)
  await flush()
  assert.deepEqual(changes.splice(0), [['apps/desktop/src/main/index.ts']])
  fs.mkdirSync(path.join(main, 'nested'))
  fs.writeFileSync(path.join(main, 'nested/entry.ts'), 'added')
  emitMain('nested')
  await flush()
  assert.deepEqual(changes.splice(0), [['apps/desktop/src/main/nested/entry.ts']])
  fs.renameSync(path.join(main, 'nested'), path.join(main, 'renamed'))
  emitMain(null)
  await flush()
  assert.deepEqual(changes.splice(0), [['apps/desktop/src/main/nested/entry.ts', 'apps/desktop/src/main/renamed/entry.ts']])
  fs.rmSync(path.join(main, 'renamed'), { recursive: true })
  emitMain('renamed')
  await flush()
  assert.deepEqual(changes.splice(0), [['apps/desktop/src/main/renamed/entry.ts']])
  for (const content of ['before', 'after!', 'second']) {
    const temporary = path.join(desktop, 'replacement')
    fs.writeFileSync(temporary, content)
    fs.renameSync(temporary, config)
    emitConfig()
    await flush()
    assert.deepEqual(changes.splice(0), content === 'before' ? [] : [['apps/desktop/electron.vite.config.ts']])
  }
  fs.writeFileSync(path.join(main, 'index.test.ts'), 'excluded')
  fs.mkdirSync(path.join(main, '__pycache__'))
  fs.writeFileSync(path.join(main, '__pycache__/cache.py'), 'excluded')
  emitMain(null)
  await flush()
  assert.deepEqual(changes, [])
})

test('real filesystem monitoring ignores renderer edits and survives repeated atomic config saves', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-native-'))
  const desktop = path.join(directory, 'apps/desktop')
  const main = path.join(desktop, 'src/main')
  const renderer = path.join(desktop, 'src/renderer')
  fs.mkdirSync(main, { recursive: true })
  fs.mkdirSync(renderer)
  const config = path.join(desktop, 'electron.vite.config.ts')
  fs.writeFileSync(config, 'before')
  fs.writeFileSync(path.join(main, 'index.ts'), 'before')
  const changes = []
  const messages = []
  const { watchRestartSources } = require('../desktop.cjs')
  const close = watchRestartSources(directory, message => messages.push(message), paths => changes.push(paths))
  context.after(() => { close(); fs.rmSync(directory, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(renderer, 'view.tsx'), 'renderer only')
  fs.utimesSync(config, new Date(), new Date())
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.deepEqual(changes, [])
  const waitForChange = async expected => {
    const deadline = Date.now() + 5000
    while (!changes.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(changes.splice(0), [expected], messages.join('\n'))
  }
  fs.writeFileSync(path.join(main, 'index.ts'), 'after')
  await waitForChange(['apps/desktop/src/main/index.ts'])
  for (const content of ['first replacement', 'second replacement']) {
    const temporary = path.join(desktop, 'replacement')
    fs.writeFileSync(temporary, content)
    fs.renameSync(temporary, config)
    await waitForChange(['apps/desktop/electron.vite.config.ts'])
  }
})

test('Windows interruption lets the owned host drain and retains unknown shutdown without taskkill', async context => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  context.after(() => { Object.defineProperty(process, 'platform', platform) })
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  let orderly = true
  let unreferenced = false
  let forced = false
  let stopRequests = 0
  context.mock.method(child, 'spawnSync', () => { forced = true; return { status: 0 } })
  context.mock.method(child, 'spawn', (_executable, _args, options) => {
    assert.equal(options.detached, true)
    const processChild = new EventEmitter()
    processChild.pid = 987654
    processChild.unref = () => { unreferenced = true }
    process.nextTick(() => {
      process.emit('SIGINT')
      if (orderly) processChild.emit('exit', 130, null)
    })
    return processChild
  })
  delete require.cache[require.resolve('../desktop.cjs')]
  context.after(() => { delete require.cache[require.resolve('../desktop.cjs')] })
  const { supervise: windowsSupervise } = require('../desktop.cjs')
  const invocation = { executable: process.execPath, args: [], options: {} }
  const observation = { shutdownTimeoutMs: 10, requestStop: () => { stopRequests++ } }
  assert.equal(await windowsSupervise(invocation, observation), 130)
  assert.equal(unreferenced, false)
  orderly = false
  assert.equal(await windowsSupervise(invocation, observation), 74)
  assert.equal(stopRequests, 2)
  assert.equal(unreferenced, true)
  assert.equal(forced, false)
})

async function statusFixture(context, targets, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-ready-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const server = http.createServer((request, response) => {
    if (request.url === '/json/list') {
      if (options.stallCdp) return
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(targets(`http://127.0.0.1:${server.address().port}/`)))
    } else {
      response.setHeader('Content-Type', 'text/html')
      response.end(options.html ?? '<html><script type="module" src="/@vite/client"></script></html>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const paths = debugPaths(directory, directory)
  fs.mkdirSync(paths.root, { recursive: true })
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, repo: paths.repo, port: server.address().port }))
  return { directory, paths }
}

test('root dev shortcut prepares skills through ops and help uses the isolated public entry', () => {
  const root = path.resolve(sourceDirectory, '../..')
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(scripts.ops, 'node scripts/ops-cli.cjs')
  assert.equal(scripts.dev, 'node scripts/ops-cli.cjs cd build local --target skills && node scripts/ops-cli.cjs dev')
  assert.equal(Object.hasOwn(scripts, 'dev:debug'), false)
  assert.equal(Object.hasOwn(scripts, 'dev:status'), false)
  assert.equal(Object.hasOwn(scripts, 'debug:status'), false)
  const result = child.spawnSync(process.execPath, ['scripts/dev/desktop.cjs', '--help'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /pnpm ops dev \[/)
  assert.doesNotMatch(result.stdout, /dev:debug/)
})

test('worktree identity isolates state and resolves aliases to the same workspace', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-paths-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = path.join(root, 'first')
  const second = path.join(root, 'second')
  fs.mkdirSync(first)
  fs.mkdirSync(second)
  const paths = debugPaths(first, root)
  assert.deepEqual(debugPaths(path.join(first, '.'), root), paths)
  assert.notEqual(paths.home, debugPaths(second, root).home)
  assert.notEqual(paths.profile, debugPaths(second, root).profile)
  assert.notEqual(path.dirname(paths.home), path.dirname(debugPaths(second, root).home))
  assert.equal(path.dirname(paths.home), path.dirname(paths.profile))
  assert.ok(paths.home.startsWith(root + path.sep))
})

test('development children isolate Codex storage without changing caller configuration', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-environment-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const environments = ['first', 'second'].map(name => {
    const directory = path.join(root, name)
    fs.mkdirSync(directory)
    const paths = debugPaths(directory, root)
    const caller = { PATH: 'caller-path', CODEX_HOME: 'caller-codex', NODE_OPTIONS: '--inspect' }
    const environment = debugEnvironment(paths, caller)
    assert.equal(environment.SCHOLARSEED_CODEX_HOME, path.join(paths.home, 'codex'))
    assert.equal(environment.SCHOLARSEED_HOME, paths.home)
    assert.equal(environment.PATH, caller.PATH)
    assert.equal(environment.NODE_OPTIONS, undefined)
    assert.equal(caller.NODE_OPTIONS, '--inspect')
    assert.equal(caller.SCHOLARSEED_CODEX_HOME, undefined)
    assert.throws(() => debugEnvironment(paths, { CODEX_SQLITE_HOME: 'shared-db' }), /shared overrides/)
    assert.throws(() => debugEnvironment(paths, { SCHOLARSEED_CODEX_HOME: 'shared-home' }), /shared overrides/)
    return environment
  })
  assert.notEqual(environments[0].SCHOLARSEED_CODEX_HOME, environments[1].SCHOLARSEED_CODEX_HOME)
})

test('exclusive launcher lock prevents duplicate startup and only owner releases it', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-lock-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const lock = path.join(directory, 'launcher.json')
  const release = acquire(lock, { pid: process.pid, port: 19222 })
  assert.equal(typeof release, 'function')
  assert.equal(acquire(lock, { pid: process.pid, port: 19223 }), null)
  assert.equal(JSON.parse(fs.readFileSync(lock)).port, 19222)
  release()
  assert.equal(fs.existsSync(lock), false)
})

test('malformed lock fails closed rather than deleting unknown ownership', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-invalid-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const lock = path.join(directory, 'launcher.json')
  fs.writeFileSync(lock, '')
  assert.throws(() => acquire(lock, { pid: process.pid }), /lock/)
  assert.equal(fs.readFileSync(lock, 'utf8'), '')
})

test('a dead launcher requests shutdown; recovery requires its own proof, exited owners and a released port', async context => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-recovery-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const paths = { repo, lock: path.join(repo, 'launcher.json') }
  const port = await freePort()
  const owner = { repo, pid: process.pid + 1, port, scope: randomUUID(), cleanup: 1 }
  const holder = process.pid + 2
  acquire(paths.lock, owner)
  const dead = new Set([owner.pid])
  context.mock.method(process, 'kill', pid => {
    if (dead.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })
  let pending = true
  context.mock.method(leases, 'pending', scope => { assert.equal(scope, owner.scope); return pending })
  let requested = false
  const watcher = monitorLauncher(paths, owner.scope, port, () => { requested = true })
  context.after(watcher.close)
  assert.equal(requested, true)
  await recoverLauncher(paths, 0)
  assert.ok(fs.existsSync(paths.lock))
  assert.throws(() => monitorLauncher(paths, randomUUID(), port, () => {}), /scoped launcher/)
  watcher.complete(holder)
  for (const pid of [holder, process.pid]) {
    await recoverLauncher(paths, 0)
    assert.ok(fs.existsSync(paths.lock))
    dead.add(pid)
  }
  await recoverLauncher(paths, 0)
  assert.ok(fs.existsSync(paths.lock))
  pending = false
  const server = net.createServer()
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  try { await assert.rejects(recoverLauncher(paths, 0), { code: 'EADDRINUSE' }) }
  finally { await new Promise(resolve => server.close(resolve)) }
  assert.ok(fs.existsSync(paths.lock))
  const replacement = { ...owner, scope: randomUUID() }
  fs.writeFileSync(paths.lock, JSON.stringify(replacement))
  assert.throws(() => watcher.complete(holder), /identity changed/)
  await recoverLauncher(paths, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.lock)), replacement)
  fs.writeFileSync(paths.lock, JSON.stringify(owner))
  await Promise.all([recoverLauncher(paths), recoverLauncher(paths)])
  assert.deepEqual(fs.readdirSync(repo), [])
})

test('a detached host receives the scoped stop request while its live launcher retains ownership', async context => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-stop-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const paths = { repo, lock: path.join(repo, 'launcher.json') }
  const owner = { repo, pid: process.pid, scope: randomUUID(), port: await freePort(), cleanup: 1 }
  const release = acquire(paths.lock, owner)
  assert.throws(() => requestLauncherStop(paths.lock, { ...owner, scope: randomUUID() }), /identity changed/)
  requestLauncherStop(paths.lock, owner)
  requestLauncherStop(paths.lock, owner)
  let signal
  const watcher = monitorLauncher(paths, owner.scope, owner.port, value => { signal = value })
  context.after(watcher.close)
  assert.equal(signal, 'SIGINT')
  await assert.rejects(recoverLauncher(paths, 0), /still stopping/)
  release()
  assert.deepEqual(fs.readdirSync(repo), [])
})

test('detached children can write independently while the console receives both streams', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-output-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const lock = path.join(directory, 'launcher.json')
  const scope = randomUUID()
  const targets = { stdout: new PassThrough(), stderr: new PassThrough() }
  const output = openOutput(lock, scope, 10, targets)
  const ready = once(targets.stdout, 'data')
  const diagnostic = once(targets.stderr, 'data')
  const worker = child.spawn(process.execPath, ['-e',
    "process.stdout.write('ready');process.stderr.write('diagnostic');process.on('message',()=>{process.stdout.write('after close');process.disconnect()})"],
  { detached: true, windowsHide: true, stdio: [...output.stdio, 'ipc'] })
  const ended = once(worker, 'exit')
  context.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill() })
  try {
    const [[out], [err]] = await Promise.all([ready, diagnostic])
    assert.equal(out.toString(), 'ready')
    assert.equal(err.toString(), 'diagnostic')
  } finally { output.close() }
  worker.send('finish')
  assert.equal((await ended)[0], 0)
  assert.equal(fs.readFileSync(`${lock}.${scope}.stdout.log`, 'utf8'), 'readyafter close')
  removeOutput(lock, scope)
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('CDP uses an available loopback port and rejects occupied explicit ports', async context => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  await assert.rejects(freePort(server.address().port), /EADDRINUSE/)
  assert.ok(await freePort() > 0)
})

test('dev arguments enable renderer HMR, isolated profile and loopback CDP without watch', () => {
  assert.deepEqual(debugArguments(19223, '/space here/profile'), [
    'dev', '--remoteDebuggingPort', '19223', '--',
    '--remote-debugging-address=127.0.0.1', '--user-data-dir=/space here/profile'
  ])
})

for (const manager of ['npm', 'pnpm', 'yarn']) {
  test(`${manager} forwarding preserves Vite options before the Electron argument boundary`, context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-forward-'))
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    fs.mkdirSync(path.join(directory, 'apps/desktop'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'apps/desktop/package.json'), JSON.stringify({ scripts: { dev: 'electron-vite dev' } }))
    context.mock.method(toolchain, 'ensureNodeDependencies', () => {})
    context.mock.method(toolchain, 'packageManagerCommand', () => ({ name: manager, executable: 'fixture', args: [] }))
    let actual
    context.mock.method(child, 'spawnSync', (command, args) => { actual = args; return { status: 0 } })
    delete require.cache[require.resolve('../../shared/desktop.cjs')]
    const { runDesktop } = require('../../shared/desktop.cjs')
    const args = debugArguments(19222, '/with spaces/profile')
    assert.equal(runDesktop(directory, args), 0)
    assert.deepEqual(actual, ['run', 'dev', ...(manager === 'npm' ? ['--'] : []), ...args.slice(1)])
  })
}

test('help and invalid arguments never prepare dependencies or create user state', async () => {
  const { main } = require('../desktop.cjs')
  assert.equal(await main(['--help'], '/nonexistent'), 0)
  for (const args of [['--watch'], ['--port', '0'], ['--port', '65536'], ['--port', '1;echo'], ['--port']]) {
    await assert.rejects(main(args, '/nonexistent'), /usage/)
  }
})

test('status is read-only for an unstarted worktree', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-status-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const status = await inspectDebug(directory, directory)
  assert.equal(status.state, 'stopped')
  assert.equal(fs.existsSync(path.join(directory, '.ss-debug')), false)
})

test('status probes loopback CDP and reports renderer without changing the lock', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-status-live-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end('<html><script src="/@vite/client"></script></html>')
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify([
      { id: 'main', type: 'page', title: 'Desktop', url: `http://127.0.0.1:${server.address().port}/` },
      { type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/' }
    ]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise(resolve => server.close(resolve)))
  const paths = debugPaths(directory, directory)
  fs.mkdirSync(paths.root, { recursive: true })
  const content = JSON.stringify({ pid: process.pid, repo: paths.repo, port: server.address().port })
  fs.writeFileSync(paths.lock, content)
  const status = await inspectDebug(directory, directory)
  assert.equal(status.state, 'running')
  assert.equal(status.cdpReachable, true)
  assert.deepEqual(status.renderers, [{ id: 'main', title: 'Desktop', url: `http://127.0.0.1:${server.address().port}/` }])
  assert.equal(status.rendererReady, true)
  assert.ok(status.attachCommand.includes(`--cdp=${status.cdp}`))
  assert.deepEqual(requests, ['/json/list', '/'])
  assert.equal(fs.readFileSync(paths.lock, 'utf8'), content)
})

test('status preserves and reports invalid workspace ownership', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-status-owner-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const paths = debugPaths(directory, directory)
  fs.mkdirSync(paths.root, { recursive: true })
  const content = JSON.stringify({ pid: process.pid, repo: 'another-worktree', port: 19222 })
  fs.writeFileSync(paths.lock, content)
  assert.equal((await inspectDebug(directory, directory)).state, 'unknown')
  assert.equal(fs.readFileSync(paths.lock, 'utf8'), content)
})

test('DevTools alone is not a ready business renderer', async context => {
  const { directory } = await statusFixture(context, () => [{ id: 'devtools', type: 'page', url: 'devtools://devtools/' }])
  const status = await inspectDebug(directory, directory)
  assert.equal(status.cdpReachable, true)
  assert.equal(status.rendererReady, false)
  assert.equal(status.reason, 'renderer_missing')
})

test('waiting finds a unique renderer target and accessible Vite document', async context => {
  let probes = 0
  const { directory, paths } = await statusFixture(context, url => ++probes < 2 ? [] : [
    { id: 'main-renderer', type: 'page', title: 'Desktop', url }
  ])
  const before = fs.readFileSync(paths.lock, 'utf8')
  const status = await waitForRenderer(directory, { home: directory, timeoutMs: 1000, intervalMs: 10 })
  assert.equal(status.rendererReady, true)
  assert.equal(status.renderer.id, 'main-renderer')
  assert.equal(status.timedOut, false)
  assert.equal(fs.readFileSync(paths.lock, 'utf8'), before)
})

test('ambiguous renderer targets are not selected and waiting times out', async context => {
  const { directory } = await statusFixture(context, url => [
    { id: 'first', type: 'page', url }, { id: 'second', type: 'page', url }
  ])
  assert.equal((await inspectDebug(directory, directory)).reason, 'renderer_ambiguous')
  const status = await waitForRenderer(directory, { home: directory, timeoutMs: 60, intervalMs: 10 })
  assert.equal(status.rendererReady, false)
  assert.equal(status.timedOut, true)
})

test('a page target serving a non-Vite document is not ready', async context => {
  const { directory } = await statusFixture(context, url => [{ id: 'main', type: 'page', url }], { html: '<html>not a Vite document</html>' })
  const status = await inspectDebug(directory, directory)
  assert.equal(status.rendererReady, false)
  assert.equal(status.reason, 'renderer_document_unavailable')
})

test('a stalled CDP probe respects the overall wait deadline', async context => {
  const { directory } = await statusFixture(context, () => [], { stallCdp: true })
  const status = await waitForRenderer(directory, { home: directory, timeoutMs: 40 })
  assert.equal(status.rendererReady, false)
  assert.equal(status.timedOut, true)
  assert.equal(status.reason, 'cdp_unavailable')
})

test('waiting on an unstarted worktree does not launch or create state', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-stopped-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const status = await waitForRenderer(directory, { home: directory, timeoutMs: 1 })
  assert.equal(status.state, 'stopped')
  assert.equal(status.rendererReady, false)
  assert.equal(status.timedOut, false)
  assert.equal(fs.existsSync(path.join(directory, '.ss-debug')), false)
})

test('status wait options reject invalid or unbounded timeouts', async () => {
  const { main } = require('../desktop.cjs')
  for (const args of [ ['--status', '--timeout', '30'], ['--status', '--wait', '--timeout', '0'],
    ['--status', '--wait', '--timeout', 'Infinity'], ['--status', '--wait', '--timeout', '600001'],
    ['--status', '--wait', '--wait'], ['--wait'] ]) {
    await assert.rejects(main(args, '/nonexistent'), /usage/)
  }
})

test('stale locks fail closed without automatic cleanup', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-stale-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const lock = path.join(directory, 'launcher.json')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  context.mock.method(process, 'kill', () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  assert.throws(() => acquire(lock, { pid: process.pid }), /stale debug lock/)
  assert.equal(fs.existsSync(lock), true)
})

test('supervision cleans descendants even if the immediate launcher exits first', { skip: process.platform === 'win32' }, async () => {
  const descendant = 'process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},1000)'
  const launcher = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),500)`
  const code = await supervise({ executable: process.execPath, args: ['-e', launcher], options: { stdio: 'inherit' } })
  assert.equal(code, 0)
})

test('launcher waits for its own environment holder after the package-manager wrapper exits', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-lease-'))
  const scope = randomUUID()
  const reader = leases.acquire({mode:'read', resources:[directory], scope})
  context.after(() => { reader.release(); fs.rmSync(directory, {recursive:true, force:true}) })
  let returned = false
  const stopped = supervise({executable:process.execPath, args:['-e', 'process.exit(0)'], options:{stdio:'ignore'}}, {scope})
    .then(code => { returned = true; return code })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(returned, false)
  assert.equal(leases.pending(scope), true)
  assert.equal(leases.pending(randomUUID()), false)
  reader.release()
  assert.equal(await stopped, 0)
  assert.equal(leases.pending(scope), false)
})
