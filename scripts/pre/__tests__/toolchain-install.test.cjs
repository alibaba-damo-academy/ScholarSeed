const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const crypto = require('node:crypto')

test('pnpm preparation uses its frozen lock and invalidates lock, config and manager changes', context => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pnpm-entry-')))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const isolatedHome = path.join(directory, 'home')
  fs.mkdirSync(isolatedHome, { mode: 0o700 })
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = isolatedHome
  process.env.USERPROFILE = isolatedHome
  context.after(() => {
    for (const [name, value] of Object.entries(previousHome)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const desktop = path.join(directory, 'apps', 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const version = process.versions.node
  fs.writeFileSync(path.join(directory, '.node-version'), version)
  fs.writeFileSync(path.join(desktop, '.node-version'), version)
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({
    toolchain: { defaultPackageManager: 'pnpm@12.14.0' }, engines: { node: version }
  }))
  fs.writeFileSync(path.join(directory, 'pyproject.toml'), '[tool.uv]\nrequired-version = ">=0.12.11"\n')
  const lock = path.join(desktop, 'pnpm-lock.yaml')
  const config = path.join(desktop, 'pnpm-workspace.yaml')
  fs.writeFileSync(lock, "lockfileVersion: '9.0'\n")
  fs.writeFileSync(config, 'overrides: {}\n')
  const launcher = path.join(directory, 'pnpm.cjs')
  const uv = path.join(directory, 'uv')
  for (const filename of [launcher, uv]) fs.writeFileSync(filename, '', { mode: 0o755 })
  const saved = { ...process.env }
  process.env.npm_execpath = launcher
  process.env.npm_config_user_agent = 'pnpm/12.14.0'
  process.env.UV = uv
  context.after(() => { process.env = saved })
  context.mock.method(child, 'execFileSync', (command, args) => {
    if (command === launcher) return '12.14.0\n'
    if (command === uv) return args[0] === '--version' ? 'uv 0.12.11\n' : directory
    return '11.13.0\n'
  })
  const calls = []
  const vite = path.join(desktop, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  context.mock.method(child, 'spawnSync', (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd })
    fs.mkdirSync(path.dirname(vite), { recursive: true })
    fs.writeFileSync(vite, '')
    return { status: 0 }
  })
  delete require.cache[require.resolve('../toolchain.cjs')]
  const { ensureNodeDependencies, checkNodeDependencies } = require('../toolchain.cjs')
  ensureNodeDependencies(directory)
  ensureNodeDependencies(directory)
  assert.deepEqual(calls, [{ command: launcher, args: ['install', '--frozen-lockfile'], cwd: desktop }])
  for (const filename of [lock, config, path.join(desktop, 'package.json')]) {
    fs.appendFileSync(filename, '\n')
    assert.throws(() => checkNodeDependencies(directory), /marker/)
    ensureNodeDependencies(directory)
  }
  const marker = path.join(desktop, 'node_modules', '.scholarseed-package-lock.sha256')
  fs.writeFileSync(marker, 'previous npm installation')
  assert.throws(() => checkNodeDependencies(directory), /marker/)
  ensureNodeDependencies(directory)
  assert.equal(calls.length, 5)
  assert.match(fs.readFileSync(marker, 'utf8'), /pnpm-v12\.14\.0/)
})

test('shared dependency entry installs once and invalidates on changed lock or missing build tool', (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm-entry-test-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const isolatedHome = path.join(directory, 'home')
  fs.mkdirSync(isolatedHome, { mode: 0o700 })
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = isolatedHome
  process.env.USERPROFILE = isolatedHome
  t.after(() => {
    for (const [name, value] of Object.entries(previousHome)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const desktop = path.join(directory, 'apps', 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const version = process.versions.node
  fs.writeFileSync(path.join(directory, '.node-version'), version)
  fs.writeFileSync(path.join(desktop, '.node-version'), version)
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({ toolchain: { defaultPackageManager: 'pnpm@12.14.0' }, engines: { node: version } }))
  const lock = path.join(desktop, 'package-lock.json')
  fs.writeFileSync(lock, '{"packages":{"":{}}}')
  fs.writeFileSync(path.join(directory, 'pyproject.toml'), '[tool.uv]\nrequired-version = ">=0.12.11"\n')
  const npm = path.join(directory, 'npm-cli.js')
  const uv = path.join(directory, process.platform === 'win32' ? 'uv.exe' : 'uv')
  for (const filename of [npm, uv]) { fs.writeFileSync(filename, 'fixture'); fs.chmodSync(filename, 0o755) }
  const saved = { npm: process.env.npm_execpath, userAgent: process.env.npm_config_user_agent, uv: process.env.UV }
  process.env.npm_execpath = npm
  process.env.npm_config_user_agent = 'npm/11.13.0 node/v24.16.0 darwin arm64'
  process.env.UV = uv
  t.after(() => {
    for (const [name, value] of [['npm_execpath', saved.npm], ['npm_config_user_agent', saved.userAgent], ['UV', saved.uv]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  t.mock.method(child, 'execFileSync', (exe, args) => args.includes(npm) ? '1.2.3\n' : args[0] === '--version' ? 'uv 0.12.11\n' : directory)
  let installs = 0
  const vite = path.join(desktop, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  t.mock.method(child, 'spawnSync', () => {
    installs++
    fs.mkdirSync(path.dirname(vite), { recursive: true })
    fs.writeFileSync(vite, 'fixture')
    return { status: 0 }
  })
  delete require.cache[require.resolve('../toolchain.cjs')]
  const { ensureNodeDependencies, checkNodeDependencies } = require('../toolchain.cjs')
  assert.throws(() => checkNodeDependencies(directory), /npm.*install/)
  assert.equal(installs, 0)
  ensureNodeDependencies(directory)
  ensureNodeDependencies(directory)
  assert.equal(installs, 1)
  assert.ok(checkNodeDependencies(directory).node)
  const stamp = path.join(desktop, 'node_modules/.scholarseed-package-lock.sha256')
  const before = fs.readFileSync(stamp, 'utf8')
  fs.writeFileSync(lock, '{"changed":true,"packages":{"":{}}}')
  assert.throws(() => checkNodeDependencies(directory), /npm.*install/)
  assert.equal(fs.readFileSync(stamp, 'utf8'), before)
  assert.equal(installs, 1)
  ensureNodeDependencies(directory)
  assert.equal(installs, 2)
  fs.rmSync(vite)
  assert.throws(() => checkNodeDependencies(directory), /npm.*install/)
  assert.equal(installs, 2)
  ensureNodeDependencies(directory)
  assert.equal(installs, 3)
  const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'))
  pkg.devDependencies = { example: '^1.0.0' }
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg))
  fs.writeFileSync(lock, JSON.stringify({ packages: { '': { devDependencies: { example: '^1.0.0' } }, 'node_modules/example': { version: '1.2.3' } } }))
  fs.writeFileSync(stamp, `${crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')} node-v${version} npm-v1.2.3\n`)
  const marker = fs.readFileSync(stamp, 'utf8')
  assert.throws(() => checkNodeDependencies(directory), /example/)
  const metadata = path.join(desktop, 'node_modules/example/package.json')
  fs.mkdirSync(path.dirname(metadata), { recursive: true })
  fs.writeFileSync(metadata, '{"version":"9.9.9"}')
  assert.throws(() => checkNodeDependencies(directory), /version differs/)
  fs.writeFileSync(metadata, '{"version":"1.2.3"}')
  assert.ok(checkNodeDependencies(directory).node)
  assert.equal(installs, 3)
  assert.equal(fs.readFileSync(stamp, 'utf8'), marker)
  const files = [path.join(desktop, 'package.json'), lock, stamp, metadata]
  const snapshot = () => JSON.stringify(files.map(filename => {
    const stat = fs.statSync(filename)
    return [filename, stat.ino, stat.mtimeMs, stat.ctimeMs, fs.readFileSync(filename, 'utf8')]
  }))
  pkg.devDependencies.example = '^2.0.0'
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg))
  const drifted = snapshot()
  assert.throws(() => checkNodeDependencies(directory), /declaration/)
  assert.equal(snapshot(), drifted)
  const previousInstalls = installs
  assert.throws(() => ensureNodeDependencies(directory), /declaration/)
  assert.equal(installs, previousInstalls + 1)
  pkg.devDependencies.example = '^1.0.0'
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg))
  const safeInstalls = installs
  for (const root of [null, [], 'unknown']) {
    const invalid = { packages: { '': root, 'node_modules/example': { version: '1.2.3' } } }
    fs.writeFileSync(lock, JSON.stringify(invalid))
    fs.writeFileSync(stamp, `${crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')} node-v${version} npm-v1.2.3\n`)
    assert.throws(() => checkNodeDependencies(directory), /lock root/)
    assert.throws(() => ensureNodeDependencies(directory), /lock root/)
  }
  for (const spec of ['latest', 'git+https://example.invalid/package', 'file:../package', { dynamic: true }]) {
    pkg.devDependencies.example = spec
    fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg))
    fs.writeFileSync(lock, JSON.stringify({ packages: { '': { devDependencies: { example: spec } }, 'node_modules/example': { version: '1.2.3' } } }))
    fs.writeFileSync(stamp, `${crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')} node-v${version} npm-v1.2.3\n`)
    assert.throws(() => checkNodeDependencies(directory), /unsupported declaration/)
    assert.throws(() => ensureNodeDependencies(directory), /unsupported declaration/)
  }
  for (const spec of ['npm:original@^1.0.0', 'npm:@scope/original@1.2.3', '>=1.0.0 <2.0.0']) {
    pkg.devDependencies.example = spec
    fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg))
    fs.writeFileSync(lock, JSON.stringify({ packages: { '': { devDependencies: { example: spec } }, 'node_modules/example': { version: '1.2.3' } } }))
    fs.writeFileSync(stamp, `${crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex')} node-v${version} npm-v1.2.3\n`)
    assert.ok(checkNodeDependencies(directory).node)
  }
  assert.equal(installs, safeInstalls)
})

