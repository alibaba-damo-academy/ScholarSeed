const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { COMMANDS, resolveCommand, invalid, unsupported } = require('./shared/commands.cjs')
const { CommandError, launch, launchLong, forward, repository, managerContext } = require('./shared/execution.cjs')
const { prepareDesktop } = require('./shared/desktop.cjs')
const { createWorkspace } = require('./shared/workspace.cjs')
const { instanceLogs, inspectDebug, waitForRenderer } = require('./dev/desktop.cjs')
const { format } = require('./ci/format.cjs')

const ROOT = path.resolve(__dirname, '..')
const SCHEMA_VERSION = 1
const WAIT_TIMEOUT_MS = 60000
const GLOBAL_VALUES = new Set(['--repo', '--package-manager', '--context'])
const GLOBAL_FLAGS = new Set(['--json', '--non-interactive'])
const ERROR_LOG_LIMIT = 50

function parse(argv) {
  const settings = { context: 'local', json: false, nonInteractive: false }
  let index = 0
  const seen = new Set()
  for (; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!GLOBAL_VALUES.has(argument) && !GLOBAL_FLAGS.has(argument)) break
    if (seen.has(argument)) invalid(`Repeated option: ${argument}`)
    seen.add(argument)
    if (GLOBAL_VALUES.has(argument)) {
      const value = argv[++index]
      if (!value || value.startsWith('-')) invalid(`${argument} requires a value`)
      settings[{ '--repo': 'repo', '--package-manager': 'packageManager', '--context': 'context' }[argument]] = value
    } else settings[{ '--json': 'json', '--non-interactive': 'nonInteractive' }[argument]] = true
  }
  if (!['local', 'ci'].includes(settings.context)) invalid('--context must be local or ci')
  if (settings.packageManager && !['npm', 'pnpm'].includes(settings.packageManager)) invalid('--package-manager must be npm or pnpm')
  return { settings, command: argv.slice(index) }
}

function redact(value) {
  return String(value).replace(/\b(?:https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '[redacted-url]')
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
}

function envelope(kind, command, settings, data, error) {
  return { schemaVersion: SCHEMA_VERSION, kind, command, repo: settings.repo || null,
    context: settings.context, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) }
}

function emit(kind, command, settings, data, stdout) {
  if (settings.json) stdout.write(`${JSON.stringify(envelope(kind, command, settings, data))}\n`)
  else if (kind === 'help') stdout.write(`${data.text}\n`)
  else if (kind === 'version') stdout.write(`${data.version}\n`)
  else stdout.write(`${JSON.stringify(data, null, 2)}\n`)
}

function help(command = '') {
  const entries = COMMANDS.filter(item => !command || item.command === command || item.command.startsWith(`${command} `))
  return { commands: entries, text: [
    `Usage: pnpm ops${command ? ` ${command}` : ' <pre|dev|ci|cd>'} [options]`,
    'pre: prepare development environment; dev: isolated product, renderer HMR and idle-safe source reload; ci: fixed smoke; cd: local installer.',
    'dev browser: real backend; dev pdfe: isolated Electron Mock workbench.',
    ...entries.map(item => `  ${(item.usage || item.command).padEnd(24)} ${item.description}${item.status === 'planned' ? ' [planned]' : ''}`),
    'Global options (before command): --repo PATH --package-manager npm|pnpm --context local|ci --non-interactive --json',
    'Environment: pre doctor [--scope environment|toolchain|interpreter|deps|links]; pre install python [--mode environment|desktop]; pre install deps; pre repair links; pre config edit|template; pre clean.',
    'Development: dev [--port PORT]; dev browser; dev pdfe; dev serve [--watch]; dev status [--wait [--timeout MS]]; dev logs [--errors].',
    'Checks: ci check types desktop|python; lint python|desktop [--fix]; docs workspace|desktop [--mode MODE] [--write]; i18n [--mode check|gaps] [--generate]; skills product|host [--mode MODE]; ui; preview-bundle; preview-report FILE.',
    'Formatting: ci format [PATH...] [--check|--write]. Tests: ci test [smoke|unit|integration|api|e2e|visual] [--scope desktop|serve|runtime|trace|tooling] [--suite NAME].',
    'Mixed collections: ci test --scope desktop [--coverage]; ci test --scope serve [--list|--suite NAME]; ci test --scope trace [--with-format-check]; ci test --profile quality [--strict] [--with-external] [--result PATH]; ci test --affected [--base REF] [FILES...].',
    'Builds: cd build local|release [--target TARGET] [--stage STAGE] [--workflow WORKFLOW] [--result PATH] [--platform PLATFORM] [--arch ARCH].',
    'Public snapshot: private docs/UI/host-skill checks, full quality and package acceptance are unavailable.',
    'Long-lived tasks block until interrupted. A running process is not product acceptance. Models, release signing and installation require their own prerequisites and authorization.',
    'JSON is supported only by help/list/version, dev status and ci test --affected. Other tasks reject it before effects.'
  ].join('\n') }
}

