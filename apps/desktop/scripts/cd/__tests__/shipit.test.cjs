const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const { runInNewContext } = require('node:vm')
const { execFileSync, spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { validateTarget, verifyAdmission, command } = require('../shipit.cjs')

function fixtureModules(originalRequire, spawn, volumeCalls, faults = {}) {
  let mounted
  let attachedImage
  const imagePaths = () => attachedImage ? [__filename, attachedImage] : [__filename]
  return name => {
    if (name === 'node:child_process') return {
      spawnSync: spawn,
      execFileSync(executable, args, options) {
        if (executable === '/usr/bin/plutil') {
          if (process.platform === 'darwin') return execFileSync(executable, args, options)
          const key = args[1]
          const type = key === 'images' ? 'array' : 'string'
          assert.deepEqual(Array.from(args), ['-extract', key, 'raw', '-expect', type, '-n', '-'])
          return key === 'images' ? String(imagePaths().length) : imagePaths()[Number(key.split('.')[1])]
        }
        assert.equal(executable, '/usr/bin/hdiutil')
        volumeCalls.push(args)
        if (args[0] === 'create') fs.writeFileSync(args.at(-1), 'fixture')
        if (args[0] === 'info') {
          const images = imagePaths().map(name => {
            const escaped = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            return `<dict><key>image-path</key><string>${escaped}</string><key>image-alias</key><data>AQ==</data></dict>`
          })
          return `<plist version="1.0"><dict><key>images</key><array>${images.join('')}</array></dict></plist>`
        }
        if (args[0] === 'attach') {
          mounted = args[args.indexOf('-mountpoint') + 1]
          attachedImage = args.at(-1)
        }
        if (args[0] === 'detach') {
          assert.equal(args[1], mounted)
          if (faults.detach === 'busy') throw new Error('disk busy')
          mounted = undefined
          if (faults.detach === 'attached') {
            attachedImage = path.dirname(attachedImage) + '/./' + path.basename(attachedImage)
            throw new Error('disk still attached')
          }
          attachedImage = undefined
          if (faults.detach === 'detached') throw new Error('detach response timed out')
        }
      },
    }
    if (name === 'node:fs') return {
      ...fs,
      statSync(target, options) {
        const stat = fs.statSync(target, options)
        return target === mounted ? { dev: stat.dev + 1 } : stat
      },
      rmdirSync(target) {
        if (faults.mountRemoval && path.basename(target) === 'mount') throw new Error('could not remove mount directory')
        fs.rmdirSync(target)
      },
    }
    return originalRequire(name)
  }
}

test('volume cleanup preserves attached images and cleans independent paths after confirmed detachment', t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shipit-volume-errors-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = require.resolve('../shipit.cjs')
  for (const faults of [{ detach: 'busy' }, { detach: 'attached' }, { detach: 'detached' }, { mountRemoval: true }]) {
    const calls = []
    const withVolume = runInNewContext(fs.readFileSync(filename, 'utf8') + '\nwithPreparationVolume', {
      __dirname: path.dirname(filename), module: { exports: {} },
      require: fixtureModules(createRequire(filename), undefined, calls, faults),
    })
    let failure
    assert.throws(() => withVolume(directory, () => { throw new Error('contract failed') }), error => {
      failure = error
      return error.name === 'AggregateError' && error.errors[0].message === 'contract failed'
    })
    const image = calls[0].at(-1)
    const root = path.dirname(image)
    const mount = path.join(root, 'mount')
    if (faults.detach === 'busy' || faults.detach === 'attached') {
      assert.equal(fs.existsSync(image), true)
      assert.equal(fs.existsSync(mount), true)
      assert.ok(failure.message.includes(`Retained ${image}`))
    } else {
      assert.equal(fs.existsSync(image), false)
      assert.equal(fs.existsSync(root), !!faults.mountRemoval)
      assert.match(failure.message, /detach response timed out|could not remove mount directory/)
    }
  }
})

test('native command failures retain exit status even without stderr', (context) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shipit-exit-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(
    () => command(process.execPath, ['-e', 'process.exit(17)'], directory),
    /status=17 signal=null pid=[1-9][0-9]*/
  )
})

test(
  'native command failures retain POSIX termination signals without stderr',
  {
    skip: process.platform === 'win32' && 'POSIX signal receipt; Windows does not build ShipIt',
  },
  (context) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shipit-signal-'))
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    assert.throws(
      () => command(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], directory),
      /status=null signal="SIGTERM" pid=[1-9][0-9]*/
    )
  }
)

