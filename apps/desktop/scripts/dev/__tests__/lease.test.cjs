const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const childProcess = require('node:child_process')
const { once, EventEmitter } = require('node:events')
const { test } = require('node:test')
const { acquire } = require('../../../../../scripts/shared/lease.cjs')
const { PROCESS_TREE_UNCONFIRMED_EXIT } = require('../../../../../scripts/shared/execution.cjs')
const python = require('../../../../../scripts/shared/python.cjs')
const toolchain = require('../../../../../scripts/pre/toolchain.cjs')
const { command, desktopPythonPrefix, main, windowsShutdownConfirmed } = require('../runner.cjs')

test('Desktop runner resolves locked package executables', () => {
  assert.match(command('vite', ['--version']), /node_modules[\\/]vite[\\/]bin[\\/]vite\.js$/)
})

test('development host is a fixed internal entry requiring the full Desktop lease', () => {
  assert.equal(command('development', []), path.resolve(__dirname, '../supervision.mjs'))
  assert.throws(() => main(['modules', 'development']), /full Desktop environment lease/)
})

test('development shutdown uncertainty retains the environment lease', async context => {
  context.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter()
    process.nextTick(() => child.emit('close', PROCESS_TREE_UNCONFIRMED_EXIT, null))
    return child
  })
  delete require.cache[require.resolve('../runner.cjs')]
  context.after(() => { delete require.cache[require.resolve('../runner.cjs')] })
  const { start } = require('../runner.cjs')
  let released = false
  const code = await start(path.resolve(__dirname, '../supervision.mjs'), [], {
    directory: '/retained-task-lease', release() { released = true },
  })
  assert.equal(code, PROCESS_TREE_UNCONFIRMED_EXIT)
  assert.equal(released, false)
})

test('Windows only releases the environment lease after an orderly child exit', () => {
  assert.equal(windowsShutdownConfirmed({ status: 0, signal: null }, false), true)
  assert.equal(windowsShutdownConfirmed({ status: 1, signal: null }, false), false)
  assert.equal(windowsShutdownConfirmed({ status: null, signal: 'SIGTERM' }, false), false)
  assert.equal(windowsShutdownConfirmed({ status: 0, signal: null }, true), false)
})

test('development shutdown receipt proves interrupted Windows cleanup without weakening other entries', () => {
  assert.equal(windowsShutdownConfirmed({ status: 130, signal: null }, true, true), true)
  assert.equal(windowsShutdownConfirmed({ status: 143, signal: null }, true, true), true)
  assert.equal(windowsShutdownConfirmed({ status: 1, signal: null }, false, true), true)
  assert.equal(windowsShutdownConfirmed({ status: 0, signal: 'SIGTERM' }, false, true), false)
  assert.equal(windowsShutdownConfirmed({ status: PROCESS_TREE_UNCONFIRMED_EXIT, signal: null }, false, true), false)
  assert.equal(windowsShutdownConfirmed({ status: 130, signal: null }, true, false), false)
  assert.equal(windowsShutdownConfirmed({ status: null, signal: null }, false, true), false)
})

test('Windows development accepts only its private final receipt and forwards explicit stop over IPC', async context => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  context.after(() => { Object.defineProperty(process, 'platform', platform) })
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const receipt = { kind: 'development-stopped', version: 1 }
  let scenario
  let messages = []
  context.mock.method(childProcess, 'spawn', (_executable, args, options) => {
    assert.deepEqual(args, ['--experimental-transform-types', path.resolve(__dirname, '../supervision.mjs')])
    assert.deepEqual(options.stdio, ['inherit', 'inherit', 'inherit', 'ipc'])
    const child = new EventEmitter()
    child.connected = true
    child.send = message => { messages.push(message) }
    process.nextTick(() => {
      if (scenario.interrupt) process.emit('SIGINT')
      for (const message of scenario.receipts) child.emit('message', message)
      child.emit('close', scenario.status, scenario.signal ?? null)
    })
    return child
  })
  delete require.cache[require.resolve('../runner.cjs')]
  context.after(() => { delete require.cache[require.resolve('../runner.cjs')] })
  const { start } = require('../runner.cjs')
  for (scenario of [
    { receipts: [receipt], status: 0, release: true },
    { receipts: [receipt], status: 130, interrupt: true, release: true },
    { receipts: [], status: 0, release: false },
    { receipts: [receipt, receipt], status: 0, release: false },
    { receipts: [{ ...receipt, extra: true }], status: 0, release: false },
    { receipts: [receipt], status: PROCESS_TREE_UNCONFIRMED_EXIT, release: false },
    { receipts: [receipt], status: null, signal: 'SIGTERM', release: false },
  ]) {
    messages = []
    let released = false
    const code = await start(path.resolve(__dirname, '../supervision.mjs'), [], {
      directory: '/retained-development-lease', release() { released = true },
    })
    assert.equal(released, scenario.release)
    assert.equal(code, scenario.release ? scenario.status : PROCESS_TREE_UNCONFIRMED_EXIT)
    assert.deepEqual(messages, scenario.interrupt ? [{ kind: 'development-stop', version: 1, signal: 'SIGINT' }] : [])
  }
})

