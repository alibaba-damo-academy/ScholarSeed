const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { collect } = require('./package.cjs')

// 验证工件筛选和篡改拒绝，不替代真实签名、公证与安装验收。
function fixture(context, arch = 'arm64') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-artifacts-'))
  context.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const release = path.join(repo, 'apps/desktop/release')
  fs.mkdirSync(release, { recursive: true })
  const content = 'artifact fixture'
  const filename = path.join(release, 'ScholarSeed.dmg')
  fs.writeFileSync(filename, content)
  fs.writeFileSync(path.join(release, 'signing-context.json'), 'must not be uploaded')
  const digest = crypto.createHash('sha256').update(content).digest('hex')
  const result = {
    status: 'passed', publishable: true, verification_skipped: false,
    source: { commit: 'a'.repeat(40) },
    release: { channel: 'preview', platform: 'darwin', arch: arch === 'x64' ? 'x86_64' : arch },
    trust: { level: 'developer-id-notarized' },
    artifacts: {
      app: { signature_valid: true },
      dmg: { path: filename, size: Buffer.byteLength(content), sha256: digest, signature_valid: true,
        installed_check: { status: 'passed', source: 'mounted-dmg', detached: true,
          package_check: { ok: true }, sha256: digest } },
    },
  }
  const resultFile = path.join(repo, 'result.json')
  const destination = path.join(repo, 'upload')
  const expected = { repo, commit: result.source.commit, channel: 'preview', arch }
  return { result, filename, destination, async collect() {
    fs.writeFileSync(resultFile, JSON.stringify(result))
    return collect(resultFile, destination, expected)
  } }
}

test('only the verified DMG, result and checksum enter the artifact directory', async context => {
  const state = fixture(context)
  await state.collect()
  assert.deepEqual(fs.readdirSync(state.destination).sort(), ['ScholarSeed.dmg', 'ScholarSeed.dmg.sha256', 'result.json'])
  assert.match(fs.readFileSync(path.join(state.destination, 'ScholarSeed.dmg.sha256'), 'utf8'), /^[a-f0-9]{64}  ScholarSeed\.dmg\n$/)
})

test('collects the native x64 build using its x86_64 result architecture', async context => {
  const state = fixture(context, 'x64')
  await state.collect()
  assert.equal(JSON.parse(fs.readFileSync(path.join(state.destination, 'result.json'), 'utf8')).release.arch, 'x86_64')
})

for (const arch of ['arm64', 'x64']) {
  test(`rejects the other architecture for ${arch}`, async context => {
    const state = fixture(context, arch)
    state.result.release.arch = arch === 'arm64' ? 'x86_64' : 'arm64'
    await assert.rejects(state.collect(), /different architecture/)
    assert.equal(fs.existsSync(state.destination), false)
  })
}

for (const [name, change] of [
  ['failed build', result => { result.status = 'failed' }],
  ['unsigned candidate', result => { result.publishable = false }],
  ['skipped verification', result => { result.verification_skipped = true }],
  ['stale commit', result => { result.source.commit = 'b'.repeat(40) }],
  ['wrong channel', result => { result.release.channel = 'release' }],
  ['missing notarization', result => { result.trust.level = 'ad-hoc-local-only' }],
  ['failed mounted acceptance', result => { result.artifacts.dmg.installed_check.status = 'failed' }],
]) {
  test(`rejects ${name} before staging`, async context => {
    const state = fixture(context)
    change(state.result)
    await assert.rejects(state.collect())
    assert.equal(fs.existsSync(state.destination), false)
  })
}

test('rejects a same-size DMG modified after verification', async context => {
  const state = fixture(context)
  fs.writeFileSync(state.filename, 'ARTIFACT FIXTURE')
  await assert.rejects(state.collect(), /DMG digest changed/)
  assert.equal(fs.existsSync(state.destination), false)
})
