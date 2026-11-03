// Private immutable build cache. Never caches signatures, tests or acceptance.
const fs = require('node:fs')
const path = require('node:path')
const state = require('../shared/build-state.cjs')
const { artifactCache } = require('../../../../scripts/shared/artifacts.cjs')
const { timed } = require('../../../../scripts/shared/timing.cjs')
const SCHEMA = 1
const RECEIPT = 'receipt.json'
const DATA = 'data'
const MAX_RECEIPT = 16 * 1024 * 1024

function root(environment = process.env) {
  return path.join(environment.SCHOLARSEED_BUILD_CACHE_ROOT || path.dirname(artifactCache(environment)), 'build')
}
function key(inputs) { return state.identity({schema: SCHEMA, inputs}) }
function verify(directory, inputs) {
  state.assertPrivateDirectory(directory)
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify([DATA, RECEIPT]))
    throw new Error('incomplete build cache entry')
  const receipt = path.join(directory, RECEIPT)
  state.assertPrivateFile(receipt)
  if (state.regular(receipt).size > MAX_RECEIPT) throw new Error('oversized build cache receipt')
  const record = JSON.parse(fs.readFileSync(receipt, 'utf8'))
  const data = path.join(directory, DATA)
  if (record.schema !== SCHEMA || state.identity(record.inputs) !== state.identity(inputs) ||
      state.identity(record.files) !== state.identity(state.inventory(data)))
    throw new Error('build cache input or inventory mismatch')
  return data
}
function materialize(cacheRoot, kind, inputs, populate) {
  if (!/^[a-z-]+$/.test(kind)) throw new Error('invalid build cache namespace')
  const parent = state.ensurePrivateDirectory(path.join(cacheRoot, kind))
  const directory = path.join(parent, key(inputs))
  if (fs.existsSync(directory)) {
    const data = timed(`${kind}.cache-verify`, () => verify(directory, inputs))
    console.log(`[build-cache] hit ${kind}`)
    return data
  }
  const temporary = fs.mkdtempSync(path.join(parent, '.prepare-'))
  try {
    const data = path.join(temporary, DATA)
    fs.mkdirSync(data)
    timed(`${kind}.cache-build`, () => populate(data))
    const record = {schema: SCHEMA, inputs, files: state.inventory(data)}
    fs.writeFileSync(path.join(temporary, RECEIPT), JSON.stringify(record), {flag: 'wx', mode: 0o600})
    try { fs.renameSync(temporary, directory) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !fs.existsSync(directory)) throw error
      const winner = verify(directory, inputs)
      if (state.identity(state.inventory(winner)) !== state.identity(record.files))
        throw new Error('build cache reproducibility conflict')
      return winner
    }
    console.log(`[build-cache] stored ${kind}`)
    return path.join(directory, DATA)
  } finally { fs.rmSync(temporary, {recursive: true, force: true}) }
}
function expanded(archive, expected, environment, populate) {
  if (state.regular(archive).size !== expected.bytes || state.hashFile(archive) !== expected.sha256)
    throw new Error('toolchain archive differs from policy')
  const data = materialize(root(environment), 'toolchains', {sha256: expected.sha256, bytes: expected.bytes}, populate)
  if (state.hashFile(archive) !== expected.sha256) throw new Error('toolchain archive changed during preparation')
  return data
}
function goObjects(environment, archiveSha256) {
  return state.ensurePrivateDirectory(path.join(root(environment), 'go', archiveSha256))
}
module.exports = { root, key, materialize, expanded, goObjects }
