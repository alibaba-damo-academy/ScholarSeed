#!/usr/bin/env node
// Root workspace command owner owning root workspace commands.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { prepareDevelopmentEnvironment, developmentPython, verifyDevelopmentPython, inspectPython } = require('./python.cjs')
const { checkNode } = require('../pre/toolchain.cjs')
const { launch, launchLong } = require('./execution.cjs')
const { runDesktop } = require('./desktop.cjs')
const { planBuildCleanup, planUserDataCleanup, deleteUserData } = require('../pre/cleanup.cjs')
const { installCommandLinks, uninstallCommandLinks } = require('../pre/commands.cjs')
const leases = require('./lease.cjs')

const DEFAULT_VENV = '.venv'
const DEFAULT_HOME = path.join(os.homedir(), '.scholarseed')
const WHEEL_PROJECTS = [
  ['packages/runtime', 'dist/runtime'],
  ['packages/damoatrace', 'dist/damoatrace'],
  ['packages/adapters/codex', 'dist/adapters']
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

function createWorkspace(directory = path.resolve(__dirname, '../..'), environment = process.env, context = {}) {
  const REPO = fs.realpathSync(directory)

  function run(command, args = [], options = {}) {
    const venv = path.resolve(REPO, environment.VENV || DEFAULT_VENV)
    const executable = path.resolve(command)
    const relative = path.relative(venv, executable)
    const usesVenv = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    const lease = usesVenv ? leases.acquire({ mode: 'read', resources: [venv] }) : null
    const launchOptions = {
      cwd: options.cwd || REPO,
      env: options.env || environment,
      stdio: options.stdio || (!process.stdin.isTTY || environment.CI ? ['ignore', 'inherit', 'inherit'] : 'inherit'),
      shell: Boolean(options.shell)
    }
    try {
      const result = launch(command, args, launchOptions)
      lease?.release()
      return result
    } catch (error) {
      if (!error.signal) lease?.release()
      else console.error(`[workspace] Python process shutdown was not confirmed; environment lease retained at ${lease.directory}`)
      throw error
    }
  }


  function pythonPath(venv = environment.VENV || DEFAULT_VENV) {
    return developmentPython(REPO, venv, { ...context, environment })
  }

  async function install() {
    await prepareDevelopmentEnvironment(REPO, environment)
  }

  function checkPythonPrerequisites(modules) {
    try {
      checkPython()
      run(pythonPath(), ['-I', '-B', '-c', modules.map(name => `import ${name}`).join('; ')])
    } catch (error) { throw new Error(`${error.message}. Run pnpm ops pre install python --mode desktop before this command.`) }
  }

  function checkPython() {
    const interpreter = pythonPath()
    console.log(JSON.stringify(verifyDevelopmentPython(REPO, interpreter, { ...context, venv: environment.VENV || DEFAULT_VENV, environment })))
  }

  function skillsInstall() {
    run(pythonPath(), ['-m', 'service.cli.prebundle', '--build'])
  }

  function skillsVerify() {
    run(pythonPath(), ['-m', 'service.cli.prebundle', '--verify-source'])
  }

  async function dependencyWheels() {
    checkPythonPrerequisites(['build', 'pip'])
    for (const [project, outdir] of WHEEL_PROJECTS) {
      fs.mkdirSync(path.join(REPO, outdir), { recursive: true })
      run(pythonPath(), ['scripts/cd/wheel.py', '--project', project, '--outdir', outdir])
    }
  }

  async function damoatraceContract() {
    checkPythonPrerequisites(['damoatrace'])
    for (const moduleName of DAMOATRACE_CONTRACTS) {
      run(pythonPath(), ['-m', moduleName], { cwd: path.join(REPO, 'packages/damoatrace') })
    }
  }

  async function damoatraceWheel() {
    checkPythonPrerequisites(['build', 'twine'])
    const packageDirectory = path.join(REPO, 'packages/damoatrace')
    const outdir = path.join(packageDirectory, 'dist')
    fs.mkdirSync(outdir, { recursive: true })
    run(pythonPath(), ['-m', 'build', '--wheel', '--outdir', 'dist', '.'], { cwd: packageDirectory })
    const wheels = fs.readdirSync(outdir).filter(name => name.endsWith('.whl')).map(name => path.join('dist', name))
    run(pythonPath(), ['-m', 'twine', 'check', ...wheels], { cwd: packageDirectory })
  }

  function config(interactive) {
    const env = { ...environment, SCHOLARSEED_HOME: environment.SCHOLARSEED_HOME || DEFAULT_HOME }
    run(pythonPath(), ['scripts/pre/config.py', ...(interactive ? [] : ['--non-interactive'])], { env })
  }

  function desktop() {
    config(false)
    checkPython()
    desktopTask('prepare:python')
    run(pythonPath(), ['-m', 'service.cli.desktop'])
  }

  function runBinary(name, args = [], extraEnv = {}) {
    const lease = leases.acquire({ mode: 'read', resources: [path.resolve(REPO, environment.VENV || DEFAULT_VENV)] })
    let invoked = false
    let completed = false
    try {
      const interpreter = pythonPath()
      checkPython()
      const executable = path.join(inspectPython(interpreter).scripts, process.platform === 'win32' ? `${name}.exe` : name)
      invoked = true
      run(executable, args, { env: { ...environment, ...extraEnv } })
      completed = true
    } finally {
      if (!invoked || completed) lease.release()
      else console.error(`[workspace] Runtime shutdown was not confirmed; environment lease retained at ${lease.directory}`)
    }
  }

  async function serve(dev) {
    const lease = leases.acquire({ mode: 'read', resources: [path.resolve(REPO, environment.VENV || DEFAULT_VENV)] })
    let shutdownConfirmed = false
    let runtimeStarted = false
    try {
      checkPython()
      const located = spawnSync(process.execPath, ['scripts/pre/toolchain.cjs', 'codex'], { cwd: REPO, encoding: 'utf8' })
      if (located.error || located.status !== 0 || !located.stdout?.trim()) {
        throw new Error(`Codex lookup failed: ${located.error?.message || located.stderr?.trim() || located.signal || located.status || 'empty output'}`)
      }
      const codex = located.stdout.trim()
      const port = environment.PORT || '8770'
      const cases = environment.CASES ? ['--cases-root', environment.CASES] : []
      const interpreter = pythonPath()
      const childEnvironment = { ...environment, SCHOLARSEED_CODEX_EXECUTABLE: codex }
      const executable = path.join(inspectPython(interpreter).scripts, process.platform === 'win32' ? 'scholarseed-serve.exe' : 'scholarseed-serve')
      const args = dev
        ? ['scripts/dev/watch.py', '--python', interpreter, '--executable', executable, '--port', port, ...cases,
            'apps/serve/service', 'packages/runtime/scholarseed_runtime', 'packages/adapters']
        : ['--port', port, ...cases]
      runtimeStarted = true
      const result = await launchLong(dev ? interpreter : executable, args, {
        cwd: REPO,
        env: childEnvironment,
        stdio: !process.stdin.isTTY || environment.CI ? ['ignore', 'inherit', 'inherit'] : 'inherit'
      })
      shutdownConfirmed = result.shutdownConfirmed
      return result
    } catch (error) {
      shutdownConfirmed = !runtimeStarted || error.shutdownConfirmed === true
      throw error
    } finally {
      if (shutdownConfirmed) lease.release()
      else console.error(`[workspace] Process tree shutdown was not confirmed; environment lease retained at ${lease.directory}`)
    }
  }


  function installCmd(remove) {
    const candidates = process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), 'bin')]
    const venv = environment.VENV ?? DEFAULT_VENV
    const result = remove
      ? uninstallCommandLinks(REPO, venv, candidates, [...GLOBAL_BINS, ...LEGACY_BINS])
      : installCommandLinks(REPO, venv, candidates, GLOBAL_BINS)
    console.log(JSON.stringify(result, null, 2))
  }

  function clean() {
    const targets = planBuildCleanup(REPO, environment.VENV ?? DEFAULT_VENV)
    const lease = leases.acquire({ mode: 'write', resources: targets })
    try {
      for (const target of targets) fs.rmSync(target, { recursive: true, force: true })
      lease.release()
    } catch (error) {
      console.error(`[workspace] Cleanup failed; environment lease retained at ${lease.directory}`)
      throw error
    }
  }

  function userData(remove, args) {
    const home = environment.SCHOLARSEED_HOME ?? DEFAULT_HOME
    if (remove) {
      if (args.length !== 2 || args[0] !== '--confirm') throw new Error('usage: npm run user-data:delete -- --confirm <preview-path>')
      deleteUserData(REPO, home, args[1])
    } else {
      if (args.length) throw new Error('usage: npm run user-data:preview')
      const plan = planUserDataCleanup(REPO, home)
      console.log(JSON.stringify({ ...plan, scope: 'entire user data directory (configuration, credentials, sessions and assets)' }, null, 2))
    }
  }

  function desktopTask(command, args = [], source = {}) {
    const status = runDesktop(REPO, [command, ...args], environment, source)
    if (status !== 0) {
      const error = new Error('Desktop task failed')
      Object.assign(error, { exitCode: status, origin: 'child', code: 'CHILD_EXIT' })
      throw error
    }
  }

  function lint() {
    run(pythonPath(), ['scripts/ci/lint.py', ...LINT_PATHS])
  }

  function pythonTypecheck() {
    run(pythonPath(), ['-m', 'mypy'])
  }

  function serveTests(args) {
    run(pythonPath(), ['-P', '-m', 'tests.run_all', ...args], {
      cwd: path.join(REPO, 'apps', 'serve'),
      env: { ...environment, PYTHONPATH: [path.join(REPO, 'apps', 'serve'), REPO].join(path.delimiter) }
    })
  }

  function serveContracts() {
    if (context.context !== 'ci') throw new Error('The GitLab Serve contract recipe requires --context ci')
    run(pythonPath(), ['-m', 'tests.run_all', '--fast', '--no-runtime-binary'], {
      cwd: path.join(REPO, 'apps', 'serve'),
      env: { ...environment, PYTHONPATH: '.' }
    })
  }

  function desktopSmoke() {
    if (context.context !== 'ci') throw new Error('The GitLab Desktop smoke recipe requires --context ci')
    desktopTask('test:e2e', ['--project=smoke'], { recipe: 'gitlab' })
  }

  async function main(argv) {
    const [command, ...args] = argv
    switch (command) {
      case 'all': await install(); skillsInstall(); desktopTask('build'); config(true); break
      case 'ui-find': run(process.execPath, ['--experimental-transform-types', '.agents/skills/ui-component-reuse/scripts/find.mjs', environment.Q || args.join(' ')]); break
      case 'run': runBinary('scholarseed'); break
      case 'desktop': desktop(); break
      case 'trace-ui': runBinary('damoatrace', ['serve'], { DAMOATRACE_HOME: environment.SCHOLARSEED_HOME || DEFAULT_HOME }); break
      case 'trace-ui-stop': run(pythonPath(), ['-c', 'from damoatrace.server.launcher import stop; raise SystemExit(0 if stop() else 1)'], { env: { ...environment, DAMOATRACE_HOME: environment.SCHOLARSEED_HOME || DEFAULT_HOME } }); break
      case 'install-cmd': await install(); skillsInstall(); desktopTask('build'); installCmd(false); break
      case 'uninstall-cmd': installCmd(true); break
      case 'user-data:preview': userData(false, args); break
      case 'user-data:delete': userData(true, args); break
      default: throw new Error('Use pnpm ops for development tasks')
    }
  }

  return { main, install, checkPython, skillsInstall, skillsVerify, dependencyWheels, damoatraceContract,
    damoatraceWheel, config, runBinary, serve, clean, lint, pythonTypecheck, serveTests,
    serveContracts, desktopSmoke }
}

module.exports = { createWorkspace, main: argv => createWorkspace().main(argv) }
if (require.main === module) createWorkspace().main(process.argv.slice(2)).catch(error => {
  console.error(`[workspace] ${error.message}`)
  process.exitCode = error.exitCode ?? 1
})
