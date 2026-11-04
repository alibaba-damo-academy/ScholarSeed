const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const { PREPARATION_PROFILE, resolveCommand } = require('../shared/commands.cjs')
const execution = require('../shared/execution.cjs')
const { launch, launchLong, managerContext } = execution
const desktopOwner = require('../shared/desktop.cjs')
const { prepareDesktop } = desktopOwner
const pythonOwner = require('../shared/python.cjs')
const workspaceLeases = require('../shared/lease.cjs')
const { watchRestartSources, supervise, debugPaths } = require('../dev/desktop.cjs')
const net = require('node:net')

const ROOT = path.resolve(__dirname, '../..')
const ENTRY = path.join(ROOT, 'scripts/ops-cli.cjs')

function invoke(args, cwd = ROOT) {
  return spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: '1' } })
}

function sourceCheckout(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-source 空格-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const extensions = new Set(['.cjs', '.mjs', '.js', '.ts', '.json', '.yaml', '.yml'])
  const copy = relative => {
    const source = path.join(ROOT, relative)
    const stat = fs.lstatSync(source)
    if (stat.isDirectory()) {
      if (['__tests__', 'node_modules', '.venv', '.git'].includes(path.basename(relative))) return
      for (const child of fs.readdirSync(source)) copy(path.join(relative, child))
    } else if (stat.isFile() && extensions.has(path.extname(relative)) && !relative.includes('.test.')) {
      fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true })
      fs.copyFileSync(source, path.join(directory, relative))
    }
  }
  for (const relative of ['scripts', 'apps/desktop/scripts', 'apps/desktop/runtime', 'package.json', 'apps/desktop/package.json']) copy(relative)
  return directory
}

test('help and machine discovery return the registered command contract', () => {
  const result = invoke(['--json', 'list'])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'list')
  assert.ok(report.data.commands.some(command => command.command === 'dev browser'))
  assert.ok(report.data.commands.every(command => command.owner && Array.isArray(command.effects)))
})

test('a source-only checkout closure discovers commands without dependencies or writes', context => {
  const directory = sourceCheckout(context)
  const paths = () => fs.readdirSync(directory, { recursive: true }).sort()
  const before = paths()
  assert.ok(!before.some(filename => filename.split(path.sep).some(part => ['node_modules', '.venv'].includes(part))))
  for (const args of [['--json', 'list'], ['--json', 'version'], ['--help'], ...['pre', 'dev', 'ci', 'cd'].map(domain => [domain, '--help'])]) {
    const result = spawnSync(process.execPath, [path.join(directory, 'scripts/ops-cli.cjs'), ...args], { cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, CI: '1' } })
    assert.equal(result.status, 0, result.stderr)
    if (args.includes('--json')) assert.equal(JSON.parse(result.stdout).schemaVersion, 1)
  }
  assert.deepEqual(paths(), before)
})

test('all default chains offer help without starting their effects', () => {
  for (const domain of ['pre', 'dev', 'ci', 'cd']) {
    const result = invoke([domain, '--help'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /pnpm ops/)
  }
})

test('registered non-leaf commands show scoped help without executing tasks', context => {
  const directory = sourceCheckout(context)
  const paths = () => fs.readdirSync(directory, { recursive: true }).sort()
  const before = paths()
  for (const args of [
    ['pre', 'install'], ['pre', 'repair'], ['pre', 'config'],
    ['ci', 'check', 'types'], ['ci', 'check', 'lint'], ['ci', 'check', 'docs'], ['ci', 'check', 'skills'],
    ['cd', 'build']
  ]) {
    const result = spawnSync(process.execPath, [path.join(directory, 'scripts/ops-cli.cjs'), ...args], {
      cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, CI: '1' }
    })
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    assert.match(result.stdout, /Usage: pnpm ops/)
  }
  assert.deepEqual(paths(), before)
})

test('unknown options and removed paths fail before effects', () => {
  for (const args of [['pre', '--unknown'], ['dev', 'missing'], ['plan', 'dev'], ['pre', 'check'], ['ci', 'write']]) {
    const result = invoke(['--json', ...args])
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENT')
  }
})