test('Desktop Python lease follows the backend interpreter rather than VENV', context => {
  const observed = []
  context.mock.method(python, 'inspectPython', executable => {
    observed.push(executable)
    return { prefix: '/runtime/actual-prefix' }
  })
  const resolved = desktopPythonPrefix({ VENV: 'other-env' })
  assert.equal(resolved.executable, path.join(path.resolve(__dirname, '../../../../..'), '.venv', 'bin', 'python'))
  assert.equal(resolved.prefix, '/runtime/actual-prefix')
  assert.deepEqual(observed, [resolved.executable])
})

test('Desktop Python lease respects repository and executable overrides', context => {
  context.mock.method(python, 'inspectPython', executable => ({ prefix: executable.includes('chosen.py') ? '/runtime/custom' : '/runtime/other' }))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop python override '))
  const executable = path.join(root, 'chosen.py')
  fs.writeFileSync(executable, '', { mode: 0o755 })
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const resolved = desktopPythonPrefix({ SCHOLARSEED_REPO: root, SCHOLARSEED_PYTHON: 'chosen.py', PATH: '.', VENV: 'ignored' })
  assert.equal(resolved.executable, fs.realpathSync(executable))
  assert.equal(resolved.prefix, '/runtime/custom')
})

test('Desktop Python lease resolves relative overrides from backend cwd and bare names from PATH', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop python resolver '))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const executable = path.join(bin, `python${suffix}`)
  fs.writeFileSync(executable, '', { mode: 0o755 })
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  context.mock.method(python, 'inspectPython', () => ({ prefix: path.join(root, 'venv') }))
  const relative = toolchain.executable(path.join('bin', `python${suffix}`), { PATH: '' }, root)
  const named = toolchain.executable('python', { PATH: 'bin' }, root)
  assert.equal(relative, fs.realpathSync(executable))
  assert.equal(named, fs.realpathSync(executable))
  assert.equal(desktopPythonPrefix({ SCHOLARSEED_REPO: root, SCHOLARSEED_PYTHON: 'python', PATH: 'bin' }).executable, fs.realpathSync(executable))
})

