const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { packageManagerCommand } = require('../../../../../scripts/pre/toolchain.cjs')
const desktop = require('../../../package.json')

const HOOKS = {
  preinstall: 'install',
  postinstall: 'install',
  predev: 'dev',
  'predev:web': 'dev:web',
  'predev:preview': 'dev:preview',
  'predev:pdfe': 'dev:pdfe',
  prepreview: 'preview',
  'prepreview:web': 'preview:web',
  preshoot: 'shoot',
  pretest: 'test',
  prebuild: 'build',
  'prebuild:web': 'build:web',
}
const MANAGERS = ['npm', 'pnpm']
const FAILURE_STATUS = 23
const INSTALL_FAILURE_STATUS = { npm: FAILURE_STATUS, pnpm: 1 }
const COMMAND_TIMEOUT_MS = 30_000
const FORWARDED_ARGS = ['--sentinel', 'value with spaces 中文']
const TRACE_FILE = 'trace.jsonl'
const FAILURE_ENV = 'OPS_LIFECYCLE_FAIL'

function fixture(context) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ops lifecycle 中文 ')))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const scripts = Object.fromEntries(
    Object.keys(desktop.scripts).map((name) => [name, `node lifecycle.cjs ${name}`])
  )
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'ops-lifecycle-fixture',
      version: '1.0.0',
      private: true,
      scripts,
    })
  )
  fs.writeFileSync(
    path.join(directory, 'lifecycle.cjs'),
    `
const fs = require('node:fs')
const path = require('node:path')
const event = process.argv[2]
fs.appendFileSync(path.join(__dirname, ${JSON.stringify(TRACE_FILE)}), JSON.stringify({
  event, args: process.argv.slice(3), cwd: process.cwd(), lifecycle: process.env.npm_lifecycle_event
}) + '\\n')
if (event === process.env.${FAILURE_ENV}) process.exitCode = ${FAILURE_STATUS}
`
  )
  return directory
}

function environment() {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:npm_|pnpm_|PNPM_|OPS_LIFECYCLE_FAIL)/.test(name)
    )
  )
  return {
    ...inherited,
    COREPACK_ENABLE_NETWORK: '0',
    PNPM_DISABLE_SELF_UPDATE_CHECK: '1',
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'false',
  }
}

function run(manager, directory, args, failure) {
  const env = { ...environment(), ...(failure ? { [FAILURE_ENV]: failure } : {}) }
  const command = packageManagerCommand(env, manager)
  const result = spawnSync(command.executable, [...command.args, ...args], {
    cwd: directory,
    env,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    shell: command.shell,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null, `${manager} terminated by ${result.signal}`)
  return result
}

function records(directory) {
  const filename = path.join(directory, TRACE_FILE)
  if (!fs.existsSync(filename)) return []
  const entries = fs
    .readFileSync(filename, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  fs.unlinkSync(filename)
  for (const entry of entries) {
    assert.equal(fs.realpathSync(entry.cwd), directory)
    assert.equal(entry.lifecycle, entry.event)
  }
  return entries
}

test('Desktop lifecycle names remain attached to their domain commands', () => {
  const actual = Object.keys(desktop.scripts).filter(
    (name) =>
      ['preinstall', 'postinstall'].includes(name) ||
      (name.startsWith('pre') && Object.hasOwn(desktop.scripts, name.slice(3))) ||
      (name.startsWith('post') && Object.hasOwn(desktop.scripts, name.slice(4)))
  )
  assert.deepEqual(actual.sort(), Object.keys(HOOKS).sort())
  for (const [hook, command] of Object.entries(HOOKS)) {
    assert.equal(typeof desktop.scripts[hook], 'string')
    assert.ok(desktop.scripts[hook].trim())
    if (command !== 'install') assert.equal(typeof desktop.scripts[command], 'string')
  }
})

for (const manager of MANAGERS) {
  test(`real ${manager} preserves lifecycle scheduling on a dependency-free fixture`, async (context) => {
    const directory = fixture(context)
    const version = run(manager, directory, ['--version'])
    assert.equal(version.status, 0, version.stderr)
    context.diagnostic(
      `${manager} ${version.stdout.trim()}; fixture scheduling only, not product build acceptance`
    )
    await context.test('first offline install hooks and preinstall failure', () => {
      const args =
        manager === 'npm'
          ? ['install', '--offline', '--package-lock=false', '--no-audit', '--no-fund']
          : ['install', '--offline']
      const success = run(manager, directory, args)
      assert.equal(success.status, 0, success.stdout + success.stderr)
      assert.deepEqual(
        records(directory).map((entry) => entry.event),
        ['preinstall', 'postinstall']
      )
      const unprepared = fixture(context)
      const failed = run(manager, unprepared, args, 'preinstall')
      assert.equal(failed.status, INSTALL_FAILURE_STATUS[manager], failed.stdout + failed.stderr)
      assert.deepEqual(
        records(unprepared).map((entry) => entry.event),
        ['preinstall']
      )
    })
    await context.test('coverage does not acquire the ordinary test prehook', () => {
      const args = ['run', 'test:coverage', ...(manager === 'npm' ? ['--'] : []), ...FORWARDED_ARGS]
      const result = run(manager, directory, args, 'pretest')
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.deepEqual(records(directory), [
        {
          event: 'test:coverage',
          args: FORWARDED_ARGS,
          cwd: directory,
          lifecycle: 'test:coverage',
        },
      ])
    })
    for (const [hook, command] of Object.entries(HOOKS).filter(
      ([, command]) => command !== 'install'
    )) {
      await context.test(command, () => {
        const args = ['run', command, ...(manager === 'npm' ? ['--'] : []), ...FORWARDED_ARGS]
        const success = run(manager, directory, args)
        assert.equal(success.status, 0, success.stdout + success.stderr)
        assert.deepEqual(records(directory), [
          { event: hook, args: [], cwd: directory, lifecycle: hook },
          { event: command, args: FORWARDED_ARGS, cwd: directory, lifecycle: command },
        ])
        const failed = run(manager, directory, args, hook)
        assert.equal(failed.status, FAILURE_STATUS, failed.stdout + failed.stderr)
        assert.deepEqual(
          records(directory).map((entry) => entry.event),
          [hook]
        )
      })
    }
  })
}
