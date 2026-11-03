const { CommandError } = require('./execution.cjs')

const TYPES = ['smoke', 'unit', 'integration', 'api', 'e2e', 'visual']
const SCOPES = ['desktop', 'serve', 'runtime', 'trace', 'tooling']
const BUILD_VALUES = ['--result', '--platform', '--arch', '--version', '--build-number', '--update-base-url',
  '--team-id', '--windows-publisher', '--activation-public-keys', '--payload-public-keys',
  '--payload-activation-public-keys', '--payload-private-key', '--payload-key-id', '--payload-compatibility',
  '--go-archive', '--vpk', '--velopack-base', '--verification-root', '--component-cache']
const INTERFACES = {
  'pre doctor': { usage: 'pre doctor [--scope environment|toolchain|interpreter|deps|links]', defaults: { scope: 'environment' } },
  'pre install': { usage: 'pre install python [--mode environment|desktop] | pre install deps', defaults: { pythonMode: 'environment' }, ci: 'python environment only' },
  'pre config': { usage: 'pre config edit|template', interactive: 'edit only' },
  dev: { usage: 'dev [--port PORT]', longRunning: true },
  'dev browser': { usage: 'dev browser', longRunning: true },
  'dev pdfe': { usage: 'dev pdfe', longRunning: true },
  'dev serve': { usage: 'dev serve [--watch]', defaults: { watch: false }, longRunning: true },
  'dev status': { usage: 'dev status [--wait [--timeout MS]]', defaults: { timeoutMs: 60000 } },
  'dev logs': { usage: 'dev logs [--errors]', longRunning: 'unless --errors' },
  'ci check types': { usage: 'ci check types desktop|python', ci: 'GitLab typecheck recipes' },
  'ci check lint': { usage: 'ci check lint python|desktop [--fix]', ci: 'Python check only' },
  'ci check docs': { usage: 'ci check docs workspace|desktop [--mode full|structure|report] [--write] [--strict] [--record PATH]', defaults: { mode: 'full' } },
  'ci check i18n': { usage: 'ci check i18n [--mode check|gaps] [--generate] [--base REF]', defaults: { mode: 'check' }, ci: 'check only' },
  'ci check skills': { usage: 'ci check skills product|host [--mode source|manifest|links]' },
  'ci check preview-report': { usage: 'ci check preview-report FILE|-', stdin: 'only explicit -' },
  'ci format': { usage: 'ci format [PATH...] [--check|--write]', defaults: { write: false }, ci: 'original Python format recipe' },
  'ci test': { usage: 'ci test [TYPE] --scope SCOPE [--suite SUITE] | ci test --profile quality | ci test --affected', ci: 'Desktop coverage or tooling localization only' },
  'ci test unit': { usage: 'ci test unit --scope desktop --suite literature-search|native' },
  'ci test integration': { usage: 'ci test integration --scope desktop --suite native-contract|preview-contract|preview-ui; tooling --suite i18n', ci: 'tooling i18n only' },
  'ci test e2e': { usage: 'ci test e2e --scope desktop [--suite mr|live|update|model-probe] [-- <controlled selection>]' },
  'cd build local': { usage: 'cd build local [--target TARGET] [--stage app|dir|installer] [--workflow direct|package-acceptance]', defaults: { target: 'desktop', stage: 'installer', workflow: 'direct' }, ci: 'app compilation or Python skills/wheels only' },
  'cd build release': { usage: 'cd build release [--channel preview|release] [--stage dir|installer] [--candidate] [--workflow direct|distribution]', defaults: { channel: 'release', stage: 'installer', workflow: 'direct' } }
}
const COMMANDS = [
  ['pre', 'Prepare the worktree development environment', 'toolchain', ['network', 'environment-write']],
  ['pre doctor', 'Diagnose environment prerequisites without automatic repair', 'toolchain', ['probe', 'cache-write', 'network']],
  ['pre install', 'Install Python development environment or Desktop dependencies', 'toolchain', ['network', 'environment-write']],
  ['pre repair links', 'Repair known repository links without overwriting conflicts', 'symlinks', ['repository-write']],
  ['pre config', 'Edit configuration or write a configuration template', 'configuration', ['user-config-write']],
  ['pre clean', 'Remove only the selected worktree development environment', 'cleanup', ['environment-delete']],
  ['dev', 'Run the isolated complete product with renderer hot reload', 'debug', ['process', 'environment-write']],
  ['dev browser', 'Run browser product UI against its real backend', 'desktop', ['process']],
  ['dev pdfe', 'Run the isolated Electron PDFE Mock workbench', 'desktop-pdfe', ['process', 'environment-write']],
  ['dev serve', 'Run the backend independently; --watch enables its source watcher', 'serve', ['process', 'network']],
  ['dev status', 'Observe the isolated worktree instance, not product acceptance', 'debug', []],
  ['dev logs', 'Follow current isolated instance logs; --errors filters recent errors', 'debug', ['process']],
  ['ci', 'Run the fixed core smoke workflow', 'ci', ['test', 'report-write']],
  ['ci check', 'Check source and asset quality; explicit write modes remain guarded', 'quality', ['probe', 'report-write']],
  ['ci check types', 'Check TypeScript or mypy types, not interpreter provenance', 'quality', ['temporary-write']],
  ['ci check lint', 'Check Python or Desktop lint; only Desktop supports --fix', 'quality', ['temporary-write']],
  ['ci check docs', 'Check workspace documents or Desktop standards; explicit write mode is Desktop-only', 'documentation', ['temporary-write', 'report-write']],
  ['ci check i18n', 'Check localization assets, report gaps or explicitly generate derived assets', 'localization', ['temporary-write']],
  ['ci check skills', 'Check product source/manifests or host Skill content and references', 'skills', ['probe']],
  ['ci check ui', 'Report native-control reuse without rewriting budgets or baselines', 'desktop-ui', []],
  ['ci check preview-bundle', 'Verify production artifacts exclude the simulated workbench', 'desktop-preview', ['probe']],
  ['ci check preview-report', 'Read declared test associations; not execution or acceptance results', 'desktop-preview', []],
  ['ci format', 'Check Python formatting; --write explicitly formats source', 'formatter', ['temporary-write']],
  ['ci test', 'Run registered test collections or compute affected recommendations', 'ci', ['test', 'report-write']],
  ...TYPES.map(type => [`ci test ${type}`, type === 'smoke' ? 'Fixed cross-layer core smoke collection' : `${type} tests selected by --scope`, 'ci', ['test', 'report-write']]),
  ['cd', 'Build a local runnable installer without distribution credentials', 'desktop-build', ['build', 'artifact-write']],
  ['cd build local', 'Build local artifacts; macOS retains required ad-hoc signing', 'desktop-build', ['build', 'artifact-write']],
  ['cd build release', 'Build signed channel artifacts, never upload or publish', 'desktop-build', ['build', 'artifact-write', 'signing', 'network']]
].map(([command, description, owner, effects]) => ({ command, description, owner, effects,
  json: command === 'dev status', contexts: INTERFACES[command]?.ci ? ['local', 'ci'] : ['local'],
  platforms: ['darwin', 'win32'], ...(INTERFACES[command]?.ci ? { ciPlatforms: ['linux', 'darwin', 'win32'] } : {}),
  status: ['ci test api', 'ci test visual'].includes(command) ? 'planned' : 'available', ...INTERFACES[command] }))

