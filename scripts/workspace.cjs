#!/usr/bin/env node
// Root workspace command owner owning root workspace commands.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { prepareDevelopmentEnvironment, developmentPython } = require('./python.cjs')

const REPO = path.resolve(__dirname, '..')
const DEFAULT_VENV = '.venv'
const DEFAULT_HOME = path.join(os.homedir(), '.scholarseed')
const WHEEL_PROJECTS = [
  ['packages/runtime', 'dist/runtime'],
  ['packages/damoatrace', 'dist/damoatrace'],
  ['packages/adapters/codex', 'dist/adapters']
]
const FORMAT_PATHS = [
  'apps/serve/service', 'apps/serve/tests', 'packages/runtime/scholarseed_runtime',
  'packages/damoatrace/damoatrace', 'packages/adapters/codex/scholarseed_codex', 'scripts', 'tests'
]
const LINT_PATHS = ['apps/serve/service', 'packages/adapters', 'scripts']
const GLOBAL_BINS = ['scholarseed', 'scholarseed-desktop', 'scholarseed-serve', 'damoatrace']
const LEGACY_BINS = ['scholarseed-account', 'mowoker', 'mowoker-ui', 'moderwork', 'moderwork-ui']
const DAMOATRACE_CONTRACTS = [
  'damoatrace.tests.contract_boundary',
  'damoatrace.tests.contract_distribution',
  'damoatrace.tests.e2e_trace_query_cli',
  'damoatrace.tests.contract_offline',
  'damoatrace.tests.contract_diagnostics',
  'damoatrace.tests.contract_content',
  'damoatrace.tests.contract_budget'
]

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO,
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    shell: Boolean(options.shell),
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.status}`)
  return result
}

function npm(args, cwd = REPO) {
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd })
}

function pythonPath(venv = process.env.VENV || DEFAULT_VENV) {
  return developmentPython(REPO, venv)
}

async function install() {
  await prepareDevelopmentEnvironment(REPO, process.env)
  skillsInstall()
  if (process.platform !== 'win32') run('bash', ['scripts/install-git-hooks.sh'])
}

function checkPython() {
  run(process.execPath, ['scripts/python.cjs', 'check', process.env.VENV || DEFAULT_VENV])
}

function skillsInstall() {
  run(pythonPath(), ['-m', 'service.cli.prebundle', '--build'])
}

function skillsVerify() {
  run(pythonPath(), ['-m', 'service.cli.prebundle', '--verify-source'])
}

async function dependencyWheels() {
  await install()
  for (const [project, outdir] of WHEEL_PROJECTS) {
    fs.mkdirSync(path.join(REPO, outdir), { recursive: true })
    run(pythonPath(), ['scripts/wheel.py', '--project', project, '--outdir', outdir])
  }
}

async function damoatraceContract() {
  await install()
  for (const moduleName of DAMOATRACE_CONTRACTS) {
    run(pythonPath(), ['-m', moduleName], { cwd: path.join(REPO, 'packages/damoatrace') })
  }
}

async function damoatraceWheel() {
  await install()
  const packageDirectory = path.join(REPO, 'packages/damoatrace')
  const outdir = path.join(packageDirectory, 'dist')
  fs.mkdirSync(outdir, { recursive: true })
  run(pythonPath(), ['-m', 'build', '--wheel', '--outdir', 'dist', '.'], { cwd: packageDirectory })
  const wheels = fs.readdirSync(outdir).filter(name => name.endsWith('.whl')).map(name => path.join('dist', name))
  run(pythonPath(), ['-m', 'twine', 'check', ...wheels], { cwd: packageDirectory })
}

function config(interactive) {
  const env = { ...process.env, SCHOLARSEED_HOME: process.env.SCHOLARSEED_HOME || DEFAULT_HOME }
  run(pythonPath(), ['scripts/setup_config.py', ...(interactive ? [] : ['--non-interactive'])], { env })
}

function desktop() {
  config(false)
  checkPython()
  npm(['run', 'prepare:python'])
  run(pythonPath(), ['-m', 'service.cli.desktop'])
}

function runBinary(name, args = [], extraEnv = {}) {
  checkPython()
  const executable = path.join(REPO, process.env.VENV || DEFAULT_VENV, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? `${name}.exe` : name)
  run(executable, args, { env: { ...process.env, ...extraEnv } })
}

function serve(dev) {
  checkPython()
  const codex = spawnSync(process.execPath, ['scripts/toolchain.cjs', 'codex'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  const port = process.env.PORT || '8770'
  const cases = process.env.CASES ? ['--cases-root', process.env.CASES] : []
  if (!dev) {
    runBinary('scholarseed-serve', ['--port', port, ...cases], { SCHOLARSEED_CODEX_EXECUTABLE: codex })
    return
  }
  run(pythonPath(), ['-m', 'watchfiles', '--filter', 'python', '--target-type', 'command',
    `${path.join(REPO, process.env.VENV || DEFAULT_VENV, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'scholarseed-serve.exe' : 'scholarseed-serve')} --port ${port}${process.env.CASES ? ` --cases-root ${process.env.CASES}` : ''}`,
    'apps/serve/service', 'packages/runtime/scholarseed_runtime', 'packages/adapters'],
  { env: { ...process.env, SCHOLARSEED_CODEX_EXECUTABLE: codex } })
}

function logs(errorsOnly) {
  const logFile = path.join(process.env.SCHOLARSEED_HOME || DEFAULT_HOME, 'logs', 'scholarseed.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '')
  if (errorsOnly) {
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(line => / (WARNING|ERROR) /.test(line)).slice(-50)
    console.log(lines.join('\n') || '(no log yet)')
  } else {
    run(process.platform === 'win32' ? 'powershell.exe' : 'tail', process.platform === 'win32'
      ? ['-NoProfile', '-Command', `Get-Content -Wait ${JSON.stringify(logFile)}`]
      : ['-f', logFile])
  }
}

function wiki(open) {
  run(pythonPath(), ['scripts/wiki/build_catalog.py'])
  if (!open) return
  const index = path.join(REPO, 'wiki', 'index.html')
  if (process.platform === 'darwin') run('open', [index])
  else if (process.platform === 'win32') run('cmd.exe', ['/c', 'start', '', index])
  else run('xdg-open', [index])
}

function installCmd(remove) {
  const candidates = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), 'bin')]
  if (remove) {
    for (const directory of candidates) for (const name of [...GLOBAL_BINS, ...LEGACY_BINS]) {
      const link = path.join(directory, name)
      if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.rmSync(link)
    }
    return
  }
  const destination = candidates.find(directory => {
    try { fs.mkdirSync(directory, { recursive: true }); fs.accessSync(directory, fs.constants.W_OK); return true } catch { return false }
  })
  if (!destination) throw new Error('no writable bin directory found')
  for (const name of GLOBAL_BINS) {
    const source = path.join(REPO, process.env.VENV || DEFAULT_VENV, 'bin', name)
    if (fs.existsSync(source)) {
      const target = path.join(destination, name)
      fs.rmSync(target, { force: true })
      fs.symlinkSync(source, target)
      console.log(`${name} -> ${source}`)
    }
  }
}

function clean(dist) {
  for (const target of [process.env.VENV || DEFAULT_VENV, 'apps/desktop/node_modules', 'apps/desktop/out']) {
    fs.rmSync(path.join(REPO, target), { recursive: true, force: true })
  }
  if (dist) fs.rmSync(process.env.SCHOLARSEED_HOME || DEFAULT_HOME, { recursive: true, force: true })
}

async function main(argv) {
  const [command, ...args] = argv
  switch (command) {
    case 'all': await install(); npm(['run', 'build']); config(true); break
    case 'install': await install(); break
    case 'check-python': checkPython(); break
    case 'skills:install': skillsInstall(); break
    case 'skills:verify': skillsVerify(); break
    case 'dependency-wheels': await dependencyWheels(); break
    case 'damoatrace:contract': await damoatraceContract(); break
    case 'damoatrace:check': run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'fmt-check']); await damoatraceContract(); break
    case 'damoatrace:wheel': await damoatraceWheel(); break
    case 'doctor': run(process.execPath, ['scripts/toolchain.cjs', 'doctor']); break
    case 'check-symlinks': run(process.execPath, ['scripts/symlinks.cjs']); break
    case 'check-toolchain': run(process.execPath, ['scripts/toolchain.cjs', 'check']); break
    case 'ui-find': run(process.execPath, ['--experimental-transform-types', '.agents/skills/ui-component-reuse/scripts/find.mjs', process.env.Q || args.join(' ')]); break
    case 'config': config(true); break
    case 'config-template': config(false); break
    case 'run': runBinary('scholarseed'); break
    case 'desktop': desktop(); break
    case 'health': runBinary('scholarseed-desktop', ['--say', '请只回复 HEALTH_OK']); break
    case 'fmt': run('scripts/format.sh', args); break
    case 'fmt-check': run('scripts/format.sh', ['--check', ...args]); break
    case 'lint': run(pythonPath(), ['scripts/lint.py', ...(args.length ? args : LINT_PATHS)]); break
    case 'python:typecheck': run(pythonPath(), ['-m', 'mypy', ...args]); break
    case 'check': run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'fmt-check']); run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'lint']); run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'python:typecheck']); break
    case 'serve': serve(false); break
    case 'serve-dev': serve(true); break
    case 'logs': logs(false); break
    case 'logs-errors': logs(true); break
    case 'trace-ui': runBinary('damoatrace', ['serve'], { DAMOATRACE_HOME: process.env.SCHOLARSEED_HOME || DEFAULT_HOME }); break
    case 'trace-ui-stop': run(pythonPath(), ['-c', 'from damoatrace.server.launcher import stop; raise SystemExit(0 if stop() else 1)'], { env: { ...process.env, DAMOATRACE_HOME: process.env.SCHOLARSEED_HOME || DEFAULT_HOME } }); break
    case 'wiki': wiki(true); break
    case 'wiki:check': run(pythonPath(), ['scripts/wiki/check.py']); break
    case 'install-cmd': await install(); npm(['run', 'build']); installCmd(false); break
    case 'uninstall-cmd': installCmd(true); break
    case 'clean': clean(false); break
    case 'distclean': clean(true); break
    default: throw new Error(`unknown workspace command: ${command}`)
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(`[workspace] ${error.message}`)
  process.exitCode = 1
})
