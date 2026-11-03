const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const NOTICES_DIRECTORY = 'notices'
const MANIFEST_FILENAME = 'manifest.json'
const SOURCE_DIRECTORY = path.join('apps', 'desktop', 'resources', NOTICES_DIRECTORY)
const UV_PACKAGE_SEPARATOR = '[[package]]'
const UV_NAME = /^name = "([^"]+)"\r?$/m
const UV_VERSION = /^version = "([^"]+)"\r?$/m
const HASH_ALGORITHM = 'sha256'
const HASH_ENCODING = 'hex'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MANIFEST_SCHEMA = 1

function digest(bytes) {
  return crypto.createHash(HASH_ALGORITHM).update(bytes).digest(HASH_ENCODING)
}

function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`notice must not be a symlink: ${relative}`)
    if (entry.isDirectory()) return inventory(filename, relative)
    if (!entry.isFile()) throw new Error(`notice must be a regular file: ${relative}`)
    return [{ path: relative, sha256: digest(fs.readFileSync(filename)) }]
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function verifyInputs(repo) {
  const directory = path.join(repo, SOURCE_DIRECTORY)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST_FILENAME)))
  if (manifest.schema !== MANIFEST_SCHEMA || !manifest.components?.length) {
    throw new Error('invalid notices manifest')
  }
  const uvText = fs.readFileSync(path.join(repo, 'uv.lock'), 'utf8')
  const uvPackages = new Map(uvText.split(UV_PACKAGE_SEPARATOR).flatMap(block => {
    const name = block.match(UV_NAME)?.[1]
    return name ? [[name, { version: block.match(UV_VERSION)?.[1], block }]] : []
  }))
  const npmPackages = JSON.parse(fs.readFileSync(path.join(repo, 'apps', 'desktop', 'package-lock.json'))).packages
  const registries = {
    pypi: name => uvPackages.get(name),
    npm: name => npmPackages[`node_modules/${name}`]
  }
  const files = inventory(directory)
  const digests = new Map(files.map(file => [file.path, file.sha256]))
  for (const document of manifest.documents) {
    if (!digests.has(document)) throw new Error(`notice document missing: ${document}`)
  }
  for (const supplement of manifest.supplements) {
    if (digests.get(supplement.licenseFile) !== supplement.noticeSha256) {
      throw new Error(`notice supplement missing or changed: ${supplement.licenseFile}`)
    }
  }
  for (const component of manifest.components) {
    const locked = registries[component.ecosystem]?.(component.name)
    if (locked?.version !== component.version) {
      throw new Error(`notice version differs from lock: ${component.name}`)
    }
    if (!component.source?.url?.startsWith('https://') || !SHA256_PATTERN.test(component.source.sha256)) {
      throw new Error(`notice requires versioned source evidence: ${component.name}`)
    }
    if (!component.artifacts?.length) throw new Error(`notice requires artifact evidence: ${component.name}`)
    if (component.ecosystem === 'pypi' && !locked.block.includes(`sha256:${component.source.sha256}`)) {
      throw new Error(`notice source differs from lock: ${component.name}`)
    }
    for (const artifact of component.artifacts) {
      if (component.ecosystem === 'pypi' && !locked.block.includes(`sha256:${artifact.sha256}`)) {
        throw new Error(`notice artifact differs from lock: ${artifact.filename}`)
      }
      if (component.ecosystem === 'npm' && locked.integrity !== artifact.integrity) {
        throw new Error(`notice artifact differs from lock: ${artifact.filename}`)
      }
      if (digests.get(artifact.licenseFile) !== artifact.noticeSha256) {
        throw new Error(`notice license missing or changed: ${artifact.licenseFile}`)
      }
    }
  }
  return files
}

function verifyNotices(resourceRoot, expected) {
  if (!Array.isArray(expected) || !expected.length) throw new Error('missing frozen notices inventory')
  const actual = inventory(path.join(resourceRoot, NOTICES_DIRECTORY))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('packaged notices differ from frozen build inputs')
  }
  return actual
}

function stageNotices(repo, resourceRoot) {
  const expected = verifyInputs(repo)
  fs.cpSync(path.join(repo, SOURCE_DIRECTORY), path.join(resourceRoot, NOTICES_DIRECTORY), { recursive: true })
  return verifyNotices(resourceRoot, expected)
}

module.exports = { NOTICES_DIRECTORY, verifyInputs, verifyNotices, stageNotices }