function invalid(message) { throw new CommandError('INVALID_ARGUMENT', message, 2) }
function unsupported(message) { throw new CommandError('UNSUPPORTED', message) }
function choice(value, values, label) {
  if (!values.includes(value)) invalid(`${label} must be one of: ${values.join(', ')}`)
  return value
}

function options(argv, schema = {}, positional = false) {
  const result = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('-')) {
      if (!positional) invalid(`Unexpected argument: ${argument}`)
      result.positional.push(argument)
      continue
    }
    if (!Object.hasOwn(schema, argument)) invalid(`Unknown option: ${argument}`)
    if (Object.hasOwn(result, argument) && schema[argument] !== Array) invalid(`Repeated option: ${argument}`)
    if (schema[argument] === Boolean) result[argument] = true
    else {
      const value = argv[++index]
      if (!value || value.startsWith('-')) invalid(`${argument} requires a value`)
      if (schema[argument] === Array) (result[argument] ||= []).push(value)
      else result[argument] = value
    }
  }
  return result
}

const node = (file, args = [], extra = {}) => ({ kind: 'node', file, args, ...extra })
const desktop = (script, args = [], extra = {}) => ({ kind: 'desktop', script, args, ...extra })
const workspace = (method, args = []) => ({ kind: 'workspace', method, args })
const PREPARATION_PROFILE = Object.freeze({
  id: 'desktop-development',
  steps: Object.freeze([
    node('scripts/pre/toolchain.cjs', ['check']),
    node('scripts/pre/symlinks.cjs', ['repair']),
    node('scripts/pre/toolchain.cjs', ['ensure']),
    workspace('install'),
    node('apps/desktop/scripts/pre/office-assets.cjs'),
    node('scripts/pre/toolchain.cjs', ['doctor'])
  ])
})
function task(command, steps, extra = {}) {
  const registration = [...COMMANDS].reverse().find(item => command === item.command || command.startsWith(`${item.command} `))
  const effects = new Set(registration?.effects || [])
  for (const step of steps) {
    if (step.script && ['dev', 'dev:web', 'dev:preview', 'build', 'build:web', 'package', 'package:dir', 'package:check', 'package:distribution', 'prepare:python', 'native:contract'].includes(step.script)) {
      effects.add('network'); effects.add('environment-write')
    }
    if (['lint:fix', 'docs:write', 'i18n:generate'].includes(step.script) || step.file === 'scripts/ci/format.cjs' && !step.args.includes('--check')) effects.add('source-write')
    if (step.method === 'runBinary' || step.script?.startsWith('test:e2e') || step.file === 'scripts/cd/package.cjs' || step.args.includes('--with-external')) {
      effects.add('model-possible'); effects.add('external-service')
    }
    if (step.file === 'scripts/cd/package.cjs') effects.add('application-install')
  }
  return { command, steps, owner: registration?.owner || 'workspace', effects: [...effects], json: false, contexts: ['local'], ...extra }
}

