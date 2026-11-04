const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { prepare, publish } = require('./release.cjs')

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
  return { assets, reports, results, expected, async prepare() {
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

test('manual preview tag identifies the selected build version', async context => {
  const state = fixture(context)
  state.expected.tag = 'v0.3.1-preview.2'
  assert.equal((await state.prepare()).tag, 'v0.3.1-preview.2')
})

for (const tag of ['v0.3.2-preview.1', 'v0.3.1', '--latest', 'v0.3.1-preview.1\nextra']) {
  test(`rejects incompatible or invalid manual preview tag ${JSON.stringify(tag)}`, async context => {
    const state = fixture(context)
    state.expected.tag = tag
    await assert.rejects(state.prepare(), /tag|Tag/)
  })
}

test('stable publication requires a release-channel build', async context => {
  const state = fixture(context, 'release')
  state.expected.tag = 'v0.3.1'
  assert.equal((await state.prepare()).prerelease, false)
  state.expected.tag = 'v0.3.1-preview.1'
  await assert.rejects(state.prepare(), /Tag must match/)
})

test('publication targets the selected source commit and links its build report', async context => {
  const state = fixture(context)
  await state.prepare()
  const temp = path.dirname(state.assets)
  const bin = path.join(temp, 'bin')
  fs.mkdirSync(bin)
  const calls = path.join(temp, 'gh-calls.jsonl')
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n')
console.log(args[0] === 'api' ? '[]' : 'https://github.com/example/project/releases/tag/v0.3.1-preview.2')
`, { mode: 0o755 })
  await publish(state.assets, state.reports, {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GH_CALLS: calls,
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_RUN_ID: '999',
    GITHUB_REPOSITORY: 'example/project',
    SOURCE_COMMIT: state.expected.commit,
    SOURCE_RUN_ID: '123',
    RELEASE_TAG: 'v0.3.1-preview.2',
    PACKAGE_CHANNEL: 'preview',
    RUNNER_TEMP: temp,
    GITHUB_STEP_SUMMARY: path.join(temp, 'summary.md'),
  })
  const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const create = commands.find(args => args[0] === 'release')
  assert.equal(create[2], 'v0.3.1-preview.2')
  assert.equal(create[create.indexOf('--target') + 1], state.expected.commit)
  assert.ok(create.includes('--prerelease'))
  const notes = fs.readFileSync(path.join(temp, 'release-notes.md'), 'utf8')
  assert.ok(notes.includes(state.expected.commit))
  assert.match(notes, /actions\/runs\/123/)
  assert.ok(!notes.includes('999'))
})
