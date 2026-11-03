// Authentication and path policy for Velopack packages; independent of Electron.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { win32 } from 'node:path'
import { openPromise, type Entry, type ZipFile } from 'yauzl'
import type { LatestVersionMeta } from '../updates.ts'

export const VELOPACK_POLICY = Object.freeze({
  schema: 1,
  domain: 'scholarseed.velopack-release',
  arch: 'windows-amd64',
  manifestBytes: 32 * 1024 * 1024,
  pathCharacters: 259,
  componentCharacters: 255,
  entries: 500_000,
  packageBytes: 32 * 1024 ** 3,
  expandedBytes: 128 * 1024 ** 3,
  sha256: /^[a-f0-9]{64}$/i,
  fileName: /^[A-Za-z0-9][A-Za-z0-9._-]*\.nupkg$/,
  appId: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  appPrefix: 'lib/app/',
})
const KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
const UNIX_TYPE_MASK = 0xf000
const UNIX_REGULAR = 0x8000
const UNIX_DIRECTORY = 0x4000

export interface PackageAsset {
  FileName: string
  Version: string
  Type: 'Full' | 'Delta'
  Size: number
  SHA256: string
}
export interface PackageMember {
  path: string
  size: number
  sha256: string
}
export interface PackageManifest {
  schema: number
  domain: string
  product_id: string
  bundle_id: string
  arch_type: string
  channel: string
  version: string
  build_number: string
  pack_version: string
  app_id: string
  base_version: string | null
  assets: PackageAsset[]
  files: PackageMember[]
}
export interface PackageIdentity {
  product_id: string
  bundle_id: string
  arch_type: string
  channel: string
  app_id: string
}
export type PackageKeys = Readonly<Record<string, string>>
function fail(message: string): never {
  throw new Error(`Velopack: ${message}`)
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid release object')
  return value as Record<string, unknown>
}
function base64(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length > max || !value.length) fail('invalid base64')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) fail('noncanonical base64')
  return bytes
}
export function parsePackageKeys(value: unknown): PackageKeys {
  if (value === undefined) return Object.freeze({})
  const entries = Object.entries(record(value))
  if (entries.length > 8) fail('too many release signing keys')
  const keys: Record<string, string> = Object.create(null)
  for (const [id, encoded] of entries) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || base64(encoded, 44).length !== 32)
      fail('invalid release signing key')
    keys[id] = encoded as string
  }
  return Object.freeze(keys)
}
export function packagePath(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /[\x00-\x1f\x7f:<>"|?*]/.test(value)
  )
    fail(`unsafe member: ${value}`)
  for (const part of value.split('/')) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[. ]$/.test(part) ||
      WINDOWS_DEVICE.test(part) ||
      part.length > VELOPACK_POLICY.componentCharacters
    )
      fail(`unsafe member: ${value}`)
  }
  return value
}
/** Packages belong to the installation and are removed by Velopack uninstall. */
export function updateCacheDirectory(installation: string): string {
  if (!win32.isAbsolute(installation)) fail('invalid update cache root')
  return win32.join(installation, 'packages')
}

/** Matches Update.exe patch's own locator, which does not inherit the SDK locator. */
export function patchDirectory(
  installationRoot: string,
  updaterPath: string,
  staging: string,
  temporaryRoot: string
): string {
  return win32.normalize(win32.dirname(updaterPath)).toLowerCase() ===
    win32.normalize(installationRoot).toLowerCase()
    ? staging
    : win32.join(temporaryRoot, 'velopack_0000000000000000')
}

export function assertWindowsPath(root: string, relative: string): void {
  packagePath(relative)
  const absolute = win32.join(root, relative)
  const maximum = VELOPACK_POLICY.pathCharacters
  if (!win32.isAbsolute(root) || absolute.length > maximum)
    fail(`Velopack application path exceeds Windows compatibility limit: ${absolute}`)
}
/** Full apply strips lib/app; patching expands entire archives in deeper directories. */
export function verifyApplicationPaths(manifest: PackageManifest, roots: string[]): void {
  if (!manifest.files.some((member) => member.path.startsWith(VELOPACK_POLICY.appPrefix)))
    fail('package has no lib/app application members')
  for (const member of manifest.files) {
    if (
      member.path.toLowerCase().startsWith('lib/') &&
      !member.path.startsWith(VELOPACK_POLICY.appPrefix)
    )
      fail('unsupported application member prefix')
    if (!member.path.startsWith(VELOPACK_POLICY.appPrefix)) continue
    for (const root of roots)
      assertWindowsPath(root, member.path.slice(VELOPACK_POLICY.appPrefix.length))
  }
}