function pre(argv) {
  const [action, ...rest] = argv
  if (!action) return task('pre', PREPARATION_PROFILE.steps, { profile: PREPARATION_PROFILE.id })
  if (action === 'doctor') {
    const args = options(rest, { '--scope': String })
    const scope = choice(args['--scope'] || 'environment', ['environment', 'toolchain', 'interpreter', 'deps', 'links'], '--scope')
    const steps = { environment: node('scripts/pre/toolchain.cjs', ['doctor']), toolchain: node('scripts/pre/toolchain.cjs', ['check']),
      interpreter: workspace('checkPython'), deps: node('scripts/pre/toolchain.cjs', ['dependencies']), links: node('scripts/pre/symlinks.cjs', ['check']) }
    return task('pre doctor', [steps[scope]], { scope })
  }
  if (action === 'install') {
    if (!rest.length) return { help: true, command: 'pre install' }
    const [target, ...flags] = rest
    const args = options(flags, { '--mode': String })
    if (target === 'deps' && !args['--mode']) return task('pre install deps', [node('scripts/pre/toolchain.cjs', ['ensure'])])
    if (target !== 'python') invalid('Use pre install python or pre install deps')
    const mode = choice(args['--mode'] || 'environment', ['environment', 'desktop'], '--mode')
    return task('pre install python', mode === 'desktop' ? [desktop('prepare:python')] : [workspace('install')], { contexts: mode === 'environment' ? ['local', 'ci'] : ['local'] })
  }
  if (action === 'repair' && !rest.length) return { help: true, command: 'pre repair' }
  if (action === 'repair' && rest.join(' ') === 'links') return task('pre repair links', [node('scripts/pre/symlinks.cjs', ['repair'])])
  if (action === 'config' && !rest.length) return { help: true, command: 'pre config' }
  if (action === 'config' && ['edit', 'template'].includes(rest[0]) && rest.length === 1) {
    return task(`pre config ${rest[0]}`, [workspace('config', [rest[0] === 'edit'])], { interactive: rest[0] === 'edit' })
  }
  if (action === 'clean' && !rest.length) return task('pre clean', [workspace('clean')])
  invalid('Unknown pre command')
}

