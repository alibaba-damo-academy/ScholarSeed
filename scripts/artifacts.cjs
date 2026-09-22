#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const CACHE_ENV = 'SCHOLARSEED_ARTIFACT_CACHE'
const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN'
const WINDOWS_PLATFORM = 'win32'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const DOWNLOAD_MODE = 0o600
const DIRECTORY_MODE = 0o700

function artifactCache(environment = process.env, platform = process.platform) {
  if (environment[CACHE_ENV]) return path.resolve(environment[CACHE_ENV])
  if (platform === WINDOWS_PLATFORM) {
    const localAppData = environment.LOCALAPPDATA
    if (!localAppData) throw new Error('LOCALAPPDATA is required for the artifact cache')
    return path.join(localAppData, 'ScholarSeed', 'cache', 'artifacts')
  }
  return path.join(os.homedir(), '.cache', 'scholarseed', 'artifacts')
}

async function digest(filename) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function matches(filename, expected) {
  try {
    const stat = fs.statSync(filename)
    return stat.isFile() && stat.size === expected.bytes &&
      await digest(filename) === expected.sha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact.url !== 'string' ||
      !['https:', 'http:'].includes(new URL(artifact.url).protocol) ||
      !SHA256_PATTERN.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error('artifact metadata is incomplete or invalid')
  }
}

function requestHeaders(url, environment) {
  const token = environment[GITHUB_TOKEN_ENV]
  return token && new URL(url).hostname === 'github.com'
    ? { Authorization: `Bearer ${token}` }
    : {}
}

async function copyVerified(source, destination, artifact) {
  const directory = path.dirname(destination)
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
  const temporary = path.join(directory,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    fs.copyFileSync(source, temporary)
    if (!await matches(temporary, artifact)) throw new Error('artifact cache copy failed verification')
    fs.chmodSync(temporary, artifact.mode || DOWNLOAD_MODE)
    try {
      fs.renameSync(temporary, destination)
    } catch (error) {
      if (!await matches(destination, artifact)) throw error
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

async function download(destination, artifact, environment) {
  const response = await fetch(artifact.url, {
    redirect: 'follow',
    headers: requestHeaders(artifact.url, environment)
  })
  if (!response.ok || !response.body) {
    throw new Error(`artifact download failed: HTTP ${response.status} (${artifact.url})`)
  }
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, {
      flags: 'wx', mode: DOWNLOAD_MODE
    }))
    if (!await matches(temporary, artifact)) {
      throw new Error(`artifact download failed verification: ${artifact.url}`)
    }
    try {
      fs.renameSync(temporary, destination)
    } catch (error) {
      if (!await matches(destination, artifact)) throw error
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

async function ensureArtifact(destination, artifact, options = {}) {
  validateArtifact(artifact)
  const environment = options.environment || process.env
  if (await matches(destination, artifact)) {
    const cache = path.join(artifactCache(environment, options.platform), artifact.sha256)
    if (!await matches(cache, artifact)) await copyVerified(destination, cache, artifact)
    return destination
  }
  const root = artifactCache(environment, options.platform)
  fs.mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE })
  const cache = path.join(root, artifact.sha256)
  if (!await matches(cache, artifact)) await download(cache, artifact, environment)
  await copyVerified(cache, destination, artifact)
  return destination
}

module.exports = { artifactCache, digest, ensureArtifact, matches, validateArtifact }
