const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { npmCommand } = require('../../pre/toolchain.cjs')
const { main } = require('../distribution.cjs')
const workspace = require('../../../package.json')
const { resolveCommand } = require('../../shared/commands.cjs')
const desktop = require('../../../apps/desktop/package.json')
const ROOT = path.resolve(sourceDirectory, '../..')
const STAGES = [['pre/toolchain', 'ensure'], ['shared/python', 'prepare-dev'], ['ci/smoke'], ['shared/desktop', 'package:distribution']]

test('both package roots use the dependency and smoke gated entry', () => {
  assert.equal(workspace.scripts.ops, 'node scripts/ops-cli.cjs')
  assert.equal(workspace.scripts['package:dist'], 'node scripts/desktop.cjs package:dist')
  assert.deepEqual(resolveCommand(['cd', 'build', 'release', '--workflow', 'distribution']).steps,
    [{ kind: 'node', file: 'scripts/cd/distribution.cjs', args: [] }])
  assert.equal(desktop.scripts['package:dist'], 'node ../../scripts/cd/distribution.cjs')
})

test('every failed preparation, smoke or build stops the pipeline and preserves exit status', () => {
  const forwarded = ['--channel', 'preview', '--result', 'a path & 中文.json']
  for (const failure of [-1, 0, 1, 2, 3]) {
    for (const status of [7, null]) {
      const calls = []
      const result = main(forwarded, { launch: (exe, args, options) => {
        const index = calls.length
        calls.push(args)
        assert.equal(exe, process.execPath)
        assert.equal(options.shell, false)
        assert.equal(options.cwd, ROOT)
        return { status: index === failure ? status : 0 }
      } })
      assert.equal(result, failure < 0 ? 0 : status ?? 1)
      assert.equal(calls.length, failure < 0 ? 4 : failure + 1)
      calls.forEach((args, index) => assert.deepEqual(args, [path.join(ROOT, 'scripts', `${STAGES[index][0]}.cjs`), ...STAGES[index].slice(1), ...(index === 3 ? forwarded : [])]))
    }
  }
  assert.throws(() => main([], { launch: () => ({ error: new Error('spawn failed') }) }), /spawn failed/)
})

test('real npm entry preserves argv and stops after any failed child process', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'distribution-gate-'))
  const capture = path.join(directory, 'calls.jsonl')
  // This contract executes npm even when the containing test was launched by pnpm.
  const npm = npmCommand({ ...process.env, npm_execpath: undefined })
  const forwarded = ['--channel', 'preview', '--result', path.join(directory, 'result & 中文.json')]
  try {
    fs.mkdirSync(path.join(directory, 'scripts/ci'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'scripts/cd'), { recursive: true })
    fs.mkdirSync(path.join(directory, 'apps/desktop'), { recursive: true })
    fs.copyFileSync(path.join(sourceDirectory, 'distribution.cjs'), path.join(directory, 'scripts/cd/distribution.cjs'))
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { 'package:dist': 'node scripts/cd/distribution.cjs' } }))
    fs.writeFileSync(path.join(directory, 'apps/desktop/package.json'), JSON.stringify({ scripts: { 'package:dist': desktop.scripts['package:dist'] } }))
    for (const file of ['pre/toolchain', 'shared/python', 'shared/desktop', 'ci/smoke']) {
      fs.mkdirSync(path.dirname(path.join(directory, `scripts/${file}.cjs`)), { recursive: true })
      fs.writeFileSync(path.join(directory, `scripts/${file}.cjs`), `const fs=require('node:fs'); const args=process.argv.slice(2);\n` +
        `fs.appendFileSync(process.env.GATE_CAPTURE, JSON.stringify({file:'${file}',args})+'\\n');\n` +
        `process.exitCode=(args[0] || '${file}')===process.env.FAIL_STAGE?7:0;\n`)
    }
    for (const prefix of [[], ['--prefix', 'apps/desktop']]) {
      for (const failure of [-1, 0, 1, 2, 3]) {
        fs.writeFileSync(capture, '')
        const result = spawnSync(npm.executable, [...npm.args, ...prefix, 'run', 'package:dist', '--', ...forwarded], {
          cwd: directory, encoding: 'utf8', timeout: 30000,
          env: { ...process.env, GATE_CAPTURE: capture, FAIL_STAGE: failure < 0 ? '' : (STAGES[failure][1] || STAGES[failure][0]) }, shell: false, windowsHide: true
        })
        assert.equal(result.status === 0, failure < 0, result.stderr)
        const calls = fs.readFileSync(capture, 'utf8').trim().split('\n').map(JSON.parse)
        assert.equal(calls.length, failure < 0 ? 4 : failure + 1)
        calls.forEach((call, index) => assert.deepEqual(call, { file: STAGES[index][0], args: [...STAGES[index].slice(1), ...(index === 3 ? forwarded : [])] }))
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
