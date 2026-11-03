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
const DOWNLOAD_TIMEOUT_MS = 120000
const DOWNLOAD_ATTEMPTS = 2

function artifactCache(environment = process.env, platform = process.platform) {
  if (environment[CACHE_ENV]) return path.resolve(environment[CACHE_ENV])
  if (platform === WINDOWS_PLATFORM) {
    const localAppData = environment.LOCALAPPDATA
    if (!localAppData) throw new Error('LOCALAPPDATA is required for the artifact cache')
    return path.join(localAppData, 'ScholarSeed', 'cache', 'artifacts')
  }
  return path.join(os.homedir(), '.cache', 'scholarseed', 'artifacts')
}

async function digest(filename, signal) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function matches(filename, expected, signal) {
  signal?.throwIfAborted()
  try {
    const stat = fs.statSync(filename)
    return stat.isFile() && stat.size === expected.bytes &&
      await digest(filename, signal) === expected.sha256
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
  if (
    artifact.mirrors !== undefined &&
    (!Array.isArray(artifact.mirrors) ||
      artifact.mirrors.some(
        (url) =>
          typeof url !== 'string' ||
          !['https:', 'http:'].includes(new URL(url).protocol),
      ))
  ) {
    throw new Error('artifact mirror metadata is invalid')
  }
}

function requestHeaders(url, environment) {
  const token = environment[GITHUB_TOKEN_ENV]
  return token && new URL(url).hostname === 'github.com'
    ? { Authorization: `Bearer ${token}` }
    : {}
}

async function copyVerified(source, destination, artifact, signal) {
  signal?.throwIfAborted()
  const directory = path.dirname(destination)
  fs.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
  const temporary = path.join(directory,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    await fs.promises.copyFile(source, temporary)
    if (!await matches(temporary, artifact, signal)) throw new Error('artifact cache copy failed verification')
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

function sourceLabel(url) {
  const parsed = new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}

async function download(destination, artifact, environment, timeoutMs, signal) {
  const label = sourceLabel(artifact.url)
  const response = await fetch(artifact.url, {
    redirect: 'follow',
    headers: requestHeaders(artifact.url, environment),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporary, {
        flags: 'wx',
        mode: DOWNLOAD_MODE,
      }),
    )
    if (!(await matches(temporary, artifact, signal))) {
      throw new Error(`artifact download failed verification: ${label}`)
    }
    try {
      fs.renameSync(temporary, destination)
    } catch (error) {
      if (!(await matches(destination, artifact))) throw error
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

async function downloadSources(destination, artifact, environment, options) {
  const failures = []
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const attempts = options.attempts ?? DOWNLOAD_ATTEMPTS
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts > DOWNLOAD_ATTEMPTS
  ) {
    throw new Error('invalid artifact download limits')
  }
  for (const url of new Set([...(artifact.mirrors || []), artifact.url])) {
    const label = sourceLabel(url)
    for (let attempt = 1; attempt <= attempts; attempt++) {
      options.signal?.throwIfAborted()
      console.log(
        `[artifact] download ${label} attempt=${attempt}/${attempts}`,
      )
      try {
        await download(
          destination,
          { ...artifact, url },
          environment,
          timeoutMs,
          options.signal,
        )
        return
      } catch (error) {
        options.signal?.throwIfAborted()
        // Never expose signed URL query parameters or embedded credentials.
        const code = error.cause?.code || error.code
        const reason = typeof code === 'string' ? code : error.name
        const detail = error.message?.startsWith('HTTP ')
          ? error.message
          : error.message?.includes('failed verification')
            ? 'failed verification'
            : reason
        const failure = `${label} attempt=${attempt}: ${detail}`
        failures.push(failure)
        console.warn(`[artifact] ${failure}`)
      }
    }
  }
  throw new Error(
    `artifact download failed (${artifact.filename || artifact.sha256}): ${failures.join('; ')}`,
  )
}

async function ensureArtifact(destination, artifact, options = {}) {
  options.signal?.throwIfAborted()
  validateArtifact(artifact)
  const environment = options.environment || process.env
  if (await matches(destination, artifact, options.signal)) {
    const cache = path.join(artifactCache(environment, options.platform), artifact.sha256)
    if (!await matches(cache, artifact, options.signal)) await copyVerified(destination, cache, artifact, options.signal)
    return destination
  }
  const root = artifactCache(environment, options.platform)
  fs.mkdirSync(root, { recursive: true, mode: DIRECTORY_MODE })
  const cache = path.join(root, artifact.sha256)
  if (!await matches(cache, artifact, options.signal)) await downloadSources(cache, artifact, environment, options)
  await copyVerified(cache, destination, artifact, options.signal)
  return destination
}

module.exports = { artifactCache, digest, ensureArtifact, matches, validateArtifact }