function dev(argv) {
  const [action, ...rest] = argv
  if (!action || action.startsWith('-')) {
    const args = options(argv, { '--port': String })
    if (args['--port'] && (!/^\d+$/.test(args['--port']) || +args['--port'] < 1 || +args['--port'] > 65535)) invalid('Invalid --port')
    return task('dev', [node('scripts/dev/desktop.cjs', args['--port'] ? ['--port', args['--port']] : [])], { longRunning: true })
  }
  if (action === 'browser') {
    const args = options(rest, { '--mock': Boolean })
    if (args['--mock']) invalid('Browser Mock Preview is retired; use pnpm ops dev pdfe')
    return task('dev browser', [desktop('dev:web')], { longRunning: true })
  }
  if (action === 'pdfe') {
    options(rest, {})
    return task('dev pdfe', [desktop('dev:pdfe')], { longRunning: true })
  }
  if (action === 'serve') {
    const args = options(rest, { '--watch': Boolean })
    return task('dev serve', [workspace('serve', [!!args['--watch']])], { longRunning: true })
  }
  if (action === 'status') {
    const args = options(rest, { '--wait': Boolean, '--timeout': String })
    if (args['--timeout'] && (!args['--wait'] || !/^\d+$/.test(args['--timeout']) || +args['--timeout'] < 1 || +args['--timeout'] > 600000)) invalid('--timeout requires --wait and 1..600000 milliseconds')
    return task('dev status', [], { json: true, status: args, effects: [] })
  }
  if (action === 'logs') {
    const args = options(rest, { '--errors': Boolean })
    return task('dev logs', [], { logs: true, errorsOnly: !!args['--errors'], longRunning: !args['--errors'] })
  }
  invalid('Unknown dev command')
}