test('unimplemented classification and JSON execution fail without running tools', () => {
  for (const args of [['ci', 'test', 'visual', '--scope', 'desktop'], ['ci', 'test', 'api', '--scope', 'serve'], ['pre']]) {
    const result = invoke(['--json', ...args])
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).error.code, 'UNSUPPORTED')
  }
})

test('repository selection validates real identity before execution', () => {
  const bad = invoke(['--repo', path.dirname(ROOT), '--json', 'dev', 'status'])
  assert.equal(bad.status, 1)
  assert.equal(JSON.parse(bad.stdout).error.code, 'REPO_INVALID')
  const good = invoke(['--repo', ROOT, '--json', 'version'], path.dirname(ROOT))
  assert.equal(good.status, 0, good.stderr)
  assert.equal(JSON.parse(good.stdout).repo, ROOT)
})

test('scope and mutating options have closed boundaries', () => {
  const cases = [
    ['ci', 'test', 'smoke', '--scope', 'desktop'],
    ['ci', 'test', 'unit'],
    ['ci', 'format', '--check', '--write'],
    ['ci', 'check', 'lint', 'python', '--fix'],
    ['dev', 'browser', '--mock', '--port', '8888']
  ]
  for (const args of cases) {
    const result = invoke(['--json', ...args])
    assert.notEqual(result.status, 0)
    assert.ok(['INVALID_ARGUMENT', 'UNSUPPORTED'].includes(JSON.parse(result.stdout).error.code))
  }
})

test('default CI and CD chains reuse their exact specialized recipe', () => {
  assert.deepEqual(resolveCommand(['ci']).steps, resolveCommand(['ci', 'test', 'smoke']).steps)
  assert.deepEqual(resolveCommand(['cd']).steps, resolveCommand(['cd', 'build', 'local']).steps)
  const preparation = resolveCommand(['pre']).steps
  assert.equal(preparation[0].file, 'scripts/pre/toolchain.cjs')
  assert.equal(preparation.at(-1).args[0], 'doctor')
  assert.ok(preparation.some(step => step.method === 'install'))
  assert.ok(preparation.some(step => step.file === 'apps/desktop/scripts/pre/office-assets.cjs'))
  assert.equal(resolveCommand(['pre']).profile, PREPARATION_PROFILE.id)
  assert.equal(PREPARATION_PROFILE.id, 'desktop-development')
})

test('real, mock, coverage and package candidate keep separate Owner recipes', () => {
  assert.equal(resolveCommand(['dev', 'browser']).steps[0].script, 'dev:web')
  assert.equal(resolveCommand(['dev', 'pdfe']).steps[0].script, 'dev:pdfe')
  assert.throws(() => resolveCommand(['dev', 'browser', '--mock']), /Browser Mock Preview is retired/)
  assert.equal(resolveCommand(['ci', 'test', '--scope', 'desktop', '--coverage']).steps[0].script, 'test:coverage')
  assert.equal(resolveCommand(['cd', 'build', 'release', '--stage', 'dir', '--candidate']).steps[0].script, 'package:check')
  assert.equal(resolveCommand(['cd', 'build', 'release', '--workflow', 'distribution']).steps[0].file, 'scripts/cd/distribution.cjs')
  assert.equal(resolveCommand(['cd', 'build', 'local', '--workflow', 'package-acceptance']).steps[0].file, 'scripts/cd/package.cjs')
  assert.deepEqual(resolveCommand(['cd', 'build', 'release', '--channel', 'preview']).steps[0].args, ['--channel', 'preview'])
  assert.throws(() => resolveCommand(['cd', 'build', 'local', '--channel', 'preview']), /do not have release channels/)
  assert.throws(() => resolveCommand(['cd', 'build', 'local', '--target', 'web', '--channel', 'release']), /Only direct local target/)
})

test('GitLab Serve contract and Desktop smoke recipes are fixed and context-scoped', () => {
  const serve = resolveCommand(['ci', 'test', 'integration', '--scope', 'serve', '--suite', 'gitlab-contract'])
  assert.deepEqual(serve.steps, [{ kind: 'workspace', method: 'serveContracts', args: [] }])
  assert.deepEqual(serve.contexts, ['ci'])

  const desktop = resolveCommand(['ci', 'test', 'e2e', '--scope', 'desktop', '--suite', 'smoke'])
  assert.deepEqual(desktop.steps, [{ kind: 'workspace', method: 'desktopSmoke', args: [] }])
  assert.deepEqual(desktop.contexts, ['ci'])
  assert.throws(() => resolveCommand(['ci', 'test', 'e2e', '--scope', 'desktop', '--suite', 'unknown']), /No exact/)
  for (const extra of [['--ui'], ['--coverage'], ['--', '--project=live']]) {
    assert.throws(() => resolveCommand(['ci', 'test', 'e2e', '--scope', 'desktop', '--suite', 'smoke', ...extra]))
  }
})

