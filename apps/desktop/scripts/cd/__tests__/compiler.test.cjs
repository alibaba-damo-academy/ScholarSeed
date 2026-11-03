const sourceDirectory = require('node:path').dirname(__dirname)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { runInNewContext } = require('node:vm')
const source = fs.readFileSync(path.join(sourceDirectory, 'compiler.cjs'), 'utf8')

// Stub SDK acquisition/commands only: lifecycle tests operate on real directories.
function fixture(t, {failures = [], platform = 'win32', realDelay = false} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-test-'))
  t.after(() => fs.rmSync(directory, {recursive: true, force: true, maxRetries: 6, retryDelay: 200}))
  const archive = path.join(directory, 'sdk.zip')
  fs.writeFileSync(archive, 'reviewed test SDK')
  const selected = {os: 'windows', arch: 'amd64', size: fs.statSync(archive).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}
  const calls = {removals: 0, delays: []}
  const module = {exports: {}}
  runInNewContext(source, {module, process: {platform, arch: 'x64'}, AggregateError, require(name) {
    if (name === 'node:fs') return {...fs, promises: {...fs.promises, async rm(...args) {
      const failure = failures[calls.removals++]
      if (failure) throw failure
      return fs.promises.rm(...args)
    }}}
    if (name === 'node:timers/promises') return {async setTimeout(ms) {
      calls.delays.push(ms)
      if (realDelay) await delay(ms)
    }}
    if (name === 'node:child_process') return {spawnSync: () => ({status: 0, stdout: 'go version fixture windows/amd64'})}
    if (name === '../../../../scripts/shared/artifacts.cjs') return {ensureArtifact: () => assert.fail('unexpected download')}
    if (name === './cache.cjs') return {expanded: () => directory, goObjects: () => directory}
    if (name === '../../updater/toolchain.json') return {version: 'fixture', archives: [selected]}
    return require(name)
  }})
  return {directory, calls, archive, session: operation => module.exports.withCompiler(
    {runDirectory: directory, goArchive: archive, environment: {}}, operation)}
}
const failure = code => Object.assign(new Error(`filesystem ${code}`), {code})

test('compiler session awaits operation and removes its private directory before returning', async t => {
  const f = fixture(t)
  let temporary
  assert.equal(await f.session(async session => {
    temporary = session.temporary
    await delay(1)
    fs.writeFileSync(path.join(temporary, 'output.exe'), 'output')
    return 'built'
  }), 'built')
  assert.equal(fs.existsSync(temporary), false)
  assert.equal(fs.existsSync(f.archive), true)
  assert.deepEqual(f.calls, {removals: 1, delays: []})
})
for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']) {
  test(`compiler cleanup retries transient ${code} without rerunning operation`, async t => {
    const f = fixture(t, {failures: [failure(code), failure(code)]})
    let operations = 0
    await f.session(() => { operations++ })
    assert.equal(operations, 1)
    assert.deepEqual(f.calls, {removals: 3, delays: [200, 400]})
  })
}
test('persistent cleanup denial fails with path, code and original filesystem cause', async t => {
  const denied = failure('EPERM')
  const f = fixture(t, {failures: Array(7).fill(denied)})
  await assert.rejects(f.session(() => 'built'), error => {
    assert.equal(error.cause, denied)
    assert.equal(error.code, 'EPERM')
    assert.match(error.message, /cleanup failed after 7 attempt\(s\).*native-build-/)
    assert.equal(fs.existsSync(error.path), true)
    return true
  })
  assert.deepEqual(f.calls, {removals: 7, delays: [200, 400, 600, 800, 1000, 1200]})
})
test('unexpected cleanup errors fail immediately', async t => {
  const f = fixture(t, {failures: [failure('EIO')]})
  await assert.rejects(f.session(() => {}), {code: 'EIO'})
  assert.deepEqual(f.calls, {removals: 1, delays: []})
})
test('cleanup recovery preserves the exact original operation exception', async t => {
  const f = fixture(t, {failures: [failure('EPERM')]})
  const original = new Error('policy rejected')
  await assert.rejects(f.session(() => {throw original}), error => error === original)
})
test('dual failure exposes both causes even in message-only build logs', async t => {
  const f = fixture(t, {failures: Array(7).fill(failure('EPERM'))})
  const original = new Error('policy rejected')
  await assert.rejects(f.session(() => {throw original}), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.cause, original)
    assert.equal(error.errors[0], original)
    assert.equal(error.errors[1].code, 'EPERM')
    assert.match(error.message, /policy rejected; native compiler cleanup failed/)
    return true
  })
})
test('macOS still refuses Windows compiler work before creating a directory', async t => {
  const f = fixture(t, {platform: 'darwin'})
  await assert.rejects(f.session(() => assert.fail('operation ran')), /requires Windows x64/)
  assert.deepEqual(fs.readdirSync(f.directory), ['sdk.zip'])
  assert.equal(f.calls.removals, 0)
})

async function lockFile(t, file) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '$f = [IO.File]::Open($env:COMPILER_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); try { [Console]::WriteLine("locked"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }'],
  {env: {...process.env, COMPILER_LOCK_FILE: file}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
  const closed = once(child, 'close')
  t.after(async () => {child.stdin.end('\n'); await closed})
  let output = ''
  const ready = (async () => {
    for await (const chunk of child.stdout) {
      output += chunk
      if (output.includes('locked')) return
    }
    throw new Error('lock holder exited before readiness')
  })()
  await ready
  return {release: () => child.stdin.end('\n'), closed}
}
for (const persistent of [false, true]) {
  test(`Windows real non-delete-sharing handle: ${persistent ? 'persistent lock fails' : 'released lock recovers'}`,
    {skip: process.platform !== 'win32', timeout: 20000}, async t => {
      const f = fixture(t, {realDelay: true})
      let temporary, holder, timer
      t.after(() => clearTimeout(timer))
      const operation = f.session(async session => {
        temporary = session.temporary
        const file = path.join(temporary, 'output.exe')
        fs.writeFileSync(file, 'locked output')
        holder = await lockFile(t, file)
        // Establish RED using the former one-shot deletion on the same live handle.
        assert.throws(() => fs.rmSync(temporary, {recursive: true, force: true}),
          error => ['EPERM', 'EACCES', 'EBUSY'].includes(error.code))
        if (!persistent) timer = setTimeout(holder.release, 500)
        return 'built'
      })
      if (persistent) {
        await assert.rejects(operation, /native compiler cleanup failed after 7 attempt/)
        assert.equal(fs.existsSync(temporary), true)
        holder.release()
        await holder.closed
        await fs.promises.rm(temporary, {recursive: true, force: true, maxRetries: 6, retryDelay: 200})
      } else {
        assert.equal(await operation, 'built')
        assert.equal(fs.existsSync(temporary), false)
        assert.ok(f.calls.removals > 1)
      }
    })
}