function check(argv) {
  const [target, ...rest] = argv
  if (!target) return { help: true, command: 'ci check' }
  if (target === '--profile') {
    if (rest.length !== 1 || rest[0] !== 'python') invalid('Only --profile python is registered')
    return task('ci check --profile python', [node('scripts/ci/format.cjs', ['--check']), workspace('lint'), workspace('pythonTypecheck')])
  }
  if (target === 'types') {
    if (!rest.length) return { help: true, command: 'ci check types' }
    if (rest.length !== 1) invalid('Use ci check types desktop|python')
    if (rest[0] === 'desktop') return task('ci check types desktop', [desktop('typecheck')], { contexts: ['local', 'ci'] })
    if (rest[0] === 'python') return task('ci check types python', [workspace('pythonTypecheck')], { contexts: ['local', 'ci'] })
  }
  if (target === 'lint') {
    if (!rest.length) return { help: true, command: 'ci check lint' }
    const [scope, ...flags] = rest
    const args = options(flags, { '--fix': Boolean })
    if (scope === 'python') {
      if (args['--fix']) unsupported('Python lint does not support --fix')
      return task('ci check lint python', [workspace('lint')], { contexts: ['local', 'ci'] })
    }
    if (scope === 'desktop') return task('ci check lint desktop', [desktop(args['--fix'] ? 'lint:fix' : 'lint')])
  }
  if (target === 'docs' || target === 'ui' || target === 'skills' && rest[0] === 'host') unsupported('This check belongs to the private development repository')
  if (target === 'docs') {
    if (!rest.length) return { help: true, command: 'ci check docs' }
    const [scope, ...flags] = rest
    const args = options(flags, { '--mode': String, '--write': Boolean, '--strict': Boolean, '--record': Array }, true)
    const mode = args['--mode'] || 'full'
    if (scope === 'workspace') {
      if (args['--write'] || !['full', 'structure'].includes(mode)) unsupported('Workspace docs supports full or structure checks only')
      if (mode === 'structure' && !args.positional.length) invalid('Structure checking requires explicit paths')
      if (mode === 'structure') {
        if (args['--strict'] || args['--record']) invalid('Structure mode only accepts explicit document paths')
        return task('ci check docs workspace', [node('scripts/ci/docs/structure-check.mjs', args.positional)])
      }
      if (args.positional.length) invalid('Full workspace checking does not accept document paths; use --mode structure')
      return task('ci check docs workspace', [workspace('docsCheck', [[...(args['--strict'] ? ['--strict'] : []), ...(args['--record'] || []).flatMap(record => ['--record', record])]])])
    }
    if (scope === 'desktop') {
      if (!['full', 'report'].includes(mode) || args.positional.length || args['--strict'] || args['--record'] || args['--write'] && mode !== 'full') unsupported('Unsupported Desktop docs mode')
      return task('ci check docs desktop', mode === 'report' ? [node('apps/desktop/scripts/ci/standards.mjs', ['--report'], { types: true })] : [desktop(args['--write'] ? 'docs:write' : 'docs:check')])
    }
  }
  if (target === 'i18n') {
    const args = options(rest, { '--mode': String, '--generate': Boolean, '--base': String })
    const mode = choice(args['--mode'] || 'check', ['check', 'gaps'], '--mode')
    if (args['--generate'] && mode !== 'check') unsupported('Generation cannot be combined with gaps reporting')
    if (args['--base'] && (mode !== 'check' || args['--generate'])) unsupported('--base is only registered for localization checking')
    return task('ci check i18n', [desktop(args['--generate'] ? 'i18n:generate' : mode === 'gaps' ? 'i18n:dom:gaps' : 'i18n:check', args['--base'] ? ['--base', args['--base']] : [])], { contexts: !args['--generate'] && mode === 'check' ? ['local', 'ci'] : ['local'] })
  }
  if (target === 'skills') {
    if (!rest.length) return { help: true, command: 'ci check skills' }
    const [scope, ...flags] = rest
    const args = options(flags, { '--mode': String })
    const mode = args['--mode'] || (scope === 'host' ? 'links' : 'source')
    if (scope === 'product' && mode === 'source') return task('ci check skills product', [workspace('skillsVerify')])
    if (scope === 'product' && mode === 'manifest') return task('ci check skills product', [node('scripts/shared/skills.cjs')])
    if (scope === 'host' && mode === 'links') return task('ci check skills host', [node('.agents/skills/knowledge-governance/scripts/skill-links.mjs', ['--root', '.']),
      node('.agents/skills/knowledge-governance/scripts/migration.test.mjs', [], { test: true })])
    unsupported('Unsupported Skill owner/mode')
  }
  if (target === 'ui' && !rest.length) return task('ci check ui', [node('apps/desktop/scripts/ci/reuse.mjs')])
  if (target === 'preview-bundle' && !rest.length) return task('ci check preview-bundle', [desktop('check:preview:bundle')])
  if (target === 'preview-report' && rest.length === 1) return task('ci check preview-report', [node('apps/desktop/preview/report.ts', rest, { types: true, stdin: rest[0] === '-' })])
  invalid('Unknown ci check target')
}