test('GitLab Serve contract preserves the runner cwd, fixed argv and PYTHONPATH', context => {
  const environment = { CI: '1', PYTHON: '3.12', VENV: '.venv', PYTHONPATH: 'inherited', MARKER: 'preserved' }
  let invocation
  let lease
  context.mock.method(pythonOwner, 'developmentPython', (repo, venv, options) => {
    assert.equal(repo, ROOT)
    assert.equal(venv, '.venv')
    assert.equal(options.context, 'ci')
    return path.join(ROOT, '.venv', 'bin', 'python')
  })
  context.mock.method(workspaceLeases, 'acquire', options => {
    lease = options
    return { release() {} }
  })
  context.mock.method(execution, 'launch', (executable, args, options) => {
    invocation = { executable, args, options }
    return { exitCode: 0 }
  })
  delete require.cache[require.resolve('../shared/workspace.cjs')]
  const workspace = require('../shared/workspace.cjs').createWorkspace(ROOT, environment, { context: 'ci' })
  context.after(() => { delete require.cache[require.resolve('../shared/workspace.cjs')] })

  workspace.serveContracts()

  assert.deepEqual(invocation, {
    executable: path.join(ROOT, '.venv', 'bin', 'python'),
    args: ['-m', 'tests.run_all', '--fast', '--no-runtime-binary'],
    options: {
      cwd: path.join(ROOT, 'apps', 'serve'),
      env: { ...environment, PYTHONPATH: '.' },
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false
    }
  })
  assert.deepEqual(lease, { mode: 'read', resources: [path.join(ROOT, '.venv')] })
})

test('GitLab Desktop smoke delegates only the fixed Playwright project to the Desktop Owner', context => {
  const environment = { CI: '1', npm_execpath: '/npm-cli.js', npm_config_user_agent: 'npm/11.0.0' }
  let invocation
  context.mock.method(desktopOwner, 'runDesktop', (repo, args, env, source) => {
    invocation = { repo, args, env, source }
    return 0
  })
  delete require.cache[require.resolve('../shared/workspace.cjs')]
  const workspace = require('../shared/workspace.cjs').createWorkspace(ROOT, environment, { context: 'ci' })
  context.after(() => { delete require.cache[require.resolve('../shared/workspace.cjs')] })

  workspace.desktopSmoke()

  assert.deepEqual(invocation, { repo: ROOT, args: ['test:e2e', '--project=smoke'], env: environment,
    source: { recipe: 'gitlab' } })
})

test('GitLab smoke uses the original exact npm recipe without local dependency preparation', context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-gitlab-smoke-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const desktop = path.join(root, 'apps', 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify({
    scripts: { 'test:e2e': 'playwright test', dev: 'electron-vite dev' }
  }))
  const cli = path.join(root, 'npm-cli.js')
  fs.writeFileSync(cli, 'process.exit(23)\n', { mode: 0o755 })
  const environment = { ...process.env, CI: '1', npm_execpath: cli,
    npm_config_user_agent: 'npm/11.0.0', UV: path.join(root, 'missing-uv') }
  const args = ['test:e2e', '--project=smoke']
  const invocation = prepareDesktop(root, args, environment, { recipe: 'gitlab' })
  assert.equal(invocation.executable, process.execPath)
  assert.deepEqual(invocation.args, [fs.realpathSync(cli), 'run', 'test:e2e', '--', '--project=smoke'])
  assert.equal(invocation.options.cwd, desktop)
  assert.equal(invocation.options.env.UV, environment.UV)
  assert.equal(fs.existsSync(path.join(desktop, 'node_modules')), false)
  assert.equal(desktopOwner.runDesktop(root, args, environment, { recipe: 'gitlab' }), 23)
  for (const rejected of [
    ['test:e2e'], ['test:e2e', '--project=live'],
    ['test:e2e', '--project=smoke', '--grep', 'selected'],
    ['test:e2e', '--project=smoke', '--project=live'], ['dev']
  ]) assert.throws(() => prepareDesktop(root, rejected, environment, { recipe: 'gitlab' }))
  assert.throws(() => prepareDesktop(root, args, environment), /ENOENT|missing|toolchain|executable/)
})