for (const name of ['preparation', 'admission', 'binding']) {
  test(`native ${name} failures record their exit receipt before rejecting without retry`, (context) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shipit-receipt-'))
    context.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const filename = require.resolve('../shipit.cjs')
    const originalRequire = createRequire(filename)
    const source = fs.readFileSync(filename, 'utf8')
    const failures = [
      { status: null, signal: 'SIGKILL', pid: 1234 },
      { status: 17, signal: null, pid: 1234 },
      {
        status: null,
        signal: 'SIGTERM',
        pid: 1234,
        error: Object.assign(new Error('fixture timed out'), { code: 'ETIMEDOUT' }),
      },
      {
        status: null,
        signal: null,
        pid: 0,
        error: Object.assign(new Error('fixture missing'), { code: 'ENOENT' }),
      },
    ]
    for (const [index, failure] of failures.entries()) {
      const directory = path.join(root, String(index))
      fs.mkdirSync(directory)
      let calls = 0
      const volumeCalls = []
      const loaded = { exports: {} }
      runInNewContext(source + '\nmodule.exports.verifyPreparation = verifyPreparation', {
        __dirname: path.dirname(filename),
        module: loaded,
        process,
        require: fixtureModules(originalRequire, () => {
          calls++
          return calls === 1
            ? { status: 0, signal: null, stdout: '', stderr: '' }
            : { ...failure, stdout: 'native detail', stderr: '' }
        }, volumeCalls),
      })
      assert.throws(
        () =>
          loaded.exports[`verify${name[0].toUpperCase()}${name.slice(1)}`](
            directory,
            directory,
            directory,
            directory
          ),
        new RegExp(`ShipIt ${name} contract failed: status=`)
      )
      assert.equal(calls, 2)
      assert.deepEqual(volumeCalls.map(args => args[0]), name === 'preparation' ? ['create', 'attach', 'detach'] : [])
      const receipt = JSON.parse(
        fs.readFileSync(path.join(directory, `${name}-test.result.json`), 'utf8')
      )
      assert.equal(receipt.schema, 1)
      assert.equal(receipt.status, failure.status)
      assert.equal(receipt.signal, failure.signal)
      assert.equal(receipt.pid, failure.pid > 0 ? failure.pid : null)
      assert.deepEqual(
        receipt.error,
        failure.error ? { code: failure.error.code, message: failure.error.message } : null
      )
      assert.equal(
        fs.readFileSync(path.join(directory, `${name}-test.log`), 'utf8'),
        'native detail'
      )
    }
  })
}

test('native spawn failure does not invent a child PID', (context) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shipit-missing-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  assert.throws(
    () => command(path.join(directory, 'missing-executable'), [], directory),
    /status=null signal=null pid=null error=ENOENT/
  )
})

test('ShipIt rejects another Electron release and unsupported platforms before compilation', () => {
  assert.throws(() => validateTarget('win32', 'x64', '44.3.0', '44.3.0'), /native macOS/)
  assert.throws(() => validateTarget('darwin', 'ia32', '44.3.0', '44.3.0'), /native macOS/)
  assert.throws(() => validateTarget('darwin', 'arm64', '44.2.0', '44.3.0'), /does not match/)
})

test('sealed installation distinguishes a missing launch record from cancellation and read failures', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shipit-launch-record-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = require.resolve('../shipit.cjs')
  const verify = runInNewContext(fs.readFileSync(filename, 'utf8') + '\nverifySealedLaunch', {
    __dirname: path.dirname(filename), require: createRequire(filename), module: { exports: {} },
  })
  const target = path.join(directory, 'Fixture.app')
  const receipt = path.join(directory, 'launches.jsonl')
  assert.throws(() => verify(directory, 'rebuild', target, 1), /sealed rebuild has no application launch record/)
  verify(directory, 'cancel', target, 1)
  fs.writeFileSync(receipt, JSON.stringify({ inode: 1, application: target, pid: 2, version: '1.0' }))
  verify(directory, 'rebuild', target, 1)
  assert.throws(() => verify(directory, 'cancel', target, 1), /without authorization/)
  fs.unlinkSync(receipt)
  fs.mkdirSync(receipt)
  assert.throws(() => verify(directory, 'rebuild', target, 1), { code: 'EISDIR' })
})

