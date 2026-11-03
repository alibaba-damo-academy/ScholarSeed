const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { isolatedCIEnvironment, prepareModelHome, cleanupModelHome,
  validateOfficeCorpus } = require('../model.cjs')

function requiredData(directory) {
  const corpus = path.join(directory, 'corpus')
  const files = {}
  for (const relative of ['doc/selection-multipage.doc', 'docx/selection-large.docx',
    'xls/selection-100-rows.xls']) {
    const filename = path.join(corpus, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, 'fixture')
    files[relative] = crypto.createHash('sha256').update('fixture').digest('hex')
  }
  const manifest = path.join(directory, 'office-corpus.json')
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, version: 'fixture-v1', files }))
  return { SCHOLARSEED_ACTION_MODEL: 'test-model', SCHOLARSEED_ALTERNATE_MODEL: 'other-model',
    SCHOLARSEED_OFFICE_CORPUS: corpus, SCHOLARSEED_OFFICE_CORPUS_MANIFEST: manifest }
}

test('CI stages discard inherited runtime homes without requiring a native credential source', () => {
  const env = isolatedCIEnvironment({ CI_PROJECT_DIR: '/ci', SCHOLARSEED_HOME: '/personal',
    SCHOLARSEED_CODEX_HOME: '/personal/codex', CODEX_HOME: '/personal/.codex' })
  assert.equal(env.SCHOLARSEED_HOME, undefined)
  assert.equal(env.SCHOLARSEED_CODEX_HOME, undefined)
  assert.equal(env.CODEX_HOME, undefined)
})

test('local CI uses the versioned Office corpus without LibreOffice or corpus variables', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ selected_model_key: 'test-model' }))
    fs.writeFileSync(path.join(directory, 'model_profiles.json'), '{}')
    const prepared = prepareModelHome(directory, {
      SCHOLARSEED_ACTION_MODEL: 'test-model', SCHOLARSEED_ALTERNATE_MODEL: 'other-model',
      SCHOLARSEED_REAL_HOME: directory
    })
    assert.equal(prepared.officeCorpusVersion, 'selection-v1')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('offline CI validates the bundled Office corpus without model settings', () => {
  assert.equal(validateOfficeCorpus({}), 'selection-v1')
})