test('preview candidates and distribution select the existing channel-aware Owners', () => {
  const candidate = resolveCommand(['cd', 'build', 'release', '--channel', 'preview', '--stage', 'dir', '--candidate'])
  assert.deepEqual(candidate.steps, [{ kind: 'desktop', script: 'package:check', args: ['--channel', 'preview'] }])
  const distribution = resolveCommand(['cd', 'build', 'release', '--channel', 'preview', '--workflow', 'distribution'])
  assert.deepEqual(distribution.steps, [{ kind: 'node', file: 'scripts/cd/distribution.cjs', args: ['--channel', 'preview'] }])
  assert.throws(() => resolveCommand(['cd', 'build', 'release', '--channel', 'preview', '--candidate']), /directory/)
  assert.throws(() => resolveCommand(['cd', 'build', 'release', '--channel', 'preview', '--stage', 'dir', '--workflow', 'distribution']), /installer/)
  assert.throws(() => resolveCommand(['cd', 'build', 'release', '--channel', 'preview', '--stage', 'dir', '--candidate', '--workflow', 'distribution']), /direct/)
})

test('context selection is source-backed, not a global preparation bypass', () => {
  assert.ok(resolveCommand(['ci', 'check', 'types', 'desktop']).contexts.includes('ci'))
  assert.ok(!resolveCommand(['dev']).contexts.includes('ci'))
  assert.ok(!resolveCommand(['ci', 'test', '--scope', 'desktop']).contexts.includes('ci'))
  assert.throws(() => prepareDesktop(ROOT, ['dev'], process.env, { recipe: 'gitlab' }), /no GitLab/)
  assert.throws(() => prepareDesktop(ROOT, ['typecheck'], process.env, { preparation: false }), /unsupported/)
})

test('manager context reuses the only ops script without exposing an internal worker', () => {
  const env = { ...process.env }
  delete env.npm_execpath
  delete env.npm_config_user_agent
  assert.throws(() => managerContext({}, [], { ...env, npm_execpath: '/npm-cli.js', npm_config_user_agent: 'pnpm/12.14.0' }), /Conflicting/)
  const packageScripts = require('../../package.json').scripts
  assert.equal(packageScripts.ops, 'node scripts/ops-cli.cjs')
  assert.equal(Object.hasOwn(packageScripts, 'ops:worker'), false)
  const delegation = managerContext({ packageManager: 'pnpm', repo: ROOT }, ['ci'], { ...env, PATH: process.env.PATH })
  assert.deepEqual(delegation.args.slice(-2), ['pnpm', 'ci'])
  assert.ok(delegation.args.includes('ops'))
  assert.ok(!delegation.args.includes('ops:worker'))
  assert.ok(!delegation.args.includes('--worker'))
  assert.equal(managerContext({ packageManager: 'pnpm' }, [], {
    ...env, npm_execpath: '/pnpm.cjs', npm_config_user_agent: 'pnpm/12.14.0', npm_lifecycle_event: 'ops'
  }), null)
  const result = invoke(['--json', '--worker', 'pre'])
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENT')
})

test('process execution preserves child status, cwd and Unicode argv', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops 空格-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const expected = 'literal ; $HOME 中文'
  const result = launch(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]}))', expected],
    { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const report = JSON.parse(result.stdout)
  assert.equal(fs.realpathSync(report.cwd), fs.realpathSync(directory))
  assert.equal(report.arg, expected)
  assert.throws(() => launch(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' }), error => error.exitCode === 7 && error.origin === 'child')
})

test('process group observation falls back to exact process listing only when signal probes are denied', () => {
  const { processGroupHasMembers, processGroupExited } = execution
  const calls = []
  const run = (...args) => {
    calls.push(args)
    return { status: 0, stdout: '  12\n 314\n  99\n' }
  }
  assert.equal(processGroupHasMembers(314, run), true)
  assert.equal(processGroupHasMembers(313, run), false)
  assert.deepEqual(calls[0][1], ['-axo', 'pgid='])
  assert.throws(() => processGroupHasMembers(314, () => ({ status: 1, stdout: '', stderr: 'ps failed' })), /process-group state/)
  const denied = () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }) }
  assert.equal(processGroupExited(314, denied, () => false), true)
  assert.equal(processGroupExited(314, denied, () => true), false)
})

