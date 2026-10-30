const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { test } = require('node:test')
const { acquire } = require('../lease.cjs')
const leases = require('../lease.cjs')
const childProcess = require('node:child_process')
const { assertWindowsPermissions, protectWindowsDirectory } = require('../permissions.cjs')
const { createWorkspace } = require('../workspace.cjs')

const MODULE = path.resolve(__dirname, '../lease.cjs')

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lease 中文 '))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'registry')
  fs.mkdirSync(directory, { mode: 0o700 })
  if (process.platform === 'win32') protectWindowsDirectory(directory)
  return { directory, resource: path.join(root, 'environment') }
}

function take(state, mode = 'write', resources = [state.resource]) {
  return acquire({ mode, resources, directory: state.directory })
}

const native = test
const posix = process.platform === 'win32' ? test.skip : test

native('readers coexist, writers conflict, and independent resources coexist', context => {
  const state = fixture(context)
  const first = take(state, 'read')
  const second = take(state, 'read')
  assert.throws(() => take(state), { code: 'LEASE_CONFLICT' })
  const independent = take(state, 'write', [`${state.resource}-other`])
  independent.release()
  first.release()
  assert.throws(() => take(state), { code: 'LEASE_CONFLICT' })
  second.release()
  take(state).release()
})

posix('physical aliases, absent replacement slots and parent directories conflict', context => {
  const state = fixture(context)
  const pending = take(state)
  fs.mkdirSync(state.resource)
  assert.throws(() => take(state, 'read'), { code: 'LEASE_CONFLICT' })
  pending.release()
  const alias = `${state.resource}-alias`
  fs.symlinkSync(state.resource, alias, 'dir')
  const reader = take(state, 'read', [alias])
  assert.throws(() => take(state), { code: 'LEASE_CONFLICT' })
  assert.throws(() => take(state, 'write', [path.dirname(state.resource)]), { code: 'LEASE_CONFLICT' })
  reader.release()
})

native('resource sets admit atomically without partial reservations', context => {
  const state = fixture(context)
  const other = `${state.resource}-other`
  const first = take(state)
  assert.throws(() => take(state, 'write', [other, state.resource]), { code: 'LEASE_CONFLICT' })
  take(state, 'write', [other]).release()
  first.release()
})

posix('corrupt receipts and abandoned admission gates fail closed', context => {
  const state = fixture(context)
  fs.writeFileSync(path.join(state.directory, 'unknown.json'), '{}', { mode: 0o600 })
  assert.throws(() => take(state), { code: 'LEASE_STATE_INVALID' })
  fs.unlinkSync(path.join(state.directory, 'unknown.json'))
  fs.mkdirSync(path.join(state.directory, 'admission'), { mode: 0o700 })
  assert.throws(() => take(state), { code: 'LEASE_ADMISSION_BUSY' })
})

posix('registry redirects and writable permissions are refused', context => {
  const state = fixture(context)
  fs.chmodSync(state.directory, 0o777)
  assert.throws(() => take(state), { code: 'LEASE_DIRECTORY_UNSAFE' })
  fs.chmodSync(state.directory, 0o700)
  const alias = `${state.directory}-alias`
  fs.symlinkSync(state.directory, alias, 'dir')
  assert.throws(() => acquire({ mode: 'read', resources: [state.resource], directory: alias }), { code: 'LEASE_DIRECTORY_UNSAFE' })
})

