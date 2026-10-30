const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const child = require('node:child_process')
const python = require('../python.cjs')

const REPO = path.resolve(__dirname, '../../..')

test('CI interpreter resolves the explicitly prepared environment through uv', () => {
  const executable = python.ciPython(REPO)
  const actual = python.inspectPython(executable)
  assert.equal(python.sameRealPath(actual.prefix, path.join(REPO, '.venv')), true)
  assert.notEqual(actual.prefix, actual.base_prefix)
})

test('CI interpreter rejects missing environments without falling back to system Python', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-interpreter-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => python.ciPython(directory), /virtual environment|ENOENT/)
})

test('CI interpreter rejects a project Python requirement incompatible with the prepared environment', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-python-requirement-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'pyproject.toml'), '[project]\nname="fixture"\nversion="0.0.0"\nrequires-python=">=99"\n')
  fs.symlinkSync(path.join(REPO, '.venv'), path.join(directory, '.venv'), 'junction')
  assert.throws(() => python.ciPython(directory), /does not satisfy|Command failed|compatible/)
})

test('formatter passes explicit CI context to its interpreter owner', context => {
  const calls = []
  context.mock.method(python, 'developmentPython', (...args) => { calls.push(args); return '/fixture/python' })
  context.mock.method(child, 'spawnSync', () => ({ status: 0 }))
  delete require.cache[require.resolve('../../ci/format.cjs')]
  const { format } = require('../../ci/format.cjs')
  assert.equal(format(REPO, ['--check', 'scripts'], {}, { context: 'ci' }), 0)
  assert.equal(calls[0][2].context, 'ci')
})
