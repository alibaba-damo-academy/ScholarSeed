const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { install, verify, EXECUTABLE, FRAMEWORK, EVIDENCE } = require('./artifact.cjs')
const { SHIPIT_OVERLAYS, SQUIRREL_OVERLAYS } = require('./overlays.cjs')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shipit-artifact-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const app = path.join(root, '应用.app')
  const target = path.join(app, EXECUTABLE)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.mkdir(path.join(app, 'Contents/Resources'), { recursive: true })
  await fs.writeFile(target, 'original')
  await fs.mkdir(path.dirname(path.join(app, FRAMEWORK)), { recursive: true })
  await fs.writeFile(path.join(app, FRAMEWORK), 'original framework')
  const executable = path.join(root, 'ShipIt')
  await fs.writeFile(executable, 'diagnostic', { mode: 0o755 })
  const license = path.join(root, 'Squirrel-LICENSE')
  await fs.writeFile(license, 'license')
  const frozen = { platform: 'darwin', arch: 'arm64', shipit: {
    schema: 1, electronVersion: '44.3.0', arch: 'arm64', executable,
    sha256: hash('diagnostic'), executableDigest: hash('diagnostic'),
    patchSha256: hash('patch'), headerSha256: hash('header'),
    sources: [{ name: 'Squirrel', commit: 'a'.repeat(40), sha256: hash('source') }],
    licenses: [{ path: license, sha256: hash('license') }],
    overlays: Object.fromEntries(SHIPIT_OVERLAYS.map(name => [name, hash(name)])),
  } }
  frozen.squirrel = { ...frozen.shipit, overlays: Object.fromEntries(SQUIRREL_OVERLAYS.map(name => [name, hash(name)])) }
  return { root, app, target, frozen }
}

test('stages exact executable, bounded evidence and licenses; catches post-pack mutation', async t => {
  const fx = await fixture(t)
  await install(fx.app, fx.frozen)
  await verify(fx.app, fx.frozen, false)
  const receipt = await fs.readFile(path.join(fx.app, EVIDENCE, 'build.json'), 'utf8')
  assert.ok(!receipt.includes(fx.root))
  await fs.writeFile(fx.target, 'changed')
  await assert.rejects(verify(fx.app, fx.frozen, false), /differs/)
  await assert.rejects(verify(fx.app, fx.frozen, true), /Mach-O/)
})

test('rejects changed input and architecture before replacing Electron helper', async t => {
  const fx = await fixture(t)
  fx.frozen.shipit.arch = 'x64'
  await assert.rejects(install(fx.app, fx.frozen), /evidence/)
  fx.frozen.shipit.arch = 'arm64'
  await fs.writeFile(fx.frozen.shipit.executable, 'changed')
  await assert.rejects(install(fx.app, fx.frozen), /changed before/)
  assert.equal(await fs.readFile(fx.target, 'utf8'), 'original')
})

test('does not overwrite a helper symlink outside the output app', async t => {
  const fx = await fixture(t)
  await fs.unlink(fx.target)
  await fs.symlink(fx.frozen.shipit.executable, fx.target)
  await assert.rejects(install(fx.app, fx.frozen), /regular file/)
  assert.equal(await fs.readFile(fx.frozen.shipit.executable, 'utf8'), 'diagnostic')
})

test('rejects modified receipt and missing license', async t => {
  const fx = await fixture(t)
  await install(fx.app, fx.frozen)
  const receipt = path.join(fx.app, EVIDENCE, 'build.json')
  const original = await fs.readFile(receipt)
  await fs.writeFile(receipt, '{}')
  await assert.rejects(verify(fx.app, fx.frozen, false), /evidence changed/)
  await fs.writeFile(receipt, original)
  await fs.unlink(path.join(fx.app, EVIDENCE, 'Squirrel-LICENSE'))
  await assert.rejects(verify(fx.app, fx.frozen, false), /ENOENT/)
})

test('Windows has no ShipIt filesystem dependency', async () => {
  await install('absent', { platform: 'win32' })
  await verify('absent', { platform: 'win32' }, true)
  await assert.rejects(verify('absent', { platform: 'darwin' }, false), /evidence/)
})

test('rejects missing framework evidence and tampered packaged framework', async t => {
  const fx = await fixture(t)
  const squirrel = fx.frozen.squirrel
  delete fx.frozen.squirrel
  await assert.rejects(install(fx.app, fx.frozen), /evidence/)
  fx.frozen.squirrel = squirrel
  await install(fx.app, fx.frozen)
  await fs.writeFile(path.join(fx.app, FRAMEWORK), 'changed')
  await assert.rejects(verify(fx.app, fx.frozen, false), /squirrel differs/)
})

for (const [binary, names] of [['shipit', SHIPIT_OVERLAYS], ['squirrel', SQUIRREL_OVERLAYS]]) {
  test(`rejects missing ${binary} preparation inputs before replacing product binaries`, async t => {
    const fx = await fixture(t)
    for (const name of names) {
      const expected = fx.frozen[binary].overlays[name]
      delete fx.frozen[binary].overlays[name]
      await assert.rejects(install(fx.app, fx.frozen), /overlays/)
      assert.equal(await fs.readFile(fx.target, 'utf8'), 'original')
      fx.frozen[binary].overlays[name] = expected
    }
  })
}