test('CI copies only the protected model config into a private run home', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    const source = path.join(directory, 'source.json')
    const profiles = path.join(directory, 'profiles.json')
    fs.writeFileSync(source, JSON.stringify({ selected_model_key: 'test-model', token: 'secret' }))
    fs.writeFileSync(profiles, '{}')
    const prepared = prepareModelHome(directory, { ...requiredData(directory), CI_PROJECT_DIR: directory,
      SCHOLARSEED_CI_MODEL_CONFIG_FILE: source,
      SCHOLARSEED_CI_MODEL_PROFILES_FILE: profiles,
      SCHOLARSEED_REAL_HOME: '/real-user-home' })
    assert.equal(prepared.home, path.join(directory, 'model-home'))
    assert.equal(prepared.temporary, true)
    assert.equal(prepared.officeCorpusVersion, 'fixture-v1')
    assert.deepEqual(fs.readdirSync(prepared.home).sort(), ['config.json', 'model_profiles.json'])
    assert.equal(fs.existsSync(path.join(directory, 'codex-source')), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prepared.home, 'config.json'))),
      { selected_model_key: 'test-model', token: 'secret' })
    assert.equal(fs.readFileSync(path.join(prepared.home, 'model_profiles.json'), 'utf8'), '{}')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CI rejects a missing or malformed protected model config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    const data = requiredData(directory)
    assert.throws(() => prepareModelHome(directory, { ...data, CI_PROJECT_DIR: directory }), /MODEL_CONFIG_FILE/)
    const source = path.join(directory, 'source.json')
    const profiles = path.join(directory, 'profiles.json')
    fs.writeFileSync(profiles, '{}')
    fs.writeFileSync(source, '[]')
    assert.throws(() => prepareModelHome(directory, { ...data, CI_PROJECT_DIR: directory,
      SCHOLARSEED_CI_MODEL_CONFIG_FILE: source,
      SCHOLARSEED_CI_MODEL_PROFILES_FILE: profiles }), /JSON object/)
    fs.writeFileSync(source, JSON.stringify({ selected_model_key: 'test-model' }))
    assert.throws(() => prepareModelHome(directory, { ...data, CI_PROJECT_DIR: directory,
      SCHOLARSEED_CI_MODEL_CONFIG_FILE: source }), /MODEL_PROFILES_FILE/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CI removes partial private homes when copying protected credentials fails', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    const source = path.join(directory, 'source.json')
    const profiles = path.join(directory, 'profiles.json')
    fs.writeFileSync(source, JSON.stringify({ selected_model_key: 'test-model' }))
    assert.throws(() => prepareModelHome(directory, { ...requiredData(directory), CI_PROJECT_DIR: directory,
      SCHOLARSEED_CI_MODEL_CONFIG_FILE: source,
      SCHOLARSEED_CI_MODEL_PROFILES_FILE: profiles }), /ENOENT/)
    assert.equal(fs.existsSync(path.join(directory, 'model-home')), false)
    assert.equal(fs.existsSync(path.join(directory, 'codex-source')), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CI removes prepared credentials without deleting a local model home', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    const temporaryHome = path.join(directory, 'model-home')
    const unrelatedHome = path.join(directory, 'unrelated-home')
    const localHome = path.join(directory, 'local-home')
    for (const home of [temporaryHome, unrelatedHome, localHome]) {
      fs.mkdirSync(home)
      fs.writeFileSync(path.join(home, 'credential'), 'secret')
    }
    cleanupModelHome({ home: temporaryHome, temporary: true })
    assert.equal(fs.existsSync(temporaryHome), false)
    assert.equal(fs.existsSync(unrelatedHome), true)
    cleanupModelHome({ home: localHome, temporary: false })
    assert.equal(fs.existsSync(path.join(localHome, 'credential')), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CI fails early when live and Office prerequisites are incomplete', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    assert.throws(() => prepareModelHome(directory, {}), /ACTION_MODEL/)
    assert.throws(() => prepareModelHome(directory, { SCHOLARSEED_ACTION_MODEL: 'same',
      SCHOLARSEED_ALTERNATE_MODEL: 'same' }), /ALTERNATE_MODEL/)
    assert.throws(() => prepareModelHome(directory, { SCHOLARSEED_ACTION_MODEL: 'first',
      SCHOLARSEED_ALTERNATE_MODEL: 'second' }), /REAL_HOME/)
    assert.throws(() => prepareModelHome(directory, { SCHOLARSEED_ACTION_MODEL: 'first',
      SCHOLARSEED_ALTERNATE_MODEL: 'second', SCHOLARSEED_OFFICE_CORPUS: directory }), /OFFICE_CORPUS/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CI rejects missing Office manifest and modified corpus bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    const data = requiredData(directory)
    const localHome = path.join(directory, 'local-home')
    fs.mkdirSync(localHome)
    fs.writeFileSync(path.join(localHome, 'config.json'), JSON.stringify({ selected_model_key: 'test-model' }))
    fs.writeFileSync(path.join(localHome, 'model_profiles.json'), '{}')
    const env = { ...data, SCHOLARSEED_REAL_HOME: localHome }
    assert.throws(() => prepareModelHome(directory, { ...env,
      SCHOLARSEED_OFFICE_CORPUS_MANIFEST: undefined }), /OFFICE_CORPUS_MANIFEST/)
    fs.writeFileSync(path.join(data.SCHOLARSEED_OFFICE_CORPUS, 'doc/selection-multipage.doc'), 'changed')
    assert.throws(() => prepareModelHome(directory, env), /SHA-256.*doc\/selection-multipage.doc/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('CI rejects incomplete or malformed Office corpus manifests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-model-test-'))
  try {
    const data = requiredData(directory)
    const localHome = path.join(directory, 'local-home')
    fs.mkdirSync(localHome)
    fs.writeFileSync(path.join(localHome, 'config.json'), JSON.stringify({ selected_model_key: 'test-model' }))
    fs.writeFileSync(path.join(localHome, 'model_profiles.json'), '{}')
    const env = { ...data, SCHOLARSEED_REAL_HOME: localHome }
    fs.writeFileSync(data.SCHOLARSEED_OFFICE_CORPUS_MANIFEST, JSON.stringify({
      schemaVersion: 2, version: 'fixture-v1', files: {} }))
    assert.throws(() => prepareModelHome(directory, env), /schemaVersion/)
    fs.writeFileSync(data.SCHOLARSEED_OFFICE_CORPUS_MANIFEST, JSON.stringify({
      schemaVersion: 1, version: 'fixture-v1', files: {} }))
    assert.throws(() => prepareModelHome(directory, env), /SHA-256.*doc\/selection-multipage.doc/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
