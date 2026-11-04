const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { prepare } = require('./release.cjs')

function fixture(context, channel = 'preview') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-assets-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const assets = path.join(root, 'assets')
  const reports = path.join(root, 'reports')
  fs.mkdirSync(assets)
  const expected = { commit: 'a'.repeat(40), channel }
  const results = ['arm64', 'x86_64'].map(arch => {
    const name = `ScholarSeed-0.3.1-darwin-${arch}.dmg`
    const digest = crypto.createHash('sha256').update(arch).digest('hex')
    fs.writeFileSync(path.join(assets, name), arch)
    fs.writeFileSync(path.join(assets, `${name}.sha256`), `${digest}  ${name}\n`)
    return {
      status: 'passed', publishable: true, verification_skipped: false,
      source: { commit: expected.commit },
      release: { version: '0.3.1', build_number: '202611041200', channel, platform: 'darwin', arch },
      trust: { level: 'developer-id-notarized' },
      artifacts: { app: { signature_valid: true }, dmg: {
        path: `/runner/${name}`, size: arch.length, sha256: digest, signature_valid: true,
        installed_check: { status: 'passed', source: 'mounted-dmg', detached: true, package_check: { ok: true }, sha256: digest },
      } },
    }
  })
  return { assets, results, async prepare() {
    fs.mkdirSync(reports, { recursive: true })
    results.forEach((result, index) => {
      const directory = path.join(reports, `build-report-${index}`)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result))
    })
    return prepare(assets, reports, expected)
  } }
}

test('preview publishes exactly two installers and their checksums', async context => {
  const state = fixture(context)
  fs.writeFileSync(path.join(state.assets, 'result.json'), 'not a release asset')
  const release = await state.prepare()
  assert.equal(release.tag, 'v0.3.1-preview.202611041200')
  assert.equal(release.prerelease, true)
  assert.equal(release.assets.length, 4)
  assert.ok(release.assets.every(file => /\.dmg(?:\.sha256)?$/.test(file)))
})

test('release channel uses a stable version tag', async context => {
  const release = await fixture(context, 'release').prepare()
  assert.equal(release.tag, 'v0.3.1')
  assert.equal(release.prerelease, false)
})

for (const [name, change, error] of [
  ['missing architecture', state => state.results.pop(), /Both macOS architectures/],
  ['duplicate architecture', state => { state.results[1].release.arch = 'arm64' }, /Both macOS architectures/],
  ['mixed commits', state => { state.results[1].source.commit = 'b'.repeat(40) }, /different commit/],
  ['mixed versions', state => { state.results[1].release.version = '0.3.2' }, /Versions differ/],
  ['mixed build numbers', state => { state.results[1].release.build_number = '202611041201' }, /Build numbers differ/],
  ['wrong channel', state => { state.results[1].release.channel = 'release' }, /different channel/],
  ['unsigned build', state => { state.results[1].trust.level = 'unsigned' }, /Notarization evidence/],
  ['failed acceptance', state => { state.results[1].artifacts.dmg.installed_check.status = 'failed' }, /acceptance did not pass/],
  ['changed installer', state => fs.writeFileSync(path.join(state.assets, 'ScholarSeed-0.3.1-darwin-arm64.dmg'), 'ARM64'), /digest changed/],
  ['changed checksum', state => fs.writeFileSync(path.join(state.assets, 'ScholarSeed-0.3.1-darwin-arm64.dmg.sha256'), 'invalid'), /Checksum file differs/],
]) {
  test(`rejects ${name} before publication`, async context => {
    const state = fixture(context)
    change(state)
    await assert.rejects(state.prepare(), error)
  })
}
