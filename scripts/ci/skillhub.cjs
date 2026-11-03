const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MANIFEST_SCHEMA_VERSION = 1
const REGISTRY_SCHEMA_VERSION = 1
const HASH_BUFFER_SIZE = 64 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const PACKAGE_NAME_PATTERN = /^[^/\\]+\.zip$/i
const GROUP_OR_WORLD_PERMISSIONS = 0o077
const TOKEN_KEYS = ['SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE',
  'SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE']
const REQUIRED_FILES = [
  'SCHOLARSEED_CI_SKILLHUB_CONFIG', 'SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE',
  'SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE', 'SCHOLARSEED_CI_SKILLHUB_MANIFEST'
]

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

function prepareSkillHub(directory, env = process.env) {
  for (const key of REQUIRED_FILES) {
    if (!env[key] || !fs.statSync(env[key], { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${key} must name an existing file`)
    }
  }
  if (env.SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE ===
      env.SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE) {
    throw new Error('SkillHub read and publish token files must differ')
  }
  for (const key of TOKEN_KEYS) {
    const info = fs.lstatSync(env[key])
    if (!info.isFile() || info.mode & GROUP_OR_WORLD_PERMISSIONS) {
      throw new Error(`${key} must be an owner-only regular file`)
    }
  }
  const namespace = env.SCHOLARSEED_CI_SKILLHUB_NAMESPACE
  if (!namespace || !namespace.trim()) throw new Error('SCHOLARSEED_CI_SKILLHUB_NAMESPACE is required')
  const url = env.SCHOLARSEED_CI_SKILLHUB_URL
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('SCHOLARSEED_CI_SKILLHUB_URL must be a valid URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)
  if (parsedUrl.username || parsedUrl.password || parsedUrl.pathname !== '/' || parsedUrl.search ||
      parsedUrl.hash || (parsedUrl.protocol !== 'https:' && !(loopback && parsedUrl.protocol === 'http:'))) {
    throw new Error('SCHOLARSEED_CI_SKILLHUB_URL must be an HTTPS or loopback origin')
  }
  const config = JSON.parse(fs.readFileSync(env.SCHOLARSEED_CI_SKILLHUB_CONFIG, 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(env.SCHOLARSEED_CI_SKILLHUB_MANIFEST, 'utf8'))
  if (config?.schema !== REGISTRY_SCHEMA_VERSION || config.namespace !== namespace ||
      manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
      manifest.namespace !== namespace || typeof manifest.version !== 'string' ||
      !manifest.version.trim() || !manifest.packages || typeof manifest.packages !== 'object' ||
      Array.isArray(manifest.packages)) {
    throw new Error('SkillHub config and versioned manifest must match the CI namespace')
  }
  const packages = env.SCHOLARSEED_CI_SKILLHUB_PACKAGES
  if (!packages || !fs.statSync(packages, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('SCHOLARSEED_CI_SKILLHUB_PACKAGES must name a directory')
  }
  const expected = Object.keys(manifest.packages).sort()
  const actual = fs.readdirSync(packages).filter(name => name.toLowerCase().endsWith('.zip')).sort()
  if (!expected.length || expected.some(name => !PACKAGE_NAME_PATTERN.test(name)) ||
      JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('SkillHub package set differs from the versioned manifest')
  }
  for (const name of expected) {
    const filename = path.join(packages, name)
    const digest = manifest.packages[name]
    if (!fs.statSync(filename).isFile() || typeof digest !== 'string' ||
        !SHA256_PATTERN.test(digest) || hashFile(filename) !== digest.toLowerCase()) {
      throw new Error(`SkillHub SHA-256 mismatch for ${name}`)
    }
  }
  const cache = path.join(directory, 'skillhub-cache')
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  return { ...env, SCHOLARSEED_CI_SKILLHUB_CACHE: cache,
    SCHOLARSEED_CI_SKILLHUB_VERSION: manifest.version }
}

module.exports = { prepareSkillHub }