native('real child reader blocks parent writer and release restores admission', async context => {
  const state = fixture(context)
  const script = `const {acquire}=require(process.argv[1]);const handle=acquire(JSON.parse(process.argv[2]));process.send('ready');process.on('message',()=>{handle.release();process.exit(0)})`
  const child = spawn(process.execPath, ['-e', script, MODULE, JSON.stringify({ ...state, resources: [state.resource], mode: 'read' })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  context.after(() => { if (child.exitCode === null) child.kill() })
  await once(child, 'message')
  assert.throws(() => take(state), { code: 'LEASE_CONFLICT' })
  const exited = once(child, 'exit')
  child.send('release')
  assert.equal((await exited)[0], 0)
  take(state).release()
})

native('killed child writer leaves a conservative reservation rather than PID recovery', async context => {
  const state = fixture(context)
  const script = `require(process.argv[1]).acquire(JSON.parse(process.argv[2]));process.send('ready');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, ['-e', script, MODULE, JSON.stringify({ directory: state.directory, resources: [state.resource], mode: 'write' })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  context.after(() => { if (child.exitCode === null) child.kill() })
  await once(child, 'message')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  assert.throws(() => take(state, 'read'), { code: 'LEASE_CONFLICT' })
})

native('simultaneous real writers elect exactly one owner', { timeout: process.platform === 'win32' ? 120000 : 15000 }, async context => {
  const state = fixture(context)
  const script = `const {acquire}=require(process.argv[1]);let handle;process.send('ready');process.on('message',message=>{if(message==='start'){try{handle=acquire(JSON.parse(process.argv[2]));process.send('acquired')}catch(error){process.send(error.code)}}else{if(handle)handle.release();process.exit(0)}})`
  const children = Array.from({ length: 4 }, () => spawn(process.execPath,
    ['-e', script, MODULE, JSON.stringify({ directory: state.directory, resources: [state.resource], mode: 'write' })],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
  context.after(() => children.forEach(child => { if (child.exitCode === null) child.kill() }))
  await Promise.all(children.map(child => once(child, 'message')))
  const outcomes = children.map(child => once(child, 'message'))
  children.forEach(child => child.send('start'))
  const messages = (await Promise.all(outcomes)).map(([message]) => message)
  assert.equal(messages.filter(message => message === 'acquired').length, 1)
  assert.equal(messages.filter(message => message === 'LEASE_CONFLICT').length, 3)
  const exits = children.map(child => once(child, 'exit'))
  children.forEach(child => child.send('release'))
  assert.ok((await Promise.all(exits)).every(([code]) => code === 0))
  take(state).release()
})

native('modified ownership cannot release someone else\'s reservation', context => {
  const state = fixture(context)
  const handle = take(state)
  const filename = path.join(state.directory, `${handle.id}.json`)
  const receipt = JSON.parse(fs.readFileSync(filename, 'utf8'))
  receipt.owner = '0'.repeat(64)
  fs.writeFileSync(filename, JSON.stringify(receipt))
  assert.throws(() => handle.release(), { code: 'LEASE_STATE_INVALID' })
  assert.ok(fs.existsSync(filename))
})

test('invalid requests reject without creating a registry', context => {
  const state = fixture(context)
  assert.throws(() => acquire({ directory: state.directory, mode: 'invalid', resources: [state.resource] }), { code: 'LEASE_ARGUMENT_INVALID' })
  assert.throws(() => acquire({ directory: state.directory, mode: 'read', resources: ['relative'] }), { code: 'LEASE_ARGUMENT_INVALID' })
})

test('untrusted SystemRoot inputs fail before any system command is executed', context => {
  const saved = process.env.SystemRoot
  context.after(() => {
    if (saved === undefined) delete process.env.SystemRoot
    else process.env.SystemRoot = saved
  })
  for (const value of ['', 'relative', 'C:\\Windows\\..', '\\\\server\\Windows']) {
    process.env.SystemRoot = value
    assert.throws(() => assertWindowsPermissions('unused'), /OS-provided SystemRoot/)
  }
})

test('Windows verified ACL state supports shared reads and exclusive writes', { skip: process.platform !== 'win32' }, context => {
  const state = fixture(context)
  const first = take(state, 'read')
  const second = take(state, 'read')
  assert.throws(() => take(state), { code: 'LEASE_CONFLICT' })
  first.release()
  second.release()
  take(state).release()
  assert.deepEqual(fs.readdirSync(state.directory), [])
})

test('Windows foreign writable ACL is refused without creating a receipt', { skip: process.platform !== 'win32' }, context => {
  const state = fixture(context)
  const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
  execFileSync(command, [state.directory, '/grant', '*S-1-1-0:(OI)(CI)(F)'], { stdio: 'pipe', windowsHide: true })
  assert.throws(() => take(state), { code: 'LEASE_DIRECTORY_UNSAFE' })
  assert.deepEqual(fs.readdirSync(state.directory), [])
})

native('Python preparation refuses an active reader before executing uv', async context => {
  const state = fixture(context)
  const reader = take(state, 'read')
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  let executions = 0
  context.mock.method(childProcess, 'execFileSync', () => { executions++; throw new Error('must not execute uv') })
  delete require.cache[require.resolve('../python.cjs')]
  const python = require('../python.cjs')
  await assert.rejects(python.prepareDevelopmentEnvironment(path.dirname(state.resource), {
    PYTHON: '3.12', VENV: state.resource, PIP_INDEX_URL: 'https://example.invalid'
  }), { code: 'LEASE_CONFLICT' })
  assert.equal(executions, 0)
  reader.release()
})

native('workspace clean refuses to remove an environment held by a runtime reader', context => {
  const state = fixture(context)
  const repo = path.join(path.dirname(state.directory), 'repo')
  fs.mkdirSync(path.join(repo, '.venv', 'bin'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(repo, 'apps/desktop/node_modules'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'apps/desktop/out'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.venv/pyvenv.cfg'), 'home = /python\n')
  fs.writeFileSync(path.join(repo, '.venv/bin/python'), 'python')
  const reader = take({ ...state, resource: path.join(repo, '.venv') }, 'read')
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  const workspace = createWorkspace(repo)
  assert.throws(() => workspace.clean(), { code: 'LEASE_CONFLICT' })
  for (const target of [path.join(repo, '.venv'), path.join(repo, 'apps/desktop/node_modules'), path.join(repo, 'apps/desktop/out')]) {
    assert.ok(fs.existsSync(target))
  }
  reader.release()
})

native('workspace docs check holds a Python reader lease until the checker exits', context => {
  const state = fixture(context)
  const environment = { VENV: state.resource }
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  const toolchain = require('../../pre/toolchain.cjs')
  context.mock.method(toolchain, 'checkNode', () => {})
  context.mock.method(childProcess, 'spawnSync', () => {
    assert.throws(() => take(state, 'write'), { code: 'LEASE_CONFLICT' })
    return { status: 0 }
  })
  delete require.cache[require.resolve('../workspace.cjs')]
  const workspace = require('../workspace.cjs').createWorkspace(path.resolve(__dirname, '../../..'), environment)
  assert.equal(workspace.docsCheck([]), 0)
  take(state, 'write').release()
})

native('workspace docs check releases its reader after a nonzero checker exit', context => {
  const state = fixture(context)
  const environment = { VENV: state.resource }
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  const toolchain = require('../../pre/toolchain.cjs')
  context.mock.method(toolchain, 'checkNode', () => {})
  context.mock.method(childProcess, 'spawnSync', () => ({ status: 7 }))
  delete require.cache[require.resolve('../workspace.cjs')]
  const workspace = require('../workspace.cjs').createWorkspace(path.resolve(__dirname, '../../..'), environment)
  assert.throws(() => workspace.docsCheck([]), error => error.code === 'CHILD_EXIT' && error.exitCode === 7)
  take(state, 'write').release()
})

native('Python uv write holds the actual VENV lease and releases only after success', async context => {
  const state = fixture(context)
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  context.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(args[0], 'sync')
    assert.equal(options.env.UV_PROJECT_ENVIRONMENT, state.resource)
    assert.throws(() => take(state, 'read'), { code: 'LEASE_CONFLICT' })
  })
  delete require.cache[require.resolve('../python.cjs')]
  await require('../python.cjs').prepareDevelopmentEnvironment(path.dirname(state.resource), {
    PYTHON: '3.12', VENV: state.resource, PIP_INDEX_URL: 'https://example.invalid'
  })
  take(state).release()
})

native('failed Python mutation conservatively retains its reservation', async context => {
  const state = fixture(context)
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  context.mock.method(childProcess, 'execFileSync', () => { throw new Error('uv failed') })
  delete require.cache[require.resolve('../python.cjs')]
  await assert.rejects(require('../python.cjs').prepareDevelopmentEnvironment(path.dirname(state.resource), {
    PYTHON: '3.12', VENV: state.resource, PIP_INDEX_URL: 'https://example.invalid'
  }), /uv failed/)
  assert.throws(() => take(state), { code: 'LEASE_CONFLICT' })
})

native('Node preparation blocks writers, holds its actual dependency lease, and leaves healthy readers undisturbed', context => {
  const state = fixture(context)
  const repo = path.dirname(state.resource)
  const desktop = path.join(repo, 'apps', 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  for (const directory of [repo, desktop]) fs.writeFileSync(path.join(directory, '.node-version'), process.versions.node)
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({
    toolchain: { defaultPackageManager: 'pnpm@12.14.0' }, engines: { node: process.versions.node }
  }))
  fs.writeFileSync(path.join(desktop, 'package-lock.json'), '{"packages":{"":{}}}')
  fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[tool.uv]\nrequired-version = ">=0.12.11"\n')
  const manager = path.join(repo, 'npm-cli.js')
  const uv = path.join(repo, 'uv')
  for (const filename of [manager, uv]) fs.writeFileSync(filename, '', { mode: 0o755 })
  const saved = { ...process.env }
  context.after(() => { process.env = saved })
  Object.assign(process.env, { npm_execpath: manager, npm_config_user_agent: 'npm/11.13.0', UV: uv })
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  context.mock.method(childProcess, 'execFileSync', (command, args) => args.includes(manager)
    ? '1.2.3\n' : args[0] === '--version' ? 'uv 0.12.11\n' : repo)
  const resources = [path.join(desktop, 'node_modules')]
  let installs = 0
  context.mock.method(childProcess, 'spawnSync', () => {
    installs++
    assert.throws(() => take(state, 'read', resources), { code: 'LEASE_CONFLICT' })
    const entry = path.join(desktop, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, '')
    return { status: 0 }
  })
  delete require.cache[require.resolve('../../pre/toolchain.cjs')]
  const { ensureNodeDependencies } = require('../../pre/toolchain.cjs')
  const reader = take(state, 'read', resources)
  assert.throws(() => ensureNodeDependencies(repo), { code: 'LEASE_CONFLICT' })
  assert.equal(installs, 0)
  reader.release()
  ensureNodeDependencies(repo)
  assert.equal(installs, 1)
  const healthyReader = take(state, 'read', resources)
  ensureNodeDependencies(repo)
  assert.equal(installs, 1)
  healthyReader.release()
  take(state, 'write', resources).release()
})
