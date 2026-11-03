const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG_NAME = 'config.json'
const PROFILES_NAME = 'model_profiles.json'
const BUNDLED_OFFICE_CORPUS = path.resolve(__dirname, '../../apps/desktop/e2e/fixtures/office-corpus')
const OFFICE_FIXTURES = [
  'doc/selection-multipage.doc',
  'docx/selection-large.docx',
  'xls/selection-100-rows.xls'
]
const OFFICE_MANIFEST_SCHEMA_VERSION = 1
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const HASH_BUFFER_SIZE = 64 * 1024
const INHERITED_RUNTIME_KEYS = [
  'SCHOLARSEED_HOME', 'SCHOLARSEED_CODEX_HOME', 'DAMOATRACE_HOME',
  'DAMOATRACE_LEDGER_ROOT', 'CODEX_HOME'
]

function isolatedCIEnvironment(env = process.env) {
  const result = { ...env }
  if (env.CI_PROJECT_DIR) {
    for (const name of INHERITED_RUNTIME_KEYS) delete result[name]
  }
  return result
}

function validateConfig(filename, env) {
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('CI model config must be a JSON object')
  }
  const model = env.SCHOLARSEED_ACTION_MODEL || config.selected_model_key || config.model_name
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('CI model config has no selected model')
  }
  return model
}

function validateTestData(env) {
  const actionModel = env.SCHOLARSEED_ACTION_MODEL
  const alternateModel = env.SCHOLARSEED_ALTERNATE_MODEL
  if (!actionModel || !alternateModel || actionModel === alternateModel) {
    throw new Error('SCHOLARSEED_ACTION_MODEL and a different SCHOLARSEED_ALTERNATE_MODEL are required')
  }
  return validateOfficeCorpus(env)
}

function validateOfficeCorpus(env) {
  const corpus = env.SCHOLARSEED_OFFICE_CORPUS || BUNDLED_OFFICE_CORPUS
  if (!corpus || OFFICE_FIXTURES.some(relative => !fs.statSync(path.join(corpus, relative),
    { throwIfNoEntry: false })?.isFile())) {
    throw new Error('SCHOLARSEED_OFFICE_CORPUS is missing required Office files')
  }
  const manifestPath = env.SCHOLARSEED_OFFICE_CORPUS_MANIFEST ||
    (env.SCHOLARSEED_OFFICE_CORPUS ? null : path.join(BUNDLED_OFFICE_CORPUS, 'manifest.json'))
  if (!manifestPath || !fs.statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('SCHOLARSEED_OFFICE_CORPUS_MANIFEST is required')
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest?.schemaVersion !== OFFICE_MANIFEST_SCHEMA_VERSION ||
    typeof manifest.version !== 'string' || !manifest.version.trim() ||
    !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Office corpus manifest requires schemaVersion 1, version and files')
  }
  for (const relative of OFFICE_FIXTURES) {
    const expected = manifest.files[relative]
    if (typeof expected !== 'string' || !SHA256_PATTERN.test(expected)) {
      throw new Error(`Office corpus manifest requires SHA-256 for ${relative}`)
    }
    if (hashFile(path.join(corpus, relative)) !== expected.toLowerCase()) {
      throw new Error(`Office corpus SHA-256 mismatch for ${relative}`)
    }
  }
  return manifest.version
}

function hashFile(filename) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE)
  const descriptor = fs.openSync(filename, 'r')
  try {
    let bytesRead
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function prepareModelHome(directory, env = process.env) {
  const officeCorpusVersion = validateTestData(env)
  if (!env.CI_PROJECT_DIR) {
    const home = env.SCHOLARSEED_REAL_HOME
    if (!home) throw new Error('SCHOLARSEED_REAL_HOME is required for live tests')
    validateConfig(path.join(home, CONFIG_NAME), env)
    if (!fs.statSync(path.join(home, PROFILES_NAME), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('SCHOLARSEED_REAL_HOME is missing model_profiles.json')
    }
    return { home, officeCorpusVersion, temporary: false }
  }
  const source = env.SCHOLARSEED_CI_MODEL_CONFIG_FILE
  if (!source) throw new Error('SCHOLARSEED_CI_MODEL_CONFIG_FILE is required on CI')
  const profiles = env.SCHOLARSEED_CI_MODEL_PROFILES_FILE
  if (!profiles) throw new Error('SCHOLARSEED_CI_MODEL_PROFILES_FILE is required on CI')
  validateConfig(source, env)
  const home = path.join(directory, 'model-home')
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const target = path.join(home, CONFIG_NAME)
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o600)
    const profilesTarget = path.join(home, PROFILES_NAME)
    fs.copyFileSync(profiles, profilesTarget)
    fs.chmodSync(profilesTarget, 0o600)
  } catch (error) {
    fs.rmSync(home, { recursive: true, force: true })
    throw error
  }
  return { home, officeCorpusVersion, temporary: true }
}

function cleanupModelHome(modelHome) {
  if (!modelHome?.temporary) return
  fs.rmSync(modelHome.home, { recursive: true, force: true })
}

module.exports = { prepareModelHome, cleanupModelHome, isolatedCIEnvironment, validateOfficeCorpus }