test('Desktop command holds the inspected Python prefix and Node dependency leases', async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop python lease '))
  const directory = path.join(root, 'registry')
  const prefix = path.join(root, 'python')
  fs.mkdirSync(directory, { mode: 0o700 })
  fs.mkdirSync(prefix, { mode: 0o700 })
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  context.mock.method(python, 'inspectPython', () => ({ prefix }))
  const resources = []
  const code = await main(['desktop', 'vite', '--version'], options => {
    resources.push(...options.resources)
    return acquire({ ...options, directory })
  })
  assert.equal(code, 0)
  assert.ok(resources.includes(prefix))
  assert.ok(resources.includes(path.join(path.resolve(__dirname, '../../..'), 'node_modules')))
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('Desktop runner releases the lease without spawning when Python changes during acquisition', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop python race '))
  const firstPrefix = path.join(root, 'first')
  const secondPrefix = path.join(root, 'second')
  const directory = path.join(root, 'registry')
  fs.mkdirSync(firstPrefix)
  fs.mkdirSync(secondPrefix)
  fs.mkdirSync(directory, { mode: 0o700 })
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let inspected = 0
  context.mock.method(python, 'inspectPython', executable => ({ prefix: ++inspected === 1 ? firstPrefix : secondPrefix }))
  let spawned = false
  context.mock.method(childProcess, 'spawn', () => { spawned = true; throw new Error('must not spawn') })
  let releases = 0
  assert.throws(() => main(['desktop', 'vite', '--version'], options => {
    assert.ok(options.resources.includes(firstPrefix))
    const lease = acquire({ ...options, directory })
    return { ...lease, release() { releases++; lease.release() } }
  }), /environment changed while acquiring its lease/)
  assert.equal(releases, 1)
  assert.equal(spawned, false)
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('Desktop runner releases its lease and signal handlers when spawn throws synchronously', async context => {
  const error = new Error('spawn rejected')
  context.mock.method(childProcess, 'spawn', () => { throw error })
  delete require.cache[require.resolve('../runner.cjs')]
  const { start: startWithRejectedSpawn } = require('../runner.cjs')
  let releases = 0
  const beforeInt = process.listenerCount('SIGINT')
  const beforeTerm = process.listenerCount('SIGTERM')
  await assert.rejects(startWithRejectedSpawn('/invalid/entry', [], { directory: '/lease', release() { releases++ } }), error)
  assert.equal(releases, 1)
  assert.equal(process.listenerCount('SIGINT'), beforeInt)
  assert.equal(process.listenerCount('SIGTERM'), beforeTerm)
})

test('Desktop runner holds a reader through the child lifecycle and releases after exit', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop lease '))
  fs.chmodSync(directory, 0o700)
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const resources = []
  const exitCode = await main(['modules', 'vite', '--version'], options => {
    resources.push(...options.resources)
    return acquire({ ...options, directory })
  })
  assert.equal(exitCode, 0)
  assert.equal(resources.length, 1)
  assert.equal(path.basename(resources[0]), 'node_modules')
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('Desktop runner forwards SIGINT and releases only after the process group exits', { skip: process.platform === 'win32' }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop interrupt lease '))
  fs.chmodSync(directory, 0o700)
  const registry = path.join(directory, 'registry')
  fs.mkdirSync(registry, { mode: 0o700 })
  const resource = path.join(directory, 'runtime')
  const entry = path.join(directory, 'child.cjs')
  fs.writeFileSync(entry, "process.on('SIGINT',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000)")
  const helper = `const { acquire } = require(process.argv[1]); const { start } = require(process.argv[2]); start(process.argv[5], [], acquire({ mode: 'read', resources: [process.argv[4]], directory: process.argv[3] })).then(code=>{process.exitCode=code}).catch(error=>{console.error(error);process.exitCode=1})`
  const child = spawn(process.execPath, ['-e', helper,
    require.resolve('../../../../../scripts/shared/lease.cjs'), require.resolve('../runner.cjs'), registry, resource, entry],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  context.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
    fs.rmSync(directory, { recursive: true, force: true })
  })
  let output = ''
  let errors = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runner did not start: ${output} ${errors}`)), 5000)
    const check = () => {
      if (output.includes('ready')) { clearTimeout(timer); resolve() }
    }
    child.stdout.on('data', check)
    child.once('error', reject)
    child.once('close', (code, signal) => reject(new Error(`runner exited before start: ${code} ${signal} ${errors}`)))
  })
  await ready
  child.kill('SIGINT')
  const [code] = await once(child, 'exit')
  assert.equal(code, 130)
  assert.deepEqual(fs.readdirSync(registry), [])
})

test('development retains its lease when the host is killed while its detached child survives', { skip: process.platform === 'win32' }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'development orphan lease '))
  const registry = path.join(directory, 'registry')
  fs.mkdirSync(registry, { mode: 0o700 })
  const resource = path.join(directory, 'runtime')
  const host = path.join(directory, 'host.cjs')
  const identity = path.join(directory, 'child.json')
  fs.writeFileSync(host, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:child.pid}));child.unref();process.kill(process.pid,'SIGKILL');`)
  const helper = `const cp=require('node:child_process');const spawn=cp.spawn;cp.spawn=(executable,args,options)=>spawn(executable,[process.argv[5]],options);
const {acquire}=require(process.argv[1]);const {start}=require(process.argv[2]);
start(require('node:path').resolve(process.argv[2],'../supervision.mjs'),[],acquire({mode:'read',resources:[process.argv[4]],directory:process.argv[3]})).then(code=>{process.exitCode=code});`
  const runner = spawn(process.execPath, ['-e', helper, require.resolve('../../../../../scripts/shared/lease.cjs'),
    require.resolve('../runner.cjs'), registry, resource, host], { stdio: ['ignore', 'pipe', 'pipe'] })
  context.after(() => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
    if (fs.existsSync(identity)) {
      const { pid } = JSON.parse(fs.readFileSync(identity, 'utf8'))
      try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const [code] = await once(runner, 'exit')
  const { pid } = JSON.parse(fs.readFileSync(identity, 'utf8'))
  assert.doesNotThrow(() => process.kill(pid, 0))
  assert.equal(code, PROCESS_TREE_UNCONFIRMED_EXIT)
  assert.equal(fs.readdirSync(registry).length, 1)
  assert.throws(() => acquire({ mode: 'write', resources: [resource], directory: registry }), /lease/)
})

test('development releases after Ctrl+C only with its final cleanup receipt', { skip: process.platform === 'win32' }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'development orderly lease '))
  const registry = path.join(directory, 'registry')
  fs.mkdirSync(registry, { mode: 0o700 })
  const resource = path.join(directory, 'runtime')
  const host = path.join(directory, 'host.cjs')
  fs.writeFileSync(host, `process.on('SIGINT',()=>{if(process.send)process.send({kind:'development-stopped',version:1},()=>process.exit(130));else process.exit(130)});process.stdout.write('ready\\n');setInterval(()=>{},1000);`)
  const helper = `const cp=require('node:child_process');const spawn=cp.spawn;cp.spawn=(executable,args,options)=>spawn(executable,[process.argv[5]],options);
const {acquire}=require(process.argv[1]);const {start}=require(process.argv[2]);
start(require('node:path').resolve(process.argv[2],'../supervision.mjs'),[],acquire({mode:'read',resources:[process.argv[4]],directory:process.argv[3]})).then(code=>{process.exitCode=code});`
  const runner = spawn(process.execPath, ['-e', helper, require.resolve('../../../../../scripts/shared/lease.cjs'),
    require.resolve('../runner.cjs'), registry, resource, host], { stdio: ['ignore', 'pipe', 'pipe'] })
  context.after(() => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await once(runner.stdout, 'data')
  runner.kill('SIGINT')
  const [code] = await once(runner, 'exit')
  assert.equal(code, 130)
  assert.deepEqual(fs.readdirSync(registry), [])
})