function tests(argv) {
  const type = TYPES.includes(argv[0]) ? argv.shift() : null
  const separator = argv.indexOf('--')
  const native = separator < 0 ? [] : argv.splice(separator).slice(1)
  if (separator >= 0 && type !== 'e2e') invalid('Native selection is only registered for generic Desktop E2E')
  const args = options(argv, { '--scope': String, '--suite': String, '--coverage': Boolean, '--profile': String,
    '--with-external': Boolean, '--strict': Boolean, '--result': String, '--affected': Boolean, '--base': String,
    '--list': Boolean, '--with-format-check': Boolean, '--ui': Boolean, '--archive': String }, true)
  if (args['--affected']) {
    if (type || Object.keys(args).some(key => !['positional', '--affected', '--base'].includes(key))) invalid('Affected selection cannot execute a test collection')
    return task('ci test --affected', [], { json: true, affected: true, args: [...(args['--base'] ? ['--base', args['--base']] : []), ...args.positional], effects: [] })
  }
  if (type === 'smoke') {
    if (Object.keys(args).some(key => key !== 'positional') || args.positional.length) invalid('Smoke is a fixed collection without selection overrides')
    return task('ci test smoke', [node('scripts/ci/smoke.cjs')])
  }
  if (args['--profile'] === 'quality') unsupported('The full quality workflow belongs to the private development repository')
  if (args['--profile']) {
    if (type || args['--profile'] !== 'quality' || args.positional.length || Object.keys(args).some(key => !['positional', '--profile', '--with-external', '--strict', '--result'].includes(key))) invalid('Invalid quality profile combination')
    return task('ci test --profile quality', [node('scripts/ci/test.cjs', [...(args['--with-external'] ? ['--with-external'] : []), ...(args['--strict'] ? ['--strict'] : []), ...(args['--result'] ? ['--result', args['--result']] : [])])])
  }
  if (!type && !args['--scope'] && !Object.keys(args).some(key => key !== 'positional') && !args.positional.length) return { help: true, command: 'ci test' }
  if (args.positional.length || ['--with-external', '--strict', '--result', '--base'].some(key => args[key])) invalid('Unknown test collection or incompatible options')
  const scope = choice(args['--scope'], SCOPES, '--scope')
  const suite = args['--suite']
  if (separator >= 0 && (type !== 'e2e' || scope !== 'desktop' || suite)) invalid('Native selection is only registered for generic Desktop E2E')
  for (let index = 0; index < native.length; index += 1) {
    const argument = native[index]
    if (argument === '--project=smoke') continue
    if (argument === '--project' && native[index + 1] === 'smoke') { index += 1; continue }
    if (['--grep', '--grep-invert'].includes(argument) && native[index + 1] && !native[index + 1].startsWith('-')) { index += 1; continue }
    if (/^e2e\/[\w./-]+\.spec\.ts$/.test(argument) && !argument.split('/').includes('..')) continue
    invalid('Only smoke project, grep filters and repository E2E spec paths are allowed after --')
  }
  if (args['--archive'] && (type || scope !== 'desktop' || suite !== 'updater')) invalid('--archive only applies to the Desktop updater suite')
  if (scope === 'desktop' && suite === 'updater' && !args['--archive']) invalid('Updater testing requires --archive <reviewed Go archive>')
  if (type === 'api' || type === 'visual') unsupported(`${type}/${scope} is planned, not an executable collection`)
  if (scope === 'desktop') {
    if (type === 'e2e' && suite === 'smoke') {
      if (separator >= 0 || Object.keys(args).some(key => !['positional', '--scope', '--suite'].includes(key)) || args.positional.length) {
        invalid('The registered Desktop smoke suite does not accept selection overrides')
      }
      return task('ci test e2e --scope desktop', [workspace('desktopSmoke')], { contexts: ['ci'] })
    }
    if (!type && suite === 'updater' && !args['--coverage'] && !args['--list'] && !args['--with-format-check'] && !args['--ui']) return task('ci test --scope desktop', [node('scripts/cd/updater.cjs', args['--archive'] ? ['--archive', args['--archive']] : [])])
    if (!type && !suite && !args['--list'] && !args['--with-format-check'] && !args['--ui']) return task('ci test --scope desktop', [desktop(args['--coverage'] ? 'test:coverage' : 'test')], { contexts: args['--coverage'] ? ['local', 'ci'] : ['local'] })
    if (args['--coverage'] || args['--list'] || args['--with-format-check'] || args['--ui']) unsupported('Unsupported Desktop test options')
    if (type === 'unit' && suite === 'literature-search') return task('ci test unit --scope desktop', [desktop('test:literature-search')])
    if (type === 'unit' && suite === 'native') return task('ci test unit --scope desktop', [desktop('test:native')])
    if (type === 'integration' && suite === 'native-contract') return task('ci test integration --scope desktop', [desktop('native:contract')])
    if (type === 'integration' && ['preview-contract', 'preview-ui'].includes(suite)) return task('ci test integration --scope desktop', [desktop(suite === 'preview-ui' ? 'test:preview:ui' : 'test:preview')])
    if (type === 'e2e' && suite === 'model-probe') return task('ci test e2e --scope desktop', [workspace('runBinary', ['scholarseed-desktop', ['--say', '请只回复 HEALTH_OK']])])
    if (type === 'e2e' && (!suite || ['mr', 'live', 'update'].includes(suite))) return task('ci test e2e --scope desktop', [desktop(suite ? `test:e2e:${suite}` : 'test:e2e', native)])
  }
  if (scope === 'tooling' && !args['--coverage'] && !args['--list'] && !args['--with-format-check'] && !args['--ui'] && ['debug', 'i18n'].includes(suite)) {
    if (suite === 'debug' && !type) return task('ci test --scope tooling', [node('scripts/dev/__tests__/desktop.test.cjs', ['scripts/pre/__tests__/toolchain-install.test.cjs'], { test: true })])
    if (suite === 'i18n' && (!type || type === 'integration')) return task('ci test integration --scope tooling', [desktop('i18n:test')], { contexts: ['local', 'ci'] })
  }
  if (scope === 'trace' && !type && !suite && !args['--coverage'] && !args['--list'] && !args['--ui']) {
    return task('ci test --scope trace', [...(args['--with-format-check'] ? [node('scripts/ci/format.cjs', ['--check'])] : []), workspace('damoatraceContract')])
  }
  if (scope === 'serve' && !type && !args['--coverage'] && !args['--with-format-check'] && !args['--ui']) {
    if (args['--list'] && suite) invalid('--list cannot select a suite')
    return task('ci test --scope serve', [workspace('serveTests', [args['--list'] ? ['--list'] : suite ? ['--only-suite', suite] : []])])
  }
  if (type === 'integration' && scope === 'serve' && suite === 'gitlab-contract') {
    if (separator >= 0 || Object.keys(args).some(key => !['positional', '--scope', '--suite'].includes(key)) || args.positional.length) {
      invalid('The registered Serve contract suite does not accept selection overrides')
    }
    return task('ci test integration --scope serve', [workspace('serveContracts')], { contexts: ['ci'] })
  }
  unsupported('No exact test type/scope/suite recipe is registered; use a documented mixed collection or suite')
}