export function verifyPackageEnvelope(
  envelope: unknown,
  keys: PackageKeys,
  identity: PackageIdentity,
  candidate?: LatestVersionMeta
): PackageManifest {
  const outer = record(envelope)
  if (
    outer.schema !== VELOPACK_POLICY.schema ||
    typeof outer.key_id !== 'string' ||
    !Object.hasOwn(keys, outer.key_id)
  )
    fail('release signing key is not trusted')
  const bytes = base64(outer.manifest, Math.ceil((VELOPACK_POLICY.manifestBytes * 4) / 3))
  const signature = base64(outer.signature, 88)
  const key = createPublicKey({
    key: Buffer.concat([KEY_PREFIX, base64(keys[outer.key_id], 44)]),
    format: 'der',
    type: 'spki',
  })
  if (signature.length !== 64 || !verify(null, bytes, key, signature))
    fail('release signature is invalid')
  const data = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  if (data.schema !== VELOPACK_POLICY.schema || data.domain !== VELOPACK_POLICY.domain)
    fail('release domain differs')
  for (const field of ['product_id', 'bundle_id', 'arch_type', 'channel', 'app_id'] as const) {
    if (data[field] !== identity[field]) fail(`release ${field} differs`)
  }
  if (
    data.arch_type !== VELOPACK_POLICY.arch ||
    typeof data.app_id !== 'string' ||
    !VELOPACK_POLICY.appId.test(data.app_id)
  )
    fail('invalid application identity')
  if (
    typeof data.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(data.version) ||
    typeof data.build_number !== 'string' ||
    !/^\d{12}$/.test(data.build_number) ||
    data.pack_version !== `${data.version}-build.${data.build_number}`
  )
    fail('invalid package version')
  if (
    candidate &&
    (data.version !== candidate.version || data.build_number !== candidate.build_number)
  )
    fail('release candidate differs')
  if (
    data.base_version !== null &&
    (typeof data.base_version !== 'string' ||
      !/^\d+\.\d+\.\d+-build\.\d{12}$/.test(data.base_version))
  )
    fail('invalid delta base')
  if (!Array.isArray(data.assets) || data.assets.length < 1 || data.assets.length > 2)
    fail('invalid asset inventory')
  const assets = data.assets.map((value) => {
    const item = record(value)
    if (
      typeof item.FileName !== 'string' ||
      !VELOPACK_POLICY.fileName.test(item.FileName) ||
      item.Version !== data.pack_version ||
      !['Full', 'Delta'].includes(String(item.Type)) ||
      !Number.isSafeInteger(item.Size) ||
      Number(item.Size) <= 0 ||
      Number(item.Size) > VELOPACK_POLICY.packageBytes ||
      typeof item.SHA256 !== 'string' ||
      !VELOPACK_POLICY.sha256.test(item.SHA256)
    )
      fail('invalid asset')
    return item as unknown as PackageAsset
  })
  if (
    assets.filter((a) => a.Type === 'Full').length !== 1 ||
    assets.filter((a) => a.Type === 'Delta').length > 1 ||
    new Set(assets.map((a) => a.FileName.toLowerCase())).size !== assets.length ||
    (assets.some((a) => a.Type === 'Delta') && !data.base_version)
  )
    fail('ambiguous release assets')
  if (
    !Array.isArray(data.files) ||
    !data.files.length ||
    data.files.length > VELOPACK_POLICY.entries
  )
    fail('invalid package member inventory')
  const names = new Set<string>()
  let expanded = 0
  const files = data.files.map((value) => {
    const item = record(value)
    if (
      typeof item.path !== 'string' ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) < 0 ||
      typeof item.sha256 !== 'string' ||
      !VELOPACK_POLICY.sha256.test(item.sha256)
    )
      fail('invalid package member')
    packagePath(item.path)
    const folded = item.path.toLowerCase()
    if (names.has(folded)) fail('case-colliding package members')
    names.add(folded)
    expanded += Number(item.size)
    return item as unknown as PackageMember
  })
  if (expanded > VELOPACK_POLICY.expandedBytes) fail('expanded package exceeds limit')
  for (const name of names) {
    const parts = name.split('/')
    parts.pop()
    while (parts.length) {
      if (names.has(parts.join('/'))) fail('file/directory member collision')
      parts.pop()
    }
  }
  const manifest = { ...data, assets, files } as unknown as PackageManifest
  verifyApplicationPaths(manifest, [])
  return manifest
}

export function assertNewerPackage(target: string, current: string): void {
  const pattern = /^(\d+)\.(\d+)\.(\d+)-build\.(\d{12})$/
  const a = pattern.exec(target),
    b = pattern.exec(current)
  if (!a || !b) fail('invalid installed or target package version')
  for (let index = 1; index <= 4; index++) {
    if (BigInt(a[index]) > BigInt(b[index])) return
    if (BigInt(a[index]) < BigInt(b[index])) fail('package downgrade is forbidden')
  }
  fail('package is already installed')
}

