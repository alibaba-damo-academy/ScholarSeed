import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const RESOURCE_DIRECTORY = 'chromium'
const MANIFEST_FILE = 'manifest.json'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const RESOURCE_PATH_PATTERN = /^[^\\:\0]+$/

type ChromiumPlatform = 'darwin' | 'win32'
type ChromiumArch = 'arm64' | 'x64'

interface ChromiumResourceFile {
  path: string
  size: number
  sha256: string
}

interface ChromiumResourceLink {
  kind: 'symlink'
  path: string
  target: string
}

interface ChromiumResourceManifest {
  schemaVersion: number
  platform: ChromiumPlatform
  arch: ChromiumArch
  executable: string
  provenance: {
    product: string
    version: string
    sourceUrl: string
    licenseSpdx: string
    licenseUrl: string
  }
  files: (ChromiumResourceFile | ChromiumResourceLink)[]
  signature: {
    algorithm: 'ed25519'
    keyId: string
    value: string
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Chromium resource manifest')
  return value as Record<string, unknown>
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function safeResourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || !RESOURCE_PATH_PATTERN.test(value) || value.startsWith('/')) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function safeLinkTarget(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && RESOURCE_PATH_PATTERN.test(value) && !value.startsWith('/') &&
    value.split('/').every(segment => segment.length > 0 && segment !== '.')
}

function validHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

function validateManifest(value: unknown): ChromiumResourceManifest {
  const manifest = record(value)
  if (!hasExactKeys(manifest, ['schemaVersion', 'platform', 'arch', 'executable', 'provenance', 'files', 'signature']) || manifest.schemaVersion !== 1) {
    throw new Error('Invalid Chromium resource manifest schema')
  }
  if (!safeResourcePath(manifest.executable) || manifest.executable === MANIFEST_FILE) throw new Error('Invalid Chromium executable path')
  const provenance = record(manifest.provenance)
  if (!hasExactKeys(provenance, ['product', 'version', 'sourceUrl', 'licenseSpdx', 'licenseUrl']) ||
      ![provenance.product, provenance.version, provenance.licenseSpdx].every(field => typeof field === 'string' && field.trim().length > 0) ||
      !validHttpsUrl(provenance.sourceUrl) || !validHttpsUrl(provenance.licenseUrl)) {
    throw new Error('Invalid Chromium resource provenance')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Invalid Chromium resource files')
  const paths = new Set<string>()
  for (const entry of manifest.files) {
    const file = record(entry)
    if (!safeResourcePath(file.path) || file.path === MANIFEST_FILE) throw new Error('Invalid Chromium resource path')
    if (file.kind === 'symlink') {
      if (!hasExactKeys(file, ['kind', 'path', 'target']) || !safeLinkTarget(file.target)) throw new Error('Invalid Chromium resource symlink')
    } else if (!hasExactKeys(file, ['path', 'size', 'sha256']) ||
        !Number.isSafeInteger(file.size) || (file.size as number) < 0 || typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error('Invalid Chromium resource file path, size or hash')
    }
    if (paths.has(file.path)) throw new Error('Duplicate Chromium resource path')
    paths.add(file.path)
  }
  if (!paths.has(manifest.executable as string) || manifest.files.find(file => file.path === manifest.executable && 'kind' in file)) {
    throw new Error('Chromium executable must be a regular inventoried file')
  }
  const signature = record(manifest.signature)
  if (!hasExactKeys(signature, ['algorithm', 'keyId', 'value']) || signature.algorithm !== 'ed25519' ||
      typeof signature.keyId !== 'string' || !signature.keyId || typeof signature.value !== 'string' ||
      !BASE64_PATTERN.test(signature.value) || Buffer.from(signature.value, 'base64').length !== 64) {
    throw new Error('Invalid Chromium resource signature')
  }
  return value as ChromiumResourceManifest
}

export function manifestSigningPayload<T extends object>(manifest: T): Buffer {
  const { signature, ...signed } = manifest as T & { signature?: unknown }
  const { value: _value, ...signer } = record(signature)
  return Buffer.from(JSON.stringify({ ...signed, signature: signer }), 'utf8')
}

async function inventory(root: string, directory = ''): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const name = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) files.push(name)
    else if (entry.isDirectory()) files.push(...await inventory(root, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Unsupported Chromium resource type: ${name}`)
  }
  return files
}

export async function verifyChromiumResources(
  resourcesPath: string,
  platform: NodeJS.Platform,
  arch: string,
  trustedSigningKeys: Readonly<Record<string, string>>
): Promise<string> {
  if (!isAbsolute(resourcesPath)) throw new Error('Chromium resources path must be absolute')
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('Unsupported Chromium platform')
  if (arch !== 'x64' && !(platform === 'darwin' && arch === 'arm64')) throw new Error('Unsupported Chromium architecture')
  const root = join(resourcesPath, RESOURCE_DIRECTORY)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('Chromium resource root must be a real directory')
  const canonicalRoot = await realpath(root)
  const manifestMetadata = await lstat(join(root, MANIFEST_FILE))
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) throw new Error('Chromium resource manifest must be a regular file')
  const manifest = validateManifest(JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8')))
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error('Chromium resource platform or architecture mismatch')
  if (platform === 'win32' && !manifest.executable.toLowerCase().endsWith('.exe')) throw new Error('Windows Chromium executable must end with .exe')
  const trustedKey = Object.hasOwn(trustedSigningKeys, manifest.signature.keyId) ? trustedSigningKeys[manifest.signature.keyId] : undefined
  if (!trustedKey) throw new Error('No trusted signing key for Chromium resources')
  const publicKey = createPublicKey(trustedKey)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Chromium resource signing key must be Ed25519')
  if (!verify(null, manifestSigningPayload(manifest), publicKey, Buffer.from(manifest.signature.value, 'base64'))) {
    throw new Error('Chromium resource manifest signature verification failed')
  }
  const listed = new Set(manifest.files.map(file => file.path))
  for (const path of await inventory(root)) {
    if (path !== MANIFEST_FILE && !listed.has(path)) throw new Error(`Unlisted Chromium resource: ${path}`)
  }
  for (const file of manifest.files) {
    const absolute = join(root, ...file.path.split('/'))
    const inRoot = relative(root, absolute)
    if (!inRoot || inRoot === '..' || inRoot.startsWith(`..${sep}`) || isAbsolute(inRoot)) throw new Error('Invalid Chromium resource path')
    const metadata = await lstat(absolute)
    if ('kind' in file) {
      if (platform !== 'darwin' || !metadata.isSymbolicLink()) throw new Error(`Chromium resource symlink is unsupported: ${file.path}`)
      if (await readlink(absolute) !== file.target) throw new Error(`Chromium resource symlink target mismatch: ${file.path}`)
      const target = resolve(dirname(absolute), ...file.target.split('/'))
      const relativeTarget = relative(root, target)
      if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
        throw new Error(`Chromium resource symlink escapes root: ${file.path}`)
      }
      const resolvedTarget = await realpath(absolute)
      const relativeResolved = relative(canonicalRoot, resolvedTarget)
      if (!relativeResolved || relativeResolved === '..' || relativeResolved.startsWith(`..${sep}`) || isAbsolute(relativeResolved)) {
        throw new Error(`Chromium resource symlink escapes root: ${file.path}`)
      }
      continue
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Chromium resource must be a regular file: ${file.path}`)
    if (metadata.size !== file.size) throw new Error(`Chromium resource size mismatch: ${file.path}`)
    const canonicalFile = await realpath(absolute)
    const relativeCanonical = relative(canonicalRoot, canonicalFile)
    if (!relativeCanonical || relativeCanonical === '..' || relativeCanonical.startsWith(`..${sep}`) || isAbsolute(relativeCanonical)) {
      throw new Error(`Chromium resource file escapes root: ${file.path}`)
    }
    if (platform === 'win32' && relativeCanonical.toLowerCase() !== file.path.split('/').join(sep).toLowerCase()) {
      throw new Error(`Chromium resource reparse path is unsupported: ${file.path}`)
    }
    const handle = await open(canonicalFile, constants.O_RDONLY | (platform === 'darwin' ? constants.O_NOFOLLOW : 0))
    let hash: string
    try {
      const openedMetadata = await handle.stat()
      if (!openedMetadata.isFile() || openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino || openedMetadata.size !== metadata.size) {
        throw new Error(`Chromium resource changed during validation: ${file.path}`)
      }
      hash = createHash('sha256').update(await handle.readFile()).digest('hex')
      const finalMetadata = await handle.stat()
      if (finalMetadata.size !== metadata.size || finalMetadata.mtimeMs !== openedMetadata.mtimeMs) {
        throw new Error(`Chromium resource changed during validation: ${file.path}`)
      }
    } finally { await handle.close() }
    if (hash !== file.sha256) throw new Error(`Chromium resource hash mismatch: ${file.path}`)
  }
  const executable = join(root, ...manifest.executable.split('/'))
  if (platform !== 'win32' && !((await lstat(executable)).mode & 0o111)) throw new Error('Chromium executable is not executable')
  return executable
}