test('Desktop validates checks, ensures preparation and rejects unknown commands before setup', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-policy-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, 'apps/desktop'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'apps/desktop/package.json'), JSON.stringify({ scripts: {
    test: 'test', typecheck: 'check', 'package:verify': 'verify', build: 'build', dev: 'dev',
    'package:check': 'npm run prepare:python && check', 'test:e2e:mr': 'npm run build && test'
  } }))
  const toolchain = require('../toolchain.cjs')
  const calls = []
  context.mock.method(toolchain, 'ensureNodeDependencies', () => { calls.push('ensure') })
  context.mock.method(toolchain, 'checkNodeDependencies', () => { calls.push('check') })
  context.mock.method(toolchain, 'npmCommand', () => ({ executable: 'npm-fixture', args: [] }))
  context.mock.method(child, 'spawnSync', () => ({ status: 0 }))
  delete require.cache[require.resolve('../../shared/desktop.cjs')]
  const { runDesktop } = require('../../shared/desktop.cjs')
  for (const command of ['test', 'typecheck', 'package:verify']) runDesktop(directory, [command])
  assert.deepEqual(calls, ['check', 'check', 'check'])
  for (const command of ['build', 'dev', 'package:check', 'test:e2e:mr']) runDesktop(directory, [command])
  assert.deepEqual(calls.slice(3), ['ensure', 'ensure', 'ensure', 'ensure'])
  assert.throws(() => runDesktop(directory, ['unknown']), /unknown/)
  assert.equal(calls.length, 7)
  context.mock.method(toolchain, 'checkNodeDependencies', () => { throw new Error('missing; npm install') })
  delete require.cache[require.resolve('../../shared/desktop.cjs')]
  const unavailable = require('../../shared/desktop.cjs')
  assert.throws(() => unavailable.runDesktop(directory, ['typecheck']), /npm install/)
  assert.equal(calls.length, 7)
})

