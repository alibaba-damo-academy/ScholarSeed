const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const child = require('node:child_process')
const manifest = require('../../../apps/desktop/updater/toolchain.json')

test('one build prepares Go and runs gates once; new builds run gates again; failed gates cannot be reused', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'go-session-test-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const entry = manifest.archives.find(e => e.os === platform && e.arch === arch)
  const saved = { ...entry }
  t.after(() => Object.assign(entry, saved))
  const archive = path.join(directory, 'fixture.archive')
  fs.writeFileSync(archive, 'fixture')
  entry.size = 7
  entry.sha256 = crypto.createHash('sha256').update('fixture').digest('hex')
  const counts = { extract: 0, vet: 0, test: 0 }
  let fail = false
  const environments = []
  t.mock.method(child, 'spawnSync', (executable, args, options) => {
    if (args[0] === '-xf') {
      counts.extract++
      const go = path.join(args[3], 'go')
      fs.mkdirSync(path.join(go, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(go, 'LICENSE'), 'fixture license')
    } else if (args[0] === 'version') {
      return { status: 0, stdout: `go version ${manifest.version} ${platform}/${arch}` }
    } else if (args[0] === 'vet') counts.vet++
    else if (args[0] === 'test') {
      counts.test++
      environments.push(options.env)
      assert.ok(args.includes('-count=1'))
      if (fail) return { status: 1, stderr: 'fixture failure' }
    }
    return { status: 0, stdout: '' }
  })
  delete require.cache[require.resolve('../updater.cjs')]
  const { main, createSession, closeSession } = require('../updater.cjs')
  const cache = path.join(directory, 'persistent')
  const environment = { ...process.env, SCHOLARSEED_BUILD_CACHE_ROOT: cache, GOCACHE: 'foreign', GOPROXY: 'foreign' }
  const session = createSession(false)
  t.after(() => closeSession(session))
  await main(['--archive', archive], session, environment)
  const prepared = session.temporary
  await main(['--archive', archive], session, environment)
  assert.deepEqual(counts, { extract: 1, vet: 1, test: 1 })
  await assert.rejects(main(['--archive', path.join(directory, 'other')], session, environment), /input changed/)
  closeSession(session)
  assert.equal(fs.existsSync(prepared), false)
  assert.equal(fs.existsSync(environments[0].GOCACHE), true)
  assert.equal(environments[0].GOPROXY, 'off')
  assert.ok(environments[0].GOCACHE.startsWith(cache))
  fail = true
  await assert.rejects(main(['--archive', archive], session, environment), /fixture failure/)
  assert.equal(session.ready, false)
  assert.equal(session.temporary, undefined)
  fail = false
  await main(['--archive', archive], session, environment)
  assert.deepEqual(counts, { extract: 3, vet: 3, test: 3 })
  assert.equal(environments[0].GOCACHE, environments[2].GOCACHE)
  const temporary = session.temporary
  const originalRemove = fs.rmSync
  const removal = t.mock.method(fs, 'rmSync', (filename, ...options) => {
    if (filename === temporary) throw new Error('fixture cleanup failure')
    return originalRemove(filename, ...options)
  })
  assert.throws(() => closeSession(session), /fixture cleanup failure/)
  assert.equal(session.ready, false)
  assert.equal(session.temporary, temporary)
  removal.mock.restore()
  closeSession(session)
  fs.writeFileSync(archive, 'changed')
  await assert.rejects(main(['--archive', archive], session, environment), /SHA256 mismatch/)
  assert.equal(session.ready, false)
  assert.deepEqual(counts, { extract: 3, vet: 3, test: 3 })
})
