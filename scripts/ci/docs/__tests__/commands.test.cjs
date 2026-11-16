const sourceDirectory = require('node:path').dirname(__dirname)
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const { spawnSync } = childProcess
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const leases = require('../../../shared/lease.cjs')
const { acquire } = leases
const { protectWindowsDirectory } = require('../../../shared/permissions.cjs')
const toolchain = require('../../../pre/toolchain.cjs')

const REPO = path.resolve(sourceDirectory, '../../..')
const LIMIT = 125000
function files(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).sort((first, second) => first.name.localeCompare(second.name)).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return files(filename)
    const content = entry.isSymbolicLink() ? fs.readlinkSync(filename) : fs.readFileSync(filename)
    return [[filename, createHash('sha256').update(content).digest('hex')]]
  })
}
function run(args, cwd = REPO, environment = process.env) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: LIMIT, env: environment })
}
function npm(args) {
  const environment = { ...process.env, npm_execpath: undefined, npm_config_user_agent: undefined }
  const command = toolchain.npmCommand(environment)
  return run([...command.args, 'run', 'ops', '--', ...args], REPO, environment)
}
test('real workspace and npm command share complete scope from external cwd', context => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-command-'))
  context.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    assert.equal(fs.existsSync(cwd), false)
  })
  const direct = run([path.join(REPO, 'scripts/ops-cli.cjs'), 'ci', 'check', 'docs', 'workspace', '--strict'], cwd)
  assert.ok(direct.stdout.startsWith('{'), direct.stderr)
  const actual = npm(['ci', 'check', 'docs', 'workspace', '--strict'])
  assert.ok(actual.stdout.includes('{'), actual.stderr)
  const receipt = JSON.parse(actual.stdout.slice(actual.stdout.indexOf('{')))
  assert.deepEqual(receipt, JSON.parse(direct.stdout))
  assert.equal(actual.status, direct.status)
})
test('docs command does not modify repository assets', () => {
  const before = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO, encoding: 'utf8' }).stdout
  const assetsBefore = [files(path.join(REPO, 'wiki')), files(path.join(REPO, '.ai')), files(path.join(REPO, 'docs'))]
  const docs = run(['scripts/ops-cli.cjs', 'ci', 'check', 'docs', 'workspace'])
  assert.equal(docs.status, 0, docs.stderr)
  const after = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: REPO, encoding: 'utf8' }).stdout
  assert.equal(after, before)
  assert.deepEqual([files(path.join(REPO, 'wiki')), files(path.join(REPO, '.ai')), files(path.join(REPO, 'docs'))], assetsBefore)
})
test('controlled Node source cannot be overridden through workspace or npm', () => {
  for (const extra of [['--node-executable', process.execPath], [`--node-executable=${process.execPath}`]]) {
    const workspace = run(['scripts/ops-cli.cjs', 'ci', 'check', 'docs', 'workspace', ...extra])
    assert.notEqual(workspace.status, 0)
    assert.match(workspace.stderr, /Unknown option|may only be supplied once/)
    const rejected = npm(['ci', 'check', 'docs', 'workspace', ...extra])
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /Unknown option|may only be supplied once/)
  }
})
test('workspace and npm preserve repeated explicit record inputs and reject duplicates', context => {
  const recordsRoot = path.join(REPO, 'work-records')
  const existed = fs.existsSync(recordsRoot)
  fs.mkdirSync(recordsRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(recordsRoot, '.docs-command-'))
  const filename = path.join(directory, 'record.md')
  fs.writeFileSync(filename, '# Controlled command fixture\n', 'utf8')
  context.after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
    if (!existed && fs.readdirSync(recordsRoot).length === 0) fs.rmdirSync(recordsRoot)
  })
  const record = path.relative(REPO, filename).split(path.sep).join('/')
  const before = files(path.join(REPO, 'work-records'))
  const direct = run(['scripts/ops-cli.cjs', 'ci', 'check', 'docs', 'workspace', '--record', record])
  const report = JSON.parse(direct.stdout)
  assert.deepEqual(report.records, [record])
  assert.ok(report.paths.includes(record))
  const recorded = npm(['ci', 'check', 'docs', 'workspace', '--record', record])
  assert.ok(recorded.stdout.includes('{'), recorded.stderr)
  assert.deepEqual(JSON.parse(recorded.stdout.slice(recorded.stdout.indexOf('{'))), report)
  assert.equal(recorded.status, direct.status)
  const duplicate = run(['scripts/ops-cli.cjs', 'ci', 'check', 'docs', 'workspace', '--record', record, '--record', record])
  assert.notEqual(duplicate.status, 0)
  assert.ok(JSON.parse(duplicate.stdout).errors.some(error => error.includes('duplicate explicit record')))
  const invalid = run(['scripts/ops-cli.cjs', 'ci', 'check', 'docs', 'workspace', '--record', 'docs/index.md'])
  assert.notEqual(invalid.status, 0)
  assert.deepEqual(files(path.join(REPO, 'work-records')), before)
})

function leaseFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-lease 中文 '))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'registry')
  fs.mkdirSync(directory, { mode: 0o700 })
  if (process.platform === 'win32') protectWindowsDirectory(directory)
  return { directory, resource: path.join(root, 'environment') }
}

function writer(state) {
  return acquire({ mode: 'write', resources: [state.resource], directory: state.directory })
}

test('workspace docs check holds a Python reader lease until the checker exits', context => {
  const state = leaseFixture(context)
  const environment = { VENV: state.resource }
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  context.mock.method(toolchain, 'checkNode', () => {})
  context.mock.method(childProcess, 'spawnSync', () => {
    assert.throws(() => writer(state), { code: 'LEASE_CONFLICT' })
    return { status: 0 }
  })
  // Reload after mocks: workspace captures spawnSync and checkNode on import.
  delete require.cache[require.resolve('../../../shared/workspace.cjs')]
  const workspace = require('../../../shared/workspace.cjs').createWorkspace(REPO, environment)
  assert.equal(workspace.docsCheck([]), 0)
  writer(state).release()
})

test('workspace docs check releases its reader after a nonzero checker exit', context => {
  const state = leaseFixture(context)
  const environment = { VENV: state.resource }
  context.mock.method(leases, 'acquire', options => acquire({ ...options, directory: state.directory }))
  context.mock.method(toolchain, 'checkNode', () => {})
  context.mock.method(childProcess, 'spawnSync', () => ({ status: 7 }))
  // Reload after mocks: workspace captures spawnSync and checkNode on import.
  delete require.cache[require.resolve('../../../shared/workspace.cjs')]
  const workspace = require('../../../shared/workspace.cjs').createWorkspace(REPO, environment)
  assert.throws(() => workspace.docsCheck([]), error => error.code === 'CHILD_EXIT' && error.exitCode === 7)
  writer(state).release()
})