function globals(settings) {
  return ['--repo', settings.repo, '--context', settings.context,
    ...(settings.nonInteractive ? ['--non-interactive'] : [])]
}

function executeStep(step, settings, environment, runner = launch) {
  const base = { cwd: settings.repo, env: environment,
    stdio: settings.nonInteractive && !step.stdin ? ['ignore', 'inherit', 'inherit'] : 'inherit' }
  if (step.kind === 'node') {
    if (step.file === 'scripts/ci/format.cjs') {
      const status = format(settings.repo, step.args, environment, { context: settings.context })
      if (status !== 0) throw new CommandError('CHILD_EXIT', 'Formatting failed', status, { origin: 'child' })
      return status
    }
    return runner(process.execPath, [...(step.test ? ['--test'] : []), ...(step.types ? ['--experimental-transform-types'] : []), path.join(settings.repo, step.file), ...step.args], base)
  }
  if (step.kind === 'desktop') {
    const invocation = settings.context === 'ci'
      ? prepareDesktop(settings.repo, [step.script, ...step.args], environment, { recipe: 'gitlab' })
      : prepareDesktop(settings.repo, [step.script, ...step.args], environment)
    return runner(invocation.executable, invocation.args, { ...invocation.options, stdio: base.stdio })
  }
  const owner = createWorkspace(settings.repo, environment, { context: settings.context }, { longRunning: runner === launchLong })
  if (!Object.hasOwn(owner, step.method)) throw new CommandError('EXECUTION_FAILED', 'Registered Owner operation is unavailable')
  return owner[step.method](...step.args)
}