test('workspace install prepares Python only and Trace contracts do not build skills or prepare', async context => {
  const python = require('../../shared/python.cjs')
  let preparations = 0
  const calls = []
  context.mock.method(python, 'prepareDevelopmentEnvironment', async () => { preparations++ })
  context.mock.method(python, 'developmentPython', () => '/isolated-fixture/python')
  context.mock.method(python, 'verifyDevelopmentPython', () => ({}))
  context.mock.method(child, 'spawnSync', (command, args) => { calls.push(args); return { status: 0 } })
  delete require.cache[require.resolve('../../shared/workspace.cjs')]
  const workspace = require('../../shared/workspace.cjs').createWorkspace()
  await workspace.install()
  assert.equal(preparations, 1)
  assert.equal(calls.length, 0)
  await workspace.damoatraceContract()
  assert.equal(preparations, 1)
  assert.equal(calls.some(args => args.includes('--build')), false)
})

test('missing Python prerequisite blocks wheels before preparation or build outputs', async context => {
  const python = require('../../shared/python.cjs')
  let preparations = 0
  context.mock.method(python, 'prepareDevelopmentEnvironment', async () => { preparations++ })
  context.mock.method(child, 'spawnSync', () => ({ status: 1 }))
  delete require.cache[require.resolve('../../shared/workspace.cjs')]
  const workspace = require('../../shared/workspace.cjs').createWorkspace()
  for (const method of ['dependencyWheels', 'damoatraceWheel', 'damoatraceContract']) {
    await assert.rejects(workspace[method](), /pnpm ops pre install python --mode desktop/)
  }
  assert.equal(preparations, 0)
})
