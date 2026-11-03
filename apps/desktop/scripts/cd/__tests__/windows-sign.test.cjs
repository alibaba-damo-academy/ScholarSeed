const sourceDirectory = require('node:path').dirname(__dirname)
// Protocol fixtures exercise orchestration; they are not formal signing acceptance.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const source = fs.readFileSync(path.join(sourceDirectory, 'windows-sign.cjs'), 'utf8')

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-batch-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = (options.names || ['lease.node', 'fonts.node', 'velopack.node']).map(name => path.join(root, name))
  for (const file of files) fs.writeFileSync(file, `unsigned:${path.basename(file)}`)
  const env = Object.fromEntries(['CLIENT', 'SERVER', 'USER', 'KEY', 'DOMAIN', 'PUBLISHER']
    .map(name => [`SCHOLARSEED_WINDOWS_SIGN_${name}`, `fixture-${name}`]))
  const calls = { remote: 0, verified: [], temporary: null, submitted: [] }
  const module = { exports: {} }
  const execute = (executable, args, settings) => {
    if (executable === env.SCHOLARSEED_WINDOWS_SIGN_CLIENT) {
      calls.remote++
      calls.temporary = settings.cwd
      assert.equal(args[args.indexOf('-T') + 1], 'sha256s')
      assert.equal(args[args.indexOf('-d') + 1], 'payload')
      assert.equal(args[args.indexOf('-n') + 1], 'signed.zip')
      calls.submitted = fs.readdirSync(path.join(settings.cwd, 'payload')).sort()
      if (options.remoteFailure) return { status: 1 }
      fs.writeFileSync(path.join(settings.cwd, 'signed.zip'), 'fixture archive')
    } else if (args.at(-1).startsWith('Expand-Archive')) {
      assert.equal(fs.existsSync(path.join(calls.temporary, 'payload')), false)
      if (options.extractFailure) return { status: 1 }
      const output = path.join(settings.env.SCHOLARSEED_SIGN_OUTPUT, 'payload')
      fs.mkdirSync(output)
      for (const name of calls.submitted) {
        if (name !== options.missing) fs.writeFileSync(path.join(output, name), `signed:${name}`)
      }
      fs.writeFileSync(path.join(output, 'result.txt'), 'fixture service log')
      if (options.duplicate) {
        fs.mkdirSync(path.join(output, 'duplicate'))
        fs.writeFileSync(path.join(output, 'duplicate', options.duplicate.toUpperCase()), 'signed duplicate')
      }
    } else {
      assert.equal(executable, 'powershell.exe')
      const filename = settings.env.SCHOLARSEED_SIGNED_FILE
      calls.verified.push(filename)
      const original = files.includes(filename)
      if (original) {
        assert.equal(calls.verified.filter(file => !files.includes(file)).length, calls.submitted.length)
      } else {
        for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /^unsigned:/)
      }
      return { status: 0, stdout: JSON.stringify({
        Status: path.basename(filename) === options.invalid || (original && options.invalidCopy) ? 'HashMismatch' : 'Valid',
        Subject: options.publisherMismatch ? 'unexpected publisher' : env.SCHOLARSEED_WINDOWS_SIGN_PUBLISHER,
      }) }
    }
    return { status: 0, stdout: '' }
  }
  runInNewContext(source, { module, process: { env }, require(name) {
    if (name === 'node:child_process') return { spawnSync: execute }
    if (name === 'node:os') return { tmpdir: () => root }
    if (name === '../../../../scripts/shared/timing.cjs') return { timed: (_stage, fn) => fn(), timedAsync: (_stage, fn) => fn() }
    return require(name)
  } })
  return { ...module.exports, files, calls, root }
}

test('native batch sends one directory and verifies every result before any replacement', async t => {
  const f = fixture(t)
  await f.signFiles(f.files)
  assert.equal(f.calls.remote, 1)
  assert.deepEqual(f.calls.submitted, ['payload-0.node', 'payload-1.node', 'payload-2.node'])
  assert.equal(f.calls.verified.length, 6)
  for (const [index, file] of f.files.entries()) assert.equal(fs.readFileSync(file, 'utf8'), `signed:payload-${index}.node`)
  assert.equal(fs.existsSync(f.calls.temporary), false)
})

test('single-file callers retain one-file signing and verification', async t => {
  const f = fixture(t)
  await f.signFile(f.files[0])
  assert.equal(f.calls.remote, 1)
  assert.equal(f.calls.verified.length, 2)
  assert.equal(fs.readFileSync(f.files[1], 'utf8'), 'unsigned:fonts.node')
})

test('empty lists and case-insensitive basename collisions fail before remote signing', async t => {
  const f = fixture(t)
  for (const files of [[], null, [''], [f.files[0], path.join(f.root, 'other', 'LEASE.NODE')]])
    await assert.rejects(f.signFiles(files), /file list|unique executable names/)
  assert.equal(f.calls.remote, 0)
})

for (const [name, options, error] of [
  ['missing output', { missing: 'payload-2.node' }, /no matching executable/],
  ['ambiguous output', { duplicate: 'payload-1.node' }, /ambiguous executable/],
  ['invalid signature', { invalid: 'payload-2.node' }, /configured publisher/],
  ['wrong publisher', { publisherMismatch: true }, /configured publisher/],
  ['remote failure', { remoteFailure: true }, /command failed/],
  ['extraction failure', { extractFailure: true }, /command failed/],
]) {
  test(`${name} fails the complete batch before replacing any input and cleans staging`, async t => {
    const f = fixture(t, options)
    await assert.rejects(f.signFiles(f.files), error)
    for (const file of f.files) assert.match(fs.readFileSync(file, 'utf8'), /^unsigned:/)
    assert.equal(fs.existsSync(f.calls.temporary), false)
  })
}

test('copied signatures are verified again and failures remain fatal', async t => {
  const f = fixture(t, { invalidCopy: true })
  await assert.rejects(f.signFiles(f.files), /configured publisher/)
  assert.equal(f.calls.verified.length, 4)
  assert.equal(fs.existsSync(f.calls.temporary), false)
})

// The service's legacy filename decoding must never see localized basenames.
test('localized inputs use unique ASCII transport names and restore original paths', async t => {
  const f = fixture(t, { names: ['书深_ExecutionStub.exe', 'payload-0.exe', 'Å.node'] })
  await f.signFiles(f.files)
  assert.deepEqual(f.calls.submitted, ['payload-0.exe', 'payload-1.exe', 'payload-2.node'])
  for (const [index, file] of f.files.entries()) {
    assert.equal(fs.readFileSync(file, 'utf8'), `signed:payload-${index}${path.extname(file)}`)
    assert.ok(f.calls.verified.includes(file))
  }
  assert.equal(fs.existsSync(f.calls.temporary), false)
})