test('native contract registry selects each dependency without changing execution budgets', (context) => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shipit-registry-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = require.resolve('../shipit.cjs')
  const originalRequire = createRequire(filename)
  const calls = []
  const volumeCalls = []
  const loaded = { exports: {} }
  runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.verifyPreparation = verifyPreparation', {
    __dirname: path.dirname(filename), module: loaded, process,
    require: fixtureModules(originalRequire, (executable, args, options) => {
      calls.push({ executable, args, options })
      return { status: 0, signal: null, stdout: '', stderr: '', pid: 1234 }
    }, volumeCalls),
  })
  loaded.exports.verifyPreparation(directory)
  assert.equal(calls.length, 18)
  assert.deepEqual(volumeCalls.map(args => args[0]), ['create', 'attach', 'detach'])
  const preparation = calls.find(call => call.executable === path.join(directory, 'preparation-test'))
  const mount = volumeCalls[1][volumeCalls[1].indexOf('-mountpoint') + 1]
  assert.deepEqual(Array.from(preparation.args), [path.join(directory, 'preparation-fixture'), mount])
  assert.equal(fs.existsSync(path.dirname(mount)), false)
  const compilation = name => calls.find(call => call.args.includes(path.join(directory, `${name}-test`)))
  const succession = compilation('succession').args
  assert.ok(compilation('retirement'))
  assert.equal(succession[succession.indexOf('Security') - 1], '-framework')
  assert.ok(compilation('readonly').args.includes('-DCFPreferencesSetValue=SSReadOnlyPreferenceSet'))
  const parking = compilation('parking').args
  assert.ok(parking.includes('-Wno-deprecated-declarations'))
  assert.equal(parking[parking.indexOf('ServiceManagement') - 1], '-framework')
  for (const call of calls.filter(call => call.executable.endsWith('-test')))
    assert.equal(call.options.timeout, 60_000)
})

const build = process.env.SHIPIT_TEST_BUILD
const electron = process.env.SHIPIT_TEST_ELECTRON
const output = process.env.SHIPIT_TEST_OUTPUT
test('native admission waits for reentry, preserves its deadline, error and disposal', {
  skip: process.platform !== 'darwin' || !build || !electron || !output
    ? 'requires isolated native contract directories' : false,
}, () => {
  fs.mkdirSync(output, { recursive: true })
  verifyAdmission(output, path.join(electron, 'Electron.app', 'Contents', 'Frameworks'), path.join(build, 'headers'))
})
test('real ReactiveObjC timing preserves termination, disposal and per-subscription identity', {
  skip: process.platform !== 'darwin' || !build || !electron || !output
    ? 'requires native macOS and explicit SHIPIT_TEST_BUILD/ELECTRON/OUTPUT directories' : false,
}, () => {
  fs.mkdirSync(output, { recursive: true })
  const executable = path.join(output, 'timing-test')
  const frameworks = path.join(electron, 'Electron.app', 'Contents', 'Frameworks')
  const owner = path.resolve(__dirname, '../../../native/shipit')
  const compile = spawnSync('/usr/bin/xcrun', [
    'clang', '-fobjc-arc', '-fobjc-weak', '-Wno-deprecated-declarations',
    `-I${path.join(build, 'headers')}`, `-I${owner}`, `-F${frameworks}`,
    '-framework', 'Foundation', '-framework', 'ReactiveObjC', '-framework', 'AppKit',
    `-Wl,-rpath,${frameworks}`, '-o', executable, path.join(owner, 'timing.test.m'),
  ], { encoding: 'utf8', env: { ...process.env, TMPDIR: output } })
  assert.equal(compile.status, 0, compile.stderr)
  const run = spawnSync(executable, [], { encoding: 'utf8', env: { ...process.env, TMPDIR: output } })
  fs.writeFileSync(path.join(output, 'timing.log'), run.stderr)
  assert.equal(run.status, 0, run.stderr)
  const events = [...run.stderr.matchAll(/id=(\d+) stage=([\w-]+) event=(start|end)(?: result=(\w+))?/g)]
  const starts = events.filter(event => event[3] === 'start')
  const ends = events.filter(event => event[3] === 'end')
  assert.equal(starts.length, 7)
  assert.equal(ends.length, starts.length)
  assert.equal(new Set(starts.map(event => event[1])).size, starts.length)
  for (const start of starts) assert.equal(ends.filter(end => end[1] === start[1]).length, 1)
  assert.equal(ends.find(event => event[2] === 'error')[4], 'error')
  assert.equal(ends.find(event => event[2] === 'dispose')[4], 'disposed')
  assert.ok(run.stderr.indexOf('stage=terminal event=end') < run.stderr.indexOf('DOWNSTREAM_TERMINAL'))
  assert.ok(run.stderr.indexOf('stage=value event=end') < run.stderr.indexOf('DOWNSTREAM_NEXT'))
})
