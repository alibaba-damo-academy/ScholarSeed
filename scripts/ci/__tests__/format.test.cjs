const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const python = require('../../shared/python.cjs')
const leases = require('../../shared/lease.cjs')

function fixture(context, interpreter, acquire = () => ({ release() {} })) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'formatter-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  context.mock.method(python, 'developmentPython', () => interpreter)
  context.mock.method(leases, 'acquire', acquire)
  delete require.cache[require.resolve('../format.cjs')]
  return { repo, format: require('../format.cjs').format }
}
for (const interpreter of ['/temporary/bin/python', 'C:\\temporary\\Scripts\\python.exe']) {
  test(`formatter preserves interpreter and check argv: ${interpreter}`, context => {
    const { repo, format } = fixture(context, interpreter)
    const calls = []
    context.mock.method(child, 'spawnSync', (command, args, options) => { calls.push({ command, args, env: options.env }); return { status: 0 } })
    const target = 'source with spaces.py'
    assert.equal(format(repo, ['--check', target], {}), 0)
    assert.ok(calls.every(call => call.command === interpreter))
    assert.ok(calls.every(call => call.env.PYTHONDONTWRITEBYTECODE === '1'))
    assert.ok(calls.every(call => call.env.BLACK_CACHE_DIR))
    assert.equal(fs.existsSync(calls[0].env.BLACK_CACHE_DIR), false)
    assert.deepEqual(calls.map(call => call.args), [
      ['-m', 'isort', '--version'], ['-m', 'black', '--version'],
      ['-m', 'isort', '--check-only', '--diff', target],
      ['-m', 'black', '--check', '--diff', target],
      [path.join(repo, 'scripts/ci/imports.py'), target]
    ])
  })
}
test('missing formatter in check mode fails without installation or source writes', context => {
  const { repo, format } = fixture(context, '/missing/python')
  const calls = []
  context.mock.method(child, 'spawnSync', (command, args) => { calls.push(args); return { status: 1 } })
  assert.throws(() => format(repo, ['--check', 'target.py'], {}), /pnpm ops pre install python/)
  assert.equal(calls.some(args => args.includes('prepare-dev')), false)
})
test('explicit fmt prepares once when missing and propagates formatter failure', context => {
  const { repo, format } = fixture(context, '/temporary/python')
  const calls = []
  let prepared = false
  context.mock.method(child, 'spawnSync', (command, args) => {
    calls.push(args)
    if (args.includes('prepare-dev')) { prepared = true; return { status: 0 } }
    return { status: !prepared || (args.includes('isort') && !args.includes('--version')) ? 7 : 0 }
  })
  assert.equal(format(repo, ['target.py'], {}), 7)
  assert.equal(calls.filter(args => args.includes('prepare-dev')).length, 1)
  assert.equal(calls.some(args => args.includes('black') && !args.includes('--version')), false)
})

test('formatter holds the selected VENV read lease while probing and formatting', context => {
  const events = []
  const { repo, format } = fixture(context, '/temporary/python', options => {
    events.push(['acquire', options])
    return { release() { events.push(['release']) } }
  })
  context.mock.method(child, 'spawnSync', () => { events.push(['python']); return { status: 0 } })
  assert.equal(format(repo, ['--check', 'target.py'], { VENV: 'custom-env' }), 0)
  assert.deepEqual(events[0], ['acquire', { mode: 'read', resources: [path.join(repo, 'custom-env')] }])
  assert.equal(events.at(-1)[0], 'release')
  assert.ok(events.findIndex(event => event[0] === 'python') > 0)
})

test('formatter releases its reader before preparation and reacquires before using the environment', context => {
  const events = []
  const { repo, format } = fixture(context, '/temporary/python', options => {
    assert.equal(options.mode, 'read')
    events.push('acquire')
    return { release() { events.push('release') } }
  })
  let prepared = false
  context.mock.method(child, 'spawnSync', (_command, args) => {
    if (args.includes('prepare-dev')) {
      assert.equal(events.at(-1), 'release')
      prepared = true
      events.push('prepare')
      return { status: 0 }
    }
    if (args.at(-1) === '--version' && !prepared) return { status: 1 }
    events.push('python')
    return { status: 0 }
  })
  assert.equal(format(repo, ['target.py'], {}), 0)
  assert.deepEqual(events.filter(event => ['acquire', 'release', 'prepare'].includes(event)), [
    'acquire', 'release', 'prepare', 'acquire', 'release'
  ])
})
test('default paths preserve existing shell range and unknown options fail before processes', context => {
  const { repo, format } = fixture(context, '/temporary/python')
  fs.mkdirSync(path.join(repo, 'apps/serve/service'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'tests'))
  const calls = []
  context.mock.method(child, 'spawnSync', (command, args) => { calls.push(args); return { status: 0 } })
  assert.equal(format(repo, ['--check'], {}), 0)
  assert.deepEqual(calls[2].slice(4), ['apps/serve/service', 'tests'])
  assert.throws(() => format(repo, ['--unknown'], {}), /unknown option/)
  assert.equal(calls.length, 5)
})
test('formatter CLI preserves usage-error exit code', () => {
  const result = child.spawnSync(process.execPath, [path.join(sourceDirectory, 'format.cjs'), '--unknown'], {
    encoding: 'utf8'
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option/)
})
test('serve rejects failed, signalled and empty Codex lookup before launching watcher', async context => {
  for (const lookup of [{ status: 1, stdout: '' }, { status: null, signal: 'SIGTERM', stdout: '' },
    { status: 0, stdout: '' }, { status: 0, stdout: '  ' }, { error: new Error('lookup error'), stdout: '' }]) {
    let calls = 0
    const python = require('../../shared/python.cjs')
    context.mock.method(python, 'developmentPython', () => '/isolated-fixture/python')
    context.mock.method(python, 'verifyDevelopmentPython', () => { calls++; return {} })
    context.mock.method(child, 'spawnSync', () => { calls++; return lookup })
    delete require.cache[require.resolve('../../shared/workspace.cjs')]
    await assert.rejects(require('../../shared/workspace.cjs').createWorkspace().serve(true), /Codex/)
    assert.equal(calls, 2)
  }
})