test('long-running execution waits for signal cleanup before returning', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-long-run-'))
  const marker = path.join(directory, 'stopped')
  const ready = path.join(directory, 'ready')
  const childProgram = "const fs=require('node:fs');process.once('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(process.argv[2],'done');process.exit(0)},50));fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)"
  const wrapper = `const { launchLong } = require(${JSON.stringify(require.resolve('../shared/execution.cjs'))}); launchLong(process.execPath, ['-e', ${JSON.stringify(childProgram)}, ${JSON.stringify(ready)}, ${JSON.stringify(marker)}], { stdio: 'ignore' }).catch(error => { process.exitCode = error.exitCode }); process.send('ready')`
  const processHandle = spawn(process.execPath, ['-e', wrapper], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  context.after(() => {
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL')
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await once(processHandle, 'message')
  const deadline = Date.now() + 5000
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready), 'long-running child did not reach its signal handler')
  processHandle.kill('SIGINT')
  const [code, signal] = await once(processHandle, 'exit')
  assert.equal(code, 130)
  assert.equal(signal, null)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done')
})

test('long-running spawn failure confirms no child tree exists', async () => {
  await assert.rejects(execution.launchLong('/definitely/missing/ops-child', [], { stdio: 'ignore' }), error => {
    assert.equal(error.code, 'PREREQUISITE_MISSING')
    assert.equal(error.shutdownConfirmed, true)
    return true
  })
})

test('long-running execution lets an owned supervisor finish nested cleanup', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-long-nested-'))
  const marker = path.join(directory, 'stopped')
  const ready = path.join(directory, 'ready')
  const childProgram = "const fs=require('node:fs');process.once('SIGINT',()=>setTimeout(()=>{fs.writeFileSync(process.argv[2],'done');process.exit(0)},1500));fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)"
  const wrapper = `const { launchLong } = require(${JSON.stringify(require.resolve('../shared/execution.cjs'))}); launchLong(process.execPath, ['-e', ${JSON.stringify(childProgram)}, ${JSON.stringify(ready)}, ${JSON.stringify(marker)}], { stdio: 'ignore' }).catch(error => { process.exitCode = error.exitCode })`
  const processHandle = spawn(process.execPath, ['-e', wrapper], { stdio: ['ignore', 'ignore', 'inherit'] })
  context.after(() => {
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL')
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const readyDeadline = Date.now() + 5000
  while (!fs.existsSync(ready) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready), 'owned supervisor did not reach its signal handler')
  processHandle.kill('SIGINT')
  const [code, signal] = await once(processHandle, 'exit')
  assert.equal(code, 130)
  assert.equal(signal, null)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done')
})