export async function hashPackage(
  path: string,
  signal?: AbortSignal
): Promise<{ size: number; sha256: string }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path, { signal })) {
    size += chunk.length
    hash.update(chunk)
  }
  return { size, sha256: hash.digest('hex') }
}
export async function verifyPackageAsset(
  path: string,
  asset: PackageAsset,
  signal?: AbortSignal
): Promise<void> {
  const actual = await hashPackage(path, signal)
  if (actual.size !== asset.Size || actual.sha256 !== asset.SHA256.toLowerCase())
    fail(`asset digest differs: ${asset.FileName}`)
}
async function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', entry)
      zip.off('end', end)
      zip.off('error', error)
    }
    const entry = (value: Entry) => {
      cleanup()
      resolve(value)
    }
    const end = () => {
      cleanup()
      resolve(null)
    }
    const error = (value: Error) => {
      cleanup()
      reject(value)
    }
    zip.once('entry', entry)
    zip.once('end', end)
    zip.once('error', error)
    zip.readEntry()
  })
}
async function walkPackage(
  path: string,
  visit: (zip: ZipFile, entry: Entry, name: string, directory: boolean) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    autoClose: false,
    strictFileNames: true,
    validateEntrySizes: true,
  })
  const seen = new Set<string>()
  const files = new Set<string>()
  const parents = new Set<string>()
  let count = 0,
    expanded = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const entry = await nextEntry(zip)
      if (!entry) break
      const directory = entry.fileName.endsWith('/')
      const name = packagePath(directory ? entry.fileName.slice(0, -1) : entry.fileName)
      const folded = name.toLowerCase()
      const type = (entry.externalFileAttributes >>> 16) & UNIX_TYPE_MASK
      if (
        seen.has(folded) ||
        ++count > VELOPACK_POLICY.entries ||
        entry.isEncrypted() ||
        (type && type !== (directory ? UNIX_DIRECTORY : UNIX_REGULAR))
      )
        fail(`unsafe ZIP entry: ${name}`)
      if (!directory && parents.has(folded)) fail(`ZIP file/directory collision: ${name}`)
      const ancestors = folded.split('/')
      ancestors.pop()
      while (ancestors.length) {
        const ancestor = ancestors.join('/')
        if (files.has(ancestor)) fail(`ZIP file/directory collision: ${name}`)
        parents.add(ancestor)
        ancestors.pop()
      }
      seen.add(folded)
      if (!directory) files.add(folded)
      expanded += entry.uncompressedSize
      if (expanded > VELOPACK_POLICY.expandedBytes) fail('expanded ZIP exceeds limit')
      const local = await zip.readLocalFileHeaderPromise(entry)
      if (
        !local.fileName.equals(Buffer.from(entry.fileName, 'utf8')) ||
        local.compressionMethod !== entry.compressionMethod ||
        local.generalPurposeBitFlag !== entry.generalPurposeBitFlag
      )
        fail('ZIP local and central records disagree')
      await visit(zip, entry, name, directory)
    }
  } finally {
    zip.close()
  }
}
/** Called only after authenticating the delta asset, before the official patcher runs. */
export async function verifyDeltaPackagePaths(
  path: string,
  roots: string[],
  signal?: AbortSignal
): Promise<void> {
  await walkPackage(
    path,
    async (_zip, _entry, name) => {
      for (const root of roots) {
        assertWindowsPath(win32.join(root, 'delta_0'), name)
        const output = name.replace(/\.(zsdiff|diff|bsdiff)$/, '')
        assertWindowsPath(win32.join(root, '_work'), output)
      }
    },
    signal
  )
}

export async function verifyPackageInventory(
  path: string,
  manifest: PackageManifest,
  roots: string[],
  signal?: AbortSignal
): Promise<void> {
  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  await walkPackage(
    path,
    async (zip, entry, name, directory) => {
      // vpk extracts only lib/app into current; its patcher also expands complete packages.
      for (const root of roots) assertWindowsPath(root, name)
      if (directory) return
      const item = expected.get(name)
      if (!item || item.size !== entry.uncompressedSize) fail(`unexpected package member: ${name}`)
      const hash = createHash('sha256')
      const stream = await zip.openReadStreamPromise(entry)
      for await (const chunk of stream) {
        signal?.throwIfAborted()
        hash.update(chunk)
      }
      if (hash.digest('hex') !== item.sha256.toLowerCase())
        fail(`package member digest differs: ${name}`)
      expected.delete(name)
    },
    signal
  )
  if (expected.size) fail('package is missing signed members')
}

/** Read one bounded signed member without extracting an application tree. The
 * caller has already verified the full inventory; bind these bytes again to
 * the same manifest so a changed local package cannot supply new metadata. */
export async function readPackageMember(
  path: string,
  manifest: PackageManifest,
  member: string,
  maximum: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const expected = manifest.files.find((file) => file.path === member)
  if (!expected || expected.size > maximum) fail('required package metadata missing or oversized')
  let result: Buffer | undefined
  await walkPackage(
    path,
    async (zip, entry, name, directory) => {
      if (directory || name !== member) return
      if (entry.uncompressedSize !== expected.size) fail('package metadata size differs')
      const chunks: Buffer[] = []
      let size = 0
      const stream = await zip.openReadStreamPromise(entry)
      for await (const chunk of stream) {
        signal?.throwIfAborted()
        size += chunk.length
        if (size > expected.size) fail('package metadata exceeds signed size')
        chunks.push(Buffer.from(chunk))
      }
      result = Buffer.concat(chunks)
      if (
        size !== expected.size ||
        createHash('sha256').update(result).digest('hex') !== expected.sha256.toLowerCase()
      )
        fail('package metadata digest differs')
    },
    signal
  )
  if (!result) fail('required package metadata missing')
  return result
}
