const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { prepareSkillHub } = require('../skillhub.cjs')

function fixture(directory) {
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
  return { SCHOLARSEED_CI_SKILLHUB_CONFIG: config,
    SCHOLARSEED_CI_SKILLHUB_URL: 'https://hub.example.invalid',
    SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE: readToken,
    SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE: publishToken,
    SCHOLARSEED_CI_SKILLHUB_PACKAGES: packages,
    SCHOLARSEED_CI_SKILLHUB_MANIFEST: manifest,
    SCHOLARSEED_CI_SKILLHUB_NAMESPACE: 'ci-run-123' }
}

test('SkillHub preflight pins the CI namespace and package bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-skillhub-test-'))
  try {
    const env = fixture(directory)
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

test('SkillHub preflight rejects missing or extra packages before network access', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-skillhub-test-'))
  try {
    const env = fixture(directory)
    fs.writeFileSync(path.join(env.SCHOLARSEED_CI_SKILLHUB_PACKAGES, 'extra.zip'), 'unreviewed')
    assert.throws(() => prepareSkillHub(directory, env), /package set/)
    fs.rmSync(path.join(env.SCHOLARSEED_CI_SKILLHUB_PACKAGES, 'extra.zip'))
    fs.chmodSync(env.SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE, 0o644)
    assert.throws(() => prepareSkillHub(directory, env), /owner-only/)
    fs.chmodSync(env.SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE, 0o600)
    fs.rmSync(env.SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE)
    assert.throws(() => prepareSkillHub(directory, env), /READ_TOKEN_FILE/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