function cd(argv) {
  if (!argv.length) argv = ['build', 'local']
  if (argv[0] !== 'build') invalid('Use cd build local|release')
  if (argv.length === 1) return { help: true, command: 'cd build' }
  const kind = choice(argv[1], ['local', 'release'], 'build kind')
  const args = options(argv.slice(2), { '--target': String, '--stage': String, '--workflow': String, '--channel': String,
    '--candidate': Boolean, ...Object.fromEntries(BUILD_VALUES.map(key => [key, String])) })
  const target = choice(args['--target'] || 'desktop', ['desktop', 'web', 'backend', 'wheels', 'trace', 'skills'], '--target')
  const stage = args['--stage'] || 'installer'
  const workflow = args['--workflow'] || 'direct'
  if (target !== 'desktop') {
    if (kind !== 'local' || Object.keys(args).some(key => !['positional', '--target'].includes(key))) unsupported('Only direct local target builds are supported')
    const steps = { web: desktop('build:web'), backend: desktop('bundle:backend'), wheels: workspace('dependencyWheels'), trace: workspace('damoatraceWheel'), skills: workspace('skillsInstall') }
    return task(`cd build local --target ${target}`, [steps[target]], { contexts: ['skills', 'wheels'].includes(target) ? ['local', 'ci'] : ['local'] })
  }
  choice(stage, kind === 'local' ? ['app', 'dir', 'installer'] : ['dir', 'installer'], '--stage')
  choice(workflow, kind === 'local' ? ['direct', 'package-acceptance'] : ['direct', 'distribution'], '--workflow')
  if (kind === 'local' && (args['--channel'] || args['--candidate'])) unsupported('Local builds do not have release channels or candidates')
  if (args['--platform']) {
    choice(args['--platform'], ['darwin', 'win32'], '--platform')
    if (args['--platform'] !== process.platform) unsupported('Native Desktop packaging requires its actual target host')
  }
  if (args['--arch']) choice(args['--arch'], ['arm64', 'x86_64'], '--arch')
  if (args['--version'] && !/^\d+\.\d+\.\d+$/.test(args['--version'])) invalid('--version must be x.y.z')
  if (args['--build-number'] && !/^\d{12}$/.test(args['--build-number'])) invalid('--build-number requires YYYYMMDDHHMM')
  if (kind === 'local' && ['--team-id', '--windows-publisher', '--update-base-url'].some(key => args[key])) unsupported('Local builds do not accept distribution signing or update configuration')
  const forwarded = BUILD_VALUES.flatMap(key => args[key] ? [key, args[key]] : [])
  if (workflow === 'package-acceptance') unsupported('Package acceptance belongs to the private development repository')
  if (workflow === 'package-acceptance') {
    if (stage !== 'installer' || BUILD_VALUES.some(key => key !== '--result' && args[key])) unsupported('Package acceptance requires the unchanged host installer recipe')
    return task('cd build local', [node('scripts/cd/package.cjs', args['--result'] ? ['--result', args['--result']] : [])])
  }
  if (kind === 'local') {
    if (stage === 'app' && forwarded.length) unsupported('Application-only compilation does not accept installer options')
    return task('cd build local', [desktop(stage === 'app' ? 'build' : stage === 'dir' ? 'package:dir' : 'package', forwarded)], { contexts: stage === 'app' ? ['local', 'ci'] : ['local'] })
  }
  const channel = choice(args['--channel'] || 'release', ['preview', 'release'], '--channel')
  const channelArgs = channel === 'preview' ? ['--channel', channel] : []
  if (args['--candidate']) {
    if (stage !== 'dir' || workflow !== 'direct') unsupported('Candidates require direct release directory checking')
    return task('cd build release', [desktop('package:check', [...forwarded, ...channelArgs])])
  }
  if (workflow === 'distribution' && stage !== 'installer') unsupported('Distribution only has an installer workflow')
  const releaseArgs = [...forwarded, ...(stage === 'dir' ? ['--stage', 'dir'] : []), ...channelArgs]
  return task('cd build release', workflow === 'distribution' ? [node('scripts/cd/distribution.cjs', releaseArgs)] : [desktop('package:distribution', releaseArgs)])
}

function resolveCommand(argv) {
  const [domain, ...rest] = argv
  if (domain === 'pre') return pre(rest)
  if (domain === 'dev') return dev(rest)
  if (domain === 'cd') return cd(rest)
  if (domain === 'ci') {
    if (!rest.length) return task('ci', [node('scripts/ci/smoke.cjs')])
    if (rest[0] === 'check') return check(rest.slice(1))
    if (rest[0] === 'test') return tests(rest.slice(1))
    if (rest[0] === 'format') {
      const args = options(rest.slice(1), { '--check': Boolean, '--write': Boolean }, true)
      if (args['--check'] && args['--write']) invalid('--check and --write are mutually exclusive')
      return task('ci format', [node('scripts/ci/format.cjs', [...(args['--write'] ? [] : ['--check']), ...args.positional])], { contexts: ['local', 'ci'] })
    }
  }
  invalid('Unknown command; use pnpm ops help')
}

module.exports = { COMMANDS, PREPARATION_PROFILE, resolveCommand, options, invalid, unsupported }
