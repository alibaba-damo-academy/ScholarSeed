const sourceDirectory = require('node:path').dirname(__dirname)
// File-backed producer contracts only; these fixture apps are not executable.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { COMPONENT_ARCHIVE_ENTRIES } = require('../bundle.cjs')
const REPO = path.resolve(sourceDirectory, '../../../..')
const PYTHON = path.join(
  REPO,
  '.venv',
  ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])
)

test('payload writer preserves actual tree and rejects invalid file selections', () => {
  execFileSync(PYTHON, ['-I', '-B', path.join(__dirname, 'payload_test.py')], { timeout: 30000 })
})

test('Windows component entry matches the payload writer path format', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-component-entry-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'texlive')
  const executable = path.join(root, 'bin', 'windows', 'xelatex.exe')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, 'TeX Live fixture')
  const archive = path.join(directory, 'texlive.zip')

  assert.equal(COMPONENT_ARCHIVE_ENTRIES[1], 'bin/windows/xelatex.exe')
  execFileSync(PYTHON, ['-I', '-B', path.join(sourceDirectory, 'payload.py'),
    '--root', root, '--output', archive, '--entry', COMPONENT_ARCHIVE_ENTRIES[1],
    '--prefix', 'texlive', '--reproducible'])
  const members = JSON.parse(execFileSync(PYTHON, ['-I', '-B', '-c',
    'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', archive]))
  assert(members.includes('texlive/bin/windows/xelatex.exe'))
})


test('payload writer reads deep files without host long-path policy and retains relative ZIP names', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-deep-payload-')))
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}))
  const root = path.join(directory, 'tree')
  const member = `${'deep-directory/'.repeat(20)}payload.bin`
  const file = path.join(root, member)
  assert.ok(file.length > 260)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, 'deep payload bytes')
  const output = path.join(directory, 'archive.zip')
  execFileSync(PYTHON, ['-I', '-B', path.join(sourceDirectory, 'payload.py'),
    '--root', root, '--output', output, '--entry', member, '--reproducible'])
  const actual = JSON.parse(execFileSync(PYTHON, ['-I', '-B', '-c',
    'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode() for n in z.namelist() if not n.endswith("/")}))', output]))
  assert.deepEqual(actual, {[member]: 'deep payload bytes'})
})