test('long-running execution escalates when a process ignores termination signals', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-long-ignore-'))
  const ready = path.join(directory, 'ready')
  const childProgram = "const fs=require('node:fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)"
  const wrapper = `const { launchLong } = require(${JSON.stringify(require.resolve('../shared/execution.cjs'))}); launchLong(process.execPath, ['-e', ${JSON.stringify(childProgram)}, ${JSON.stringify(ready)}], { stdio: 'ignore' }).catch(error => { process.exitCode = error.exitCode })`
  const processHandle = spawn(process.execPath, ['-e', wrapper], { stdio: ['ignore', 'ignore', 'inherit'] })
  context.after(() => {
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL')
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const readyDeadline = Date.now() + 5000
  while (!fs.existsSync(ready) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(fs.existsSync(ready), 'long-running child did not reach its signal handlers')
  const started = Date.now()
  processHandle.kill('SIGINT')
  const [code, signal] = await once(processHandle, 'exit')
  assert.equal(code, 130)
  assert.equal(signal, null)
  assert.ok(Date.now() - started < 15000, 'signal escalation should bound shutdown')
})

test('non-renderer source reminders observe real changes and close without restarting processes', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-watch-'))
  const root = path.join(directory, 'apps/serve/service')
  fs.mkdirSync(root, { recursive: true })
  const filename = path.join(root, 'example.py')
  fs.writeFileSync(filename, 'initial')
  const reports = []
  const close = watchRestartSources(directory, message => reports.push(message))
  context.after(() => { close(); fs.rmSync(directory, { recursive: true, force: true }) })
  fs.writeFileSync(filename, 'changed')
  const deadline = Date.now() + 5000
  while (!reports.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(reports.length, 1)
  assert.match(reports[0], /example\.py/)
  assert.match(reports[0], /No process was restarted/)
  close()
  fs.writeFileSync(filename, 'after-close')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(reports.length, 1)
})

test('source monitoring dispatches structured changes without issuing a manual restart reminder', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-watch-structured-'))
  const root = path.join(directory, 'apps/serve/service')
  fs.mkdirSync(root, { recursive: true })
  const filename = path.join(root, 'example.py')
  fs.writeFileSync(filename, 'initial')
  const reports = []
  const batches = []
  const close = watchRestartSources(directory, message => reports.push(message), changed => batches.push(changed))
  context.after(() => { close(); fs.rmSync(directory, { recursive: true, force: true }) })
  fs.writeFileSync(filename, 'changed')
  const deadline = Date.now() + 5000
  while (!batches.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(batches, [['apps/serve/service/example.py']])
  assert.equal(reports.length, 1)
  assert.match(reports[0], /Non-HMR source changed: \["apps\/serve\/service\/example\.py"\]; automatic reload requested\./)
  assert.doesNotMatch(reports[0], /manual|manually|手动/i)
})

test('existing localization, updater and focused CSP test inputs retain closed adapters', () => {
  assert.deepEqual(resolveCommand(['ci', 'check', 'i18n', '--base', 'HEAD']).steps[0].args, ['--base', 'HEAD'])
  assert.deepEqual(resolveCommand(['ci', 'test', '--scope', 'desktop', '--suite', 'updater', '--archive', '/reviewed/go.tar.gz']).steps[0].args, ['--archive', '/reviewed/go.tar.gz'])
  assert.deepEqual(resolveCommand(['ci', 'test', 'e2e', '--scope', 'desktop', '--', '--project=smoke', 'e2e/csp.spec.ts']).steps[0].args, ['--project=smoke', 'e2e/csp.spec.ts'])
  assert.throws(() => resolveCommand(['ci', 'test', 'e2e', '--scope', 'desktop', '--', '--project=live']), /Only smoke/)
  assert.throws(() => resolveCommand(['ci', 'test', 'e2e', '--scope', 'desktop', '--', '--config', '/arbitrary/config']), /Only smoke/)
  assert.throws(() => resolveCommand(['ci', 'test', 'unit', '--scope', 'desktop', '--', 'e2e/csp.spec.ts']), /generic Desktop E2E/)
})

test('registered execution selects the most specific Owner', () => {
  assert.equal(resolveCommand(['ci', 'check', 'docs', 'workspace']).owner, 'documentation')
  assert.equal(resolveCommand(['ci', 'check', 'i18n']).owner, 'localization')
  assert.equal(resolveCommand(['ci', 'format']).owner, 'formatter')
})

test('tooling debug preserves one Node test invocation and its original file order', () => {
  const recipe = resolveCommand(['ci', 'test', '--scope', 'tooling', '--suite', 'debug'])
  assert.equal(recipe.steps.length, 1)
  assert.equal(recipe.steps[0].test, true)
  assert.equal(recipe.steps[0].file, 'scripts/dev/__tests__/desktop.test.cjs')
  assert.deepEqual(recipe.steps[0].args, ['scripts/pre/__tests__/toolchain-install.test.cjs'])
})

test('startup observation distinguishes ready, premature zero exit and original failures', async () => {
  const invocation = code => ({ executable: process.execPath, args: ['-e', `setTimeout(()=>process.exit(${code}),100)`], options: { stdio: 'ignore' } })
  assert.equal(await supervise(invocation(0), { observe: async () => ({ rendererReady: true }) }), 0)
  assert.equal(await supervise(invocation(0), { observe: async () => ({ rendererReady: false }), intervalMs: 10 }), 1)
  assert.equal(await supervise(invocation(7), { observe: async () => ({ rendererReady: false }), intervalMs: 10 }), 7)
})

test('interrupting startup cancels observers and removes signal handlers', async () => {
  const before = process.listenerCount('SIGINT')
  let observations = 0
  const timer = setTimeout(() => process.emit('SIGINT'), 300)
  try {
    const status = await supervise({ executable: process.execPath,
      args: ['-e', 'process.on("SIGINT",()=>process.exit(0));setInterval(()=>{},1000)'], options: { stdio: 'ignore' } },
    { observe: async () => { observations += 1; return { rendererReady: false } }, intervalMs: 10 })
    assert.equal(status, 130)
    assert.equal(process.listenerCount('SIGINT'), before)
    const final = observations
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(observations, final)
  } finally { clearTimeout(timer) }
})

test('cross-checkout JSON forwarding preserves affected fallback, waiting status and child error exactly once', async context => {
  const directory = sourceCheckout(context)
  const home = path.join(directory, 'temporary-home')
  fs.mkdirSync(home)
  const env = { ...process.env, HOME: home, USERPROFILE: home, CI: '1' }
  const invokeTarget = args => spawnSync(process.execPath, [ENTRY, '--repo', directory, '--json', ...args],
    { cwd: ROOT, env, encoding: 'utf8' })
  const affected = invokeTarget(['ci', 'test', '--affected', 'unknown.binary'])
  assert.equal(affected.status, 3, affected.stderr)
  assert.equal(JSON.parse(affected.stdout).kind, 'affected')
  const failed = invokeTarget(['ci', 'test', '--affected', '--base', 'no-such-ref'])
  assert.equal(failed.status, 1)
  assert.equal(JSON.parse(failed.stdout).kind, 'error')
  const server = net.createServer(socket => socket.on('error', () => {}))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())
  const state = debugPaths(directory, home)
  fs.mkdirSync(state.root, { recursive: true })
  fs.writeFileSync(state.lock, JSON.stringify({ pid: process.pid, repo: state.repo, port: server.address().port }))
  const waiting = invokeTarget(['dev', 'status', '--wait', '--timeout', '100'])
  assert.equal(waiting.status, 2, waiting.stderr)
  const report = JSON.parse(waiting.stdout)
  assert.equal(report.kind, 'status')
  assert.equal(report.data.timedOut, true)
})

test('isolated logs read actual Owner files without creating missing logs or following foreign links', context => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-logs-'))
  context.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const env = { ...process.env, HOME: home, USERPROFILE: home, CI: '1' }
  const invokeLogs = () => spawnSync(process.execPath, [ENTRY, 'dev', 'logs', '--errors'], { cwd: ROOT, env, encoding: 'utf8' })
  const before = fs.readdirSync(home)
  const missing = invokeLogs()
  assert.equal(missing.status, 1)
  assert.deepEqual(fs.readdirSync(home), before)
  const state = debugPaths(ROOT, home)
  const logs = path.join(state.home, 'logs')
  fs.mkdirSync(logs, { recursive: true })
  fs.writeFileSync(path.join(logs, 'backend.log'), Array.from({ length: 60 }, (_, index) =>
    `2026-10-23T00:00:${String(index).padStart(2, '0')}Z ERROR backend-${index}`).join('\n'))
  fs.writeFileSync(path.join(logs, 'window.log'), '2026-10-23T00:01:00Z WARNING window-last\n2026-10-23T00:02:00Z INFO not-an-error\n')
  fs.writeFileSync(path.join(home, 'foreign.log'), '2026-10-23T00:03:00Z ERROR outside-boundary')
  if (process.platform !== 'win32') fs.symlinkSync(path.join(home, 'foreign.log'), path.join(logs, 'foreign.log'))
  const result = invokeLogs()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim().split('\n').length, 50)
  assert.match(result.stdout, /backend\.log: .*backend-59/)
  assert.match(result.stdout, /window\.log: .*window-last/)
  assert.doesNotMatch(result.stdout, /backend-0\b|not-an-error|outside-boundary/)
  assert.equal(fs.existsSync(path.join(logs, 'scholarseed.log')), false)
})
