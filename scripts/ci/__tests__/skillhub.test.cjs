const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { prepareSkillHub } = require('../skillhub.cjs')

function fixture(directory, context) {
  const packages = path.join(directory, 'packages')
  fs.mkdirSync(packages)
  const content = Buffer.from('versioned skill package')
  fs.writeFileSync(path.join(packages, 'approved.zip'), content)
  const config = path.join(directory, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ schema: 1, namespace: 'ci-run-123' }))
  const manifest = path.join(directory, 'manifest.json')
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, version: 'fixture-v1',
    namespace: 'ci-run-123', packages: {
      'approved.zip': crypto.createHash('sha256').update(content).digest('hex') } }))
  const readToken = path.join(directory, 'read-token')
  const publishToken = path.join(directory, 'publish-token')
  fs.writeFileSync(readToken, 'read-secret')
  fs.writeFileSync(publishToken, 'publish-secret')
  fs.chmodSync(readToken, 0o600)
  fs.chmodSync(publishToken, 0o600)
  const tokenModes = new Map([[readToken, 0o600], [publishToken, 0o600]])
  if (process.platform === 'win32') {
    // Exercise the POSIX mode policy without depending on Windows' synthetic mode bits.
    const lstat = fs.lstatSync
    context.mock.method(fs, 'lstatSync', (filename, ...args) => {
      const info = lstat(filename, ...args)
      if (tokenModes.has(filename)) info.mode = (info.mode & ~0o777) | tokenModes.get(filename)
      return info
    })
  }
  const setReadTokenMode = mode => {
    tokenModes.set(readToken, mode)
    fs.chmodSync(readToken, mode)
  }
  return { setReadTokenMode, env: { SCHOLARSEED_CI_SKILLHUB_CONFIG: config,
    SCHOLARSEED_CI_SKILLHUB_URL: 'https://hub.example.invalid',
    SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE: readToken,
    SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE: publishToken,
    SCHOLARSEED_CI_SKILLHUB_PACKAGES: packages,
    SCHOLARSEED_CI_SKILLHUB_MANIFEST: manifest,
    SCHOLARSEED_CI_SKILLHUB_NAMESPACE: 'ci-run-123' } }
}

test('SkillHub preflight pins the CI namespace and package bytes', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-skillhub-test-'))
  try {
    const { env } = fixture(directory, context)
    const prepared = prepareSkillHub(directory, env)
    assert.equal(prepared.SCHOLARSEED_CI_SKILLHUB_CACHE, path.join(directory, 'skillhub-cache'))
    assert.equal(prepared.SCHOLARSEED_CI_SKILLHUB_VERSION, 'fixture-v1')
    assert.equal(fs.statSync(prepared.SCHOLARSEED_CI_SKILLHUB_CACHE).isDirectory(), true)
    assert.throws(() => prepareSkillHub(directory, { ...env,
      SCHOLARSEED_CI_SKILLHUB_MANIFEST: '' }), /SKILLHUB_MANIFEST/)
    assert.throws(() => prepareSkillHub(directory, { ...env,
      SCHOLARSEED_CI_SKILLHUB_NAMESPACE: 'production' }), /namespace/)
    fs.writeFileSync(path.join(env.SCHOLARSEED_CI_SKILLHUB_PACKAGES, 'approved.zip'), 'changed')
    assert.throws(() => prepareSkillHub(directory, env), /SHA-256/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('SkillHub preflight rejects missing or extra packages before network access', context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-skillhub-test-'))
  try {
    const { env, setReadTokenMode } = fixture(directory, context)
    fs.writeFileSync(path.join(env.SCHOLARSEED_CI_SKILLHUB_PACKAGES, 'extra.zip'), 'unreviewed')
    assert.throws(() => prepareSkillHub(directory, env), /package set/)
    fs.rmSync(path.join(env.SCHOLARSEED_CI_SKILLHUB_PACKAGES, 'extra.zip'))
    setReadTokenMode(0o644)
    assert.throws(() => prepareSkillHub(directory, env), /owner-only/)
    setReadTokenMode(0o600)
    fs.rmSync(env.SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE)
    assert.throws(() => prepareSkillHub(directory, env), /READ_TOKEN_FILE/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
