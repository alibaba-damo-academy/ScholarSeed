const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {build} = require('../../../package.json')
const {inventory, verifyImage} = require('../dmg.cjs')
const {developmentPython} = require('../../../../../scripts/shared/python.cjs')

for (const scenario of ['valid', 'missing', 'tampered', 'signature', 'detach', 'attach']) {
  test(`final DMG acceptance: ${scenario}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-contract-'))
    t.after(() => fs.rmSync(root, {recursive: true, force: true}))
    const source = path.join(root, 'ScholarSeed.app')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'framework'), 'signed binary')
    let mount
    let detach = 0
    let checks = 0
    const command = args => {
      if (args[0] === 'attach') {
        assert.ok(args.includes('-readonly'))
        mount = args[args.indexOf('-mountpoint') + 1]
        if (scenario === 'attach') throw new Error('attach failed')
        fs.cpSync(source, path.join(mount, 'ScholarSeed.app'), {recursive: true})
        const binary = path.join(mount, 'ScholarSeed.app/framework')
        if (scenario === 'missing') fs.unlinkSync(binary)
        if (scenario === 'tampered') fs.writeFileSync(binary, 'modified')
      } else {
        detach += 1
        if (scenario === 'detach') throw new Error('detach failed')
        fs.rmSync(path.join(mount, 'ScholarSeed.app'), {recursive: true})
      }
    }
    const verify = async application => {
      checks += 1
      assert.equal(application, path.join(mount, 'ScholarSeed.app'))
      if (scenario === 'signature') throw new Error('invalid seal')
      return {signature_valid: true, package_check: {ok: true}}
    }
    const action = verifyImage('image.dmg', source, {runDirectory: root}, verify, {command, verifyLayout() {}, mountUsers: () => ({output: 'scanner holds image'}), log() {}})
    if (scenario === 'valid') {
      const result = await action
      assert.equal(result.installed_check.detached, true)
      assert.deepEqual(result.installed_check.inventory, inventory(source))
    } else await assert.rejects(action)
    assert.equal(detach, scenario === 'attach' ? 0 : 1)
    assert.equal(checks, ['missing', 'tampered', 'attach'].includes(scenario) ? 0 : 1)
    assert.equal(fs.existsSync(mount), scenario === 'detach')
  })
}

test('DMG adapter checks copy, detach recovery and occupancy diagnostics', {skip: process.platform !== 'darwin'}, () => {
  const python = developmentPython(path.resolve(__dirname, '../../../../..'), process.env.VENV)
  execFileSync(python, ['-I', '-B', path.join(__dirname, 'image_test.py')], {stdio: 'pipe'})
})

// Exercise the actual macOS builder and mounted volume, including its Finder drop target.
test('configured DMG preserves a dense resource directory on read-only APFS', {skip: process.platform !== 'darwin'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-native-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const contents = path.join(root, 'contents')
  const source = path.join(contents, 'ScholarSeed.app')
  const resources = path.join('Contents', 'Resources', 'tfm', 'zhmetrics', 'unikai')
  const fonts = path.join(source, resources)
  fs.mkdirSync(fonts, {recursive: true})
  for (let i = 0; i < 512; i++) fs.writeFileSync(path.join(fonts, `font-${i}.tfm`), String(i))
  fs.writeFileSync(path.join(source, 'member'), 'fixture')
  const installer = path.join(root, 'fixture.dmg')
  const context = path.join(root, 'context.json')
  const settings = path.join(root, 'settings.json')
  const title = path.basename(root)
  fs.writeFileSync(context, JSON.stringify({runDirectory: root}))
  fs.writeFileSync(settings, JSON.stringify({...build.dmg, title, contents: build.dmg.contents.map(entry => ({...entry, path: entry.path ?? source}))}))
  const python = developmentPython(path.resolve(__dirname, '../../../../..'), process.env.VENV)
  execFileSync(python, ['-I', '-B', path.join(__dirname, '../image.py'), '-s', settings, title, installer], {
    env: {...process.env, SCHOLARSEED_BUILD_CONTEXT: context}, timeout: 120000,
  })
  let mountedPath
  const result = await verifyImage(installer, source, {runDirectory: root}, async application => {
    mountedPath = application
    assert.equal(fs.readFileSync(path.join(application, 'member'), 'utf8'), 'fixture')
    assert.equal(fs.readdirSync(path.join(application, resources)).length, 512)
    assert.throws(() => fs.writeFileSync(path.join(application, 'member'), 'mutation'), {code: 'EROFS'})
    return {signature_valid: true, package_check: {ok: true}}
  }, {log() {}})
  assert.equal(result.installed_check.detached, true)
  assert.deepEqual(result.installed_check.layout, {filesystem: 'apfs', read_only: true, applications_link: '/Applications'})
  assert.equal(fs.existsSync(mountedPath), false)
})

for (const [filesystem, target, expected] of [
  ['HFS+', '/Applications', /read-only APFS/],
  ['APFS', '/tmp', /Applications must link to/],
]) {
  test(`rejects a mounted ${filesystem} DMG with Applications pointing to ${target}`, {skip: process.platform !== 'darwin'}, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-layout-'))
    t.after(() => fs.rmSync(root, {recursive: true, force: true}))
    const contents = path.join(root, 'contents')
    const source = path.join(contents, 'ScholarSeed.app')
    fs.mkdirSync(source, {recursive: true})
    fs.symlinkSync(target, path.join(contents, 'Applications'))
    const installer = path.join(root, 'fixture.dmg')
    execFileSync('hdiutil', ['create', '-fs', filesystem, '-size', '64m', '-srcfolder', contents, '-format', 'UDZO', installer], {timeout: 120000})
    await assert.rejects(verifyImage(installer, source, {runDirectory: root}, async () => {
      assert.fail('invalid install layout reached application verification')
    }, {log() {}}), expected)
    assert.ok(fs.readdirSync(root).every(name => !name.startsWith('image-')))
  })
}

// A failed probe must retain its cause even when diagnostics or detach also fail.
test('DMG failure reports process state and busy-volume holders without forcing detach', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-diagnostic-'))
  t.after(() => fs.rmSync(root, {recursive: true, force: true}))
  const source = path.join(root, 'ScholarSeed.app')
  fs.mkdirSync(source)
  const events = []
  const probe = Object.assign(new Error('node timed out'), {code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', pid: 42})
  let mount
  await assert.rejects(verifyImage('image.dmg', source, {runDirectory: root}, async () => { throw probe }, {
    verifyLayout() {},
    command(args) {
      assert.ok(!args.includes('-force'))
      if (args[0] === 'attach') {
        mount = args[args.indexOf('-mountpoint') + 1]
        fs.cpSync(source, path.join(mount, 'ScholarSeed.app'), {recursive: true})
      } else throw new Error('resource busy')
    },
    mountUsers(directory) { assert.equal(directory, mount); return {output: 'CoreServicesUIAgent 123'} },
    log: event => events.push(event),
  }), error => error instanceof AggregateError && error.errors[0] === probe)
  assert.equal(events.find(event => event.stage === 'verification').pid, 42)
  assert.equal(events.find(event => event.stage === 'mount-users').output, 'CoreServicesUIAgent 123')
  assert.equal(fs.existsSync(mount), true)
})
