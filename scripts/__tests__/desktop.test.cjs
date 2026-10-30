const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { npmCommand } = require('../pre/toolchain.cjs')

const ROOT = path.resolve(__dirname, '../..')
const manifest = require('../../package.json')

test('distribution retains the entry probe and three exact npm script contracts', () => {
  assert.ok(fs.statSync(path.join(ROOT, 'scripts/desktop.cjs')).isFile())
  for (const command of ['package:dist', 'package:check', 'package:verify']) {
    assert.equal(manifest.scripts[command], `node scripts/desktop.cjs ${command}`)
  }
})

test('legacy channel arguments map to canonical tasks without losing distribution inputs', () => {
  const { translate } = require('../desktop.cjs')
  const { resolveCommand } = require('../shared/commands.cjs')
  for (const command of ['package:dist', 'package:check']) {
    for (const channel of ['preview', 'release']) {
      const inputs = ['--result', 'output 中文/result.json', '--version', '0.3.0',
        '--activation-public-keys', 'keys with spaces.json', '--verification-root', 'C:/ssv',
        '--component-cache', 'C:/build cache/components', '--payload-private-key', 'private.pem',
        '--payload-key-id', 'reviewed-key', '--go-archive', 'go.zip']
      const translated = translate([command, '--type', channel, ...inputs])
      assert.equal(translated.includes('--type'), false)
      assert.deepEqual(translated.slice(-inputs.length), inputs)
      const step = resolveCommand(translated).steps[0]
      assert.equal(step.file || step.script, command === 'package:dist' ? 'scripts/cd/distribution.cjs' : 'package:check')
      if (channel === 'preview') assert.deepEqual(step.args.slice(-2), ['--channel', 'preview'])
    }
  }
})

test('compatibility dispatch preserves the canonical exit status and runs only once', async () => {
  const { main, translate } = require('../desktop.cjs')
  const supplied = ['package:dist', '--result', 'result.json']
  let calls = 0
  assert.equal(await main(supplied, async command => {
    calls += 1
    assert.deepEqual(command, translate(supplied))
    return 17
  }), 17)
  assert.equal(calls, 1)
})

test('the original omitted release type retains the default signed distribution recipe', () => {
  const { translate } = require('../desktop.cjs')
  const { resolveCommand } = require('../shared/commands.cjs')
  assert.deepEqual(resolveCommand(translate(['package:dist'])).steps,
    [{ kind: 'node', file: 'scripts/cd/distribution.cjs', args: [] }])
  assert.deepEqual(resolveCommand(translate(['package:check', '--type', 'release'])).steps,
    [{ kind: 'desktop', script: 'package:check', args: [] }])
})

test('unsupported skip and resume requests fail before any Owner is invoked', async () => {
  const { main } = require('../desktop.cjs')
  for (const supplied of [
    ['package:dist', '--skip-check'], ['package:check', '--skip-check'],
    ['package:verify', '--checkpoint', 'acceptance-ready.json']
  ]) {
    await assert.rejects(main(supplied, () => { assert.fail('Owner must not be invoked') }),
      error => error.code === 'UNSUPPORTED' && /skip-check|checkpoint|续跑/.test(error.message))
  }
})

test('invalid legacy parameters never fall back to an installer task', () => {
  const { translate } = require('../desktop.cjs')
  for (const supplied of [
    ['package:dist', '--type'], ['package:dist', '--type', 'dev'],
    ['package:dist', '--type', 'preview', '--channel', 'release'],
    ['package:dist', '--type', 'release', '--type', 'preview'],
    ['package:check', '--unknown'], ['package:verify'], ['unknown']
  ]) assert.throws(() => translate(supplied))
})

test('real npm and Node compatibility entries reject unsupported operations without building', () => {
  const node = spawnSync(process.execPath, ['scripts/desktop.cjs', 'package:dist', '--skip-check'],
    { cwd: ROOT, encoding: 'utf8', timeout: 10000 })
  assert.equal(node.status, 1)
  assert.match(node.stderr, /UNSUPPORTED.*skip-check/)
  const launcher = npmCommand({ ...process.env, npm_execpath: undefined })
  const npm = spawnSync(launcher.executable, [...launcher.args,
    'run', 'package:verify', '--', '--checkpoint', 'missing.json'],
  { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env, npm_config_offline: 'true' } })
  assert.equal(npm.status, 1)
  assert.match(npm.stderr, /UNSUPPORTED.*续跑/)
})