async function execute(task, settings, environment, streams) {
  if (!task.contexts.includes(settings.context)) unsupported('No source-backed recipe is registered for this command/context')
  if (!['darwin', 'win32'].includes(process.platform) && settings.context !== 'ci' && !task.status && !task.affected && !task.logs) unsupported('Use a registered CI recipe on this host; product development supports macOS and Windows')
  if (settings.json && !task.json) unsupported('This task does not have a JSON result adapter')
  if (settings.nonInteractive && task.interactive) unsupported('This task requires an interactive terminal')
  if (task.status) {
    const report = task.status['--wait'] ? await waitForRenderer(settings.repo, { timeoutMs: +(task.status['--timeout'] || WAIT_TIMEOUT_MS) }) : await inspectDebug(settings.repo)
    emit('status', task.command, settings, report, streams.stdout)
    return task.status['--wait'] && !report.rendererReady ? report.timedOut ? 2 : 1 : 0
  }
  if (task.affected) {
    const result = spawnSync(process.execPath, [path.join(settings.repo, 'scripts/ci/affected.cjs'), ...(settings.json ? ['--json'] : []), ...task.args],
      { cwd: settings.repo, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    if (result.error) throw new CommandError('PREREQUISITE_MISSING', result.error.message)
    if (![0, 3].includes(result.status)) throw new CommandError('CHILD_EXIT', 'Affected analysis failed', result.status ?? 1, { origin: 'child' })
    if (settings.json) emit('affected', task.command, settings, { ...JSON.parse(result.stdout), exitCode: result.status }, streams.stdout)
    else streams.stdout.write(result.stdout)
    if (result.stderr) streams.stderr.write(redact(result.stderr))
    return result.status
  }
  if (task.logs) {
    const logs = instanceLogs(settings.repo)
    if (!logs.length) throw new CommandError('PREREQUISITE_MISSING', 'Current worktree instance logs are unavailable; start pnpm ops dev first')
    if (task.errorsOnly) {
      const records = logs.flatMap(filename => fs.readFileSync(filename, 'utf8').split(/\r?\n/).flatMap((line, index) => {
        const severity = line.match(/\b(?:DEBUG|INFO|WARNING|ERROR|CRITICAL)\b/)?.[0] || line.match(/"level"\s*:\s*"(debug|info|warn|warning|error|fatal)"/i)?.[1]?.toUpperCase()
        if (!['WARNING', 'WARN', 'ERROR', 'CRITICAL', 'FATAL'].includes(severity)) return []
        const timestamp = line.match(/\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?/)?.[0]
        return [{ filename, index, line, time: timestamp ? Date.parse(timestamp) || 0 : 0 }]
      })).sort((left, right) => left.time - right.time || left.filename.localeCompare(right.filename) || left.index - right.index)
      streams.stdout.write(`${records.slice(-ERROR_LOG_LIMIT).map(record => `${path.basename(record.filename)}: ${record.line}`).join('\n')}\n`)
    } else await launchLong(process.platform === 'win32' ? 'powershell.exe' : 'tail', process.platform === 'win32'
      ? ['-NoProfile', '-Command', '$paths = ConvertFrom-Json $env:SCHOLARSEED_LOG_FILES; Get-Content -LiteralPath $paths -Wait'] : ['-f', ...logs],
    { cwd: settings.repo, env: { ...environment, SCHOLARSEED_LOG_FILES: JSON.stringify(logs) }, stdio: ['ignore', 'inherit', 'inherit'] })
    return 0
  }
  const delegation = managerContext(settings, [...globals(settings), ...settings.command], environment)
  if (delegation) {
    if (task.longRunning) await launchLong(delegation.executable, delegation.args, delegation.options)
    else launch(delegation.executable, delegation.args, delegation.options)
    return 0
  }
  const runner = task.longRunning ? launchLong : launch
  for (const [index, step] of task.steps.entries()) {
    try { await executeStep(step, settings, environment, runner) }
    catch (error) {
      error.failedStep = `${index + 1}:${step.file || step.method || step.script}`
      error.owner = task.owner
      throw error
    }
  }
  return 0
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const streams = { stdout: dependencies.stdout || process.stdout, stderr: dependencies.stderr || process.stderr }
  let settings = { context: 'local', json: argv.includes('--json') }
  try {
    const parsed = parse(argv)
    settings = { ...parsed.settings, command: parsed.command }
    const environment = dependencies.env || process.env
    settings.nonInteractive ||= !process.stdin.isTTY || !!environment.CI
    const command = parsed.command
    if (settings.repo) settings.repo = repository(path.resolve(settings.repo))
    const name = command.join(' ')
    if (!command.length || command[0] === 'help' || command.includes('--help') || command.includes('-h')) {
      const requested = command[0] === 'help' ? command.slice(1) : command.filter(item => !['--help', '-h'].includes(item))
      if (requested.length && !COMMANDS.some(item => item.command === requested.join(' ') || item.command.startsWith(`${requested.join(' ')} `))) resolveCommand(requested)
      emit('help', requested.join(' '), settings, help(requested.join(' ')), streams.stdout)
      return 0
    }
    if (command.length === 1 && command[0] === 'list') {
      emit('list', name, settings, { commands: COMMANDS }, streams.stdout)
      return 0
    }
    if (command.length === 1 && command[0] === 'version') {
      emit('version', name, settings, { version: JSON.parse(fs.readFileSync(path.join(settings.repo || ROOT, 'package.json'), 'utf8')).version }, streams.stdout)
      return 0
    }
    const task = resolveCommand([...command])
    if (task.help) { emit('help', task.command, settings, help(task.command), streams.stdout); return 0 }
    settings.repo ||= repository(ROOT)
    if (settings.repo !== fs.realpathSync(ROOT)) {
      const target = path.join(settings.repo, 'scripts/ops-cli.cjs')
      if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw new CommandError('PREREQUISITE_MISSING', 'Target checkout has no ops CLI implementation')
      const args = [target, ...globals(settings), ...(settings.packageManager ? ['--package-manager', settings.packageManager] : []), ...(settings.json ? ['--json'] : []), ...command]
      if (task.longRunning) {
        await launchLong(process.execPath, args, { cwd: settings.repo, env: environment })
        return 0
      }
      return forward(process.execPath, args, { cwd: settings.repo, env: environment })
    }
    return await execute(task, settings, environment, streams)
  } catch (error) {
    const details = { origin: error.origin || 'cli', code: error.code || 'EXECUTION_FAILED', message: redact(error.message),
      failedStep: error.failedStep || null, owner: error.owner || null, nextAction: 'Run pnpm ops help and inspect the failing Owner prerequisite' }
    if (settings.json) streams.stdout.write(`${JSON.stringify(envelope('error', settings.command?.join(' ') || '', settings,
      error.origin === 'child' ? { exitCode: error.exitCode ?? 1 } : undefined, details))}\n`)
    else streams.stderr.write(`[ops] ${details.code}: ${details.message}\n`)
    return error.exitCode ?? 1
  }
}

module.exports = { main, parse, help, executeStep, redact }
if (require.main === module) main().then(code => { process.exitCode = code })
