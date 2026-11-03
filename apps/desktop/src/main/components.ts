// Component delivery is independent of Velopack's application delta/full cache.
// The helper remains the authority for extraction and pinned-file verification.
import { ComponentTimer, COMPONENT_TIMING } from './timing.ts'
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { lstat, open, rename, rm, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import {
  COMPONENT_RECEIPT_FILENAME,
  RUNTIME_MANIFEST_LIMIT,
  validateRuntimeManifest,
  type RuntimeComponent,
  type RuntimeManifest,
} from '../../runtime/components.cjs'
import type { DomainNative } from '../../native/domains.cjs'
import { VELOPACK_POLICY, type PackageKeys } from './nupkg.ts'
import { validatedToolPrincipal } from './transfer.ts'

export const COMPONENT_DELIVERY = Object.freeze({
  archives: '.archives',
  runtime: 'runtime',
  manifest: 'resources/components/runtime.json',
  packageManifest: 'lib/app/resources/components/runtime.json',
  receiptBytes: 4096,
  accessPolicy: 1,
  timeout: 30 * 60_000,
  redirects: 3,
  reserveBytes: 64 * 1024 ** 2,
  temporarySuffix: '.part-000000000000',
})
const KEY_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
export interface ComponentProgress {
  kind: string
  phase: 'checking' | 'downloading' | 'verifying'
  received: number
  total: number
}
export interface ComponentDeliveryOptions {
  root: string
  native: Pick<DomainNative, 'pin' | 'pinChild' | 'createChild' | 'release'>
  baseUrl: string
  manifest: RuntimeManifest
  signal?: AbortSignal
  onProgress?: (progress: ComponentProgress) => void
  log?: (message: string) => void
}
export interface WindowsComponentDeliveryOptions extends ComponentDeliveryOptions {
  native: Required<ComponentDeliveryOptions['native']>
}
function windowsComponentDelivery(
  options: ComponentDeliveryOptions
): WindowsComponentDeliveryOptions {
  if (typeof options.native.pinChild !== 'function')
    throw new Error('Windows component delivery requires native child directory pins')
  return options as WindowsComponentDeliveryOptions
}
function canonicalBase64(value: unknown, maximum: number): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > maximum)
    throw new Error('Invalid runtime envelope encoding')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Invalid runtime envelope encoding')
  return bytes
}
export function verifyRuntimeEnvelope(envelope: unknown, keys: PackageKeys): RuntimeManifest {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    throw new Error('Invalid runtime envelope')
  const value = envelope as Record<string, unknown>
  if (value.schema !== 1 || typeof value.key_id !== 'string' || !Object.hasOwn(keys, value.key_id))
    throw new Error('Runtime signing key is not trusted')
  const bytes = canonicalBase64(value.manifest, Math.ceil((RUNTIME_MANIFEST_LIMIT * 4) / 3))
  const signature = canonicalBase64(value.signature, 88)
  const rawKey = canonicalBase64(keys[value.key_id], 44)
  if (bytes.length > RUNTIME_MANIFEST_LIMIT || rawKey.length !== 32 || signature.length !== 64)
    throw new Error('Invalid runtime signature encoding')
  const key = createPublicKey({
    key: Buffer.concat([KEY_PREFIX, rawKey]),
    format: 'der',
    type: 'spki',
  })
  if (!verify(null, bytes, key, signature)) throw new Error('Runtime signature is invalid')
  return parseRuntimeBytes(bytes)
}
function parseRuntimeBytes(bytes: Buffer): RuntimeManifest {
  const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!validateRuntimeManifest(manifest)) throw new Error('Invalid runtime manifest')
  let expanded = 0
  for (const component of manifest.components) {
    if (
      component.archiveBytes > VELOPACK_POLICY.packageBytes ||
      component.fileCount > VELOPACK_POLICY.entries
    )
      throw new Error('Runtime component exceeds limits')
    expanded += component.expandedBytes
  }
  if (!Number.isSafeInteger(expanded) || expanded > VELOPACK_POLICY.expandedBytes)
    throw new Error('Expanded runtime exceeds limit')
  return manifest
}
async function boundedFile(filename: string, maximum: number): Promise<Buffer> {
  const file = await open(filename, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > maximum)
      throw new Error('Runtime metadata exceeds limit')
    const bytes = Buffer.alloc(metadata.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== metadata.size) throw new Error('Runtime metadata changed while reading')
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}
export async function installedRuntimeManifest(
  application: string,
  keys: PackageKeys,
  policy?: { releaseLane: string; runtimeManifestSha256?: string }
): Promise<RuntimeManifest> {
  const filename = join(application, COMPONENT_DELIVERY.manifest)
  await checkLineage(filename)
  const raw = await boundedFile(filename, RUNTIME_MANIFEST_LIMIT)
  const envelope = JSON.parse(raw.toString('utf8'))
  const frozen = policy?.runtimeManifestSha256
  if (frozen && createHash('sha256').update(raw).digest('hex') !== frozen)
    throw new Error('Installed runtime manifest differs from frozen build')
  if (
    policy?.releaseLane === 'local' &&
    frozen &&
    /^[a-f0-9]{64}$/.test(frozen) &&
    envelope?.schema === 1 &&
    envelope.key_id === '' &&
    envelope.signature === ''
  ) {
    // Unsigned local builds use the same exact-byte binding compiled into their
    // helper. This path never authenticates downloaded update metadata.
    const bytes = canonicalBase64(envelope.manifest, Math.ceil((RUNTIME_MANIFEST_LIMIT * 4) / 3))
    if (bytes.length > RUNTIME_MANIFEST_LIMIT) throw new Error('Runtime manifest exceeds limit')
    return parseRuntimeBytes(bytes)
  }
  return verifyRuntimeEnvelope(envelope, keys)
}
/** Refuse symbolic/junction ancestors before writes. The native helper pins the
 * same lineage and files again before trusting any prepared component. */
async function checkLineage(filename: string): Promise<void> {
  if (!isAbsolute(filename)) throw new Error('Absolute runtime path required')
  const root = parse(filename).root
  let cursor = filename
  for (;;) {
    try {
      const metadata = await lstat(cursor)
      if (metadata.isSymbolicLink()) throw new Error('Runtime path redirects through a link')
      if (cursor !== filename && !metadata.isDirectory())
        throw new Error('Runtime ancestor is not a directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (cursor === root) break
    cursor = dirname(cursor)
  }
}
export function componentArchivePath(root: string, component: RuntimeComponent): string {
  return join(
    root,
    COMPONENT_DELIVERY.runtime,
    COMPONENT_DELIVERY.archives,
    `${component.kind}-${component.version}.zip`
  )
}
export function verifyComponentPaths(root: string, manifest: RuntimeManifest): void {
  if (!isAbsolute(root)) throw new Error('Absolute runtime root required')
  for (const component of manifest.components) {
    const directory = join(root, COMPONENT_DELIVERY.runtime, component.kind, component.version)
    const paths = [
      componentArchivePath(root, component) + COMPONENT_DELIVERY.temporarySuffix,
      join(directory, COMPONENT_RECEIPT_FILENAME),
      join(
        root,
        COMPONENT_DELIVERY.runtime,
        component.kind,
        '.prepare-0000000000',
        COMPONENT_RECEIPT_FILENAME
      ),
      ...component.files.flatMap((file) => [
        join(directory, file.path),
        join(root, COMPONENT_DELIVERY.runtime, component.kind, '.prepare-0000000000', file.path),
      ]),
    ]
    if (paths.some((path) => path.length > VELOPACK_POLICY.pathCharacters))
      throw new Error(
        `Runtime component path exceeds Windows compatibility limit: ${component.kind}`
      )
  }
}
async function hashComponentFile(
  filename: string,
  expectedSize: number,
  signal?: AbortSignal,
  timing?: ComponentTimer
): Promise<{ size: number; sha256: string }> {
  let end = timing?.start(COMPONENT_TIMING.open)
  const file = await open(filename, 'r')
  end?.()
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size !== expectedSize)
      throw new Error('Runtime file size differs')
    const hash = createHash('sha256')
    let size = 0
    end = timing?.start(COMPONENT_TIMING.read)
    for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
      end?.()
      size += chunk.length
      if (size > expectedSize) throw new Error('Runtime file exceeds signed size')
      end = timing?.start(COMPONENT_TIMING.hash)
      hash.update(chunk)
      end?.()
      if (timing) timing.event.bytes += chunk.length
      end = timing?.start(COMPONENT_TIMING.read)
    }
    end?.()
    return { size, sha256: hash.digest('hex') }
  } finally {
    end = timing?.start(COMPONENT_TIMING.close)
    try {
      await file.close()
    } finally {
      end?.()
    }
  }
}
export async function reusableComponent(
  root: string,
  manifest: RuntimeManifest,
  component: RuntimeComponent,
  signal?: AbortSignal,
  timing?: ComponentTimer
): Promise<boolean> {
  let end = timing?.start(COMPONENT_TIMING.lineage)
  const directory = join(root, COMPONENT_DELIVERY.runtime, component.kind, component.version)
  await checkLineage(directory)
  try {
    await lstat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  end?.()
  end = timing?.start(COMPONENT_TIMING.receipt)
  const receiptPath = join(directory, COMPONENT_RECEIPT_FILENAME)
  await checkLineage(receiptPath)
  const receipt = JSON.parse(
    (await boundedFile(receiptPath, COMPONENT_DELIVERY.receiptBytes)).toString('utf8')
  )
  end?.()
  end = timing?.start(COMPONENT_TIMING.inventory)
  const inventory = component.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
  const expected = {
    schema: 1,
    product_id: manifest.product_id,
    kind: component.kind,
    version: component.version,
    contentId: component.contentId,
    archiveSha256: component.archiveSha256,
    inventorySha256: createHash('sha256')
      .update(
        JSON.stringify(inventory).replace(
          /[&<>\u2028\u2029]/g,
          (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`
        )
      )
      .digest('hex'),
  }
  const permissionFields = ['python', 'texlive', 'powershell'].includes(component.kind)
    ? {
        accessPolicy: COMPONENT_DELIVERY.accessPolicy,
        principalSid: receipt?.principalSid,
        rootIdentity: receipt?.rootIdentity,
      }
    : {}
  if (
    'accessPolicy' in permissionFields &&
    (typeof permissionFields.principalSid !== 'string' ||
      validatedToolPrincipal(permissionFields.principalSid) !== permissionFields.principalSid ||
      typeof permissionFields.rootIdentity !== 'string' ||
      /^[a-f0-9]{8}:[a-f0-9]{16}$/.exec(permissionFields.rootIdentity)?.[0] !==
        permissionFields.rootIdentity)
  )
    throw new Error(`Existing runtime component permission receipt is invalid: ${component.kind}`)
  Object.assign(expected, permissionFields)
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Object.keys(receipt).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => receipt[key] !== value)
  )
    throw new Error(`Existing runtime component identity differs: ${component.kind}`)
  end?.()
  end = timing?.start(COMPONENT_TIMING.entry)
  const entry = component.entry.toLowerCase()
  const critical =
    component.files.find((file) => file.path.toLowerCase() === entry) ??
    component.files.find((file) => file.path.toLowerCase().startsWith(`${entry}/`))
  if (!critical) throw new Error('Runtime critical entry missing')
  const filename = join(directory, critical.path)
  await checkLineage(filename)
  if (!(await lstat(filename)).isFile()) throw new Error('Runtime critical entry is not a file')
  end?.()
  const actual = await hashComponentFile(filename, critical.size, signal, timing)
  if (actual.size !== critical.size || actual.sha256 !== critical.sha256)
    throw new Error(`Existing runtime critical entry changed: ${component.kind}`)
  return true
}
export function componentDownloadUrl(
  baseUrl: string,
  manifest: RuntimeManifest,
  component: RuntimeComponent
): URL {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Runtime source must be HTTPS')
  return new URL(
    `${base.href.replace(/\/$/, '')}/api/v1/updates/components/${manifest.target}/${component.kind}/${component.version}/${component.archiveSha256}`
  )
}
async function componentResponse(url: URL, signal: AbortSignal): Promise<Response> {
  let current = url
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted()
    const response = await fetch(current, { signal, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(`Runtime download failed (${response.status})`)
      }
      return response
    }
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location || redirects >= COMPONENT_DELIVERY.redirects)
      throw new Error('Runtime download redirect limit')
    current = new URL(location, current)
    if (current.protocol !== 'https:' || current.username || current.password)
      throw new Error('Runtime download redirect must use HTTPS')
  }
}
async function retainedArchive(
  filename: string,
  component: RuntimeComponent,
  signal: AbortSignal
): Promise<boolean> {
  await checkLineage(filename)
  try {
    const metadata = await lstat(filename)
    if (!metadata.isFile()) throw new Error('Runtime archive is not a regular file')
    if (metadata.size !== component.archiveBytes) return false
    const actual = await hashComponentFile(filename, component.archiveBytes, signal)
    return actual.sha256 === component.archiveSha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function downloadComponent(
  options: ComponentDeliveryOptions,
  component: RuntimeComponent,
  signal: AbortSignal
): Promise<void> {
  const timing = new ComponentTimer(component, COMPONENT_TIMING.download, options.log)
  let failed = true
  try {
    const destination = componentArchivePath(options.root, component)
    await checkLineage(destination)
    // Existing bytes were authenticated under the retained directory pins. A
    // replacement after that read is still rejected by the helper's pinned read.
    let end = timing.start(COMPONENT_TIMING.archive)
    const retained = await retainedArchive(destination, component, signal)
    end()
    if (retained) {
      timing.event.status = COMPONENT_TIMING.retained
      failed = false
      return
    }
    await rm(destination, { force: true })
    const temporary = `${destination}.part-${randomBytes(6).toString('hex')}`
    end = timing.start(COMPONENT_TIMING.headers)
    const response = await componentResponse(
      componentDownloadUrl(options.baseUrl, options.manifest, component),
      signal
    )
    end()
    const declared = response.headers.get('content-length')
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) !== component.archiveBytes)
    ) {
      await response.body?.cancel()
      throw new Error('Runtime download length differs from signed manifest')
    }
    const hash = createHash('sha256')
    let size = 0
    const file = await open(temporary, 'wx').catch(async (error) => {
      await response.body?.cancel()
      throw error
    })
    try {
      end = timing.start(COMPONENT_TIMING.read)
      for await (const chunk of response.body!) {
        end()
        signal.throwIfAborted()
        size += chunk.length
        if (size > component.archiveBytes) throw new Error('Runtime download exceeds signed size')
        end = timing.start(COMPONENT_TIMING.hash)
        hash.update(chunk)
        end()
        timing.event.bytes += chunk.length
        let offset = 0
        while (offset < chunk.length) {
          end = timing.start(COMPONENT_TIMING.write)
          const result = await file.write(chunk, offset, chunk.length - offset)
          end()
          if (!result.bytesWritten) throw new Error('Runtime archive write made no progress')
          offset += result.bytesWritten
        }
        options.onProgress?.({
          kind: component.kind,
          phase: 'downloading',
          received: size,
          total: component.archiveBytes,
        })
        end = timing.start(COMPONENT_TIMING.read)
      }
      end()
      if (size !== component.archiveBytes || hash.digest('hex') !== component.archiveSha256)
        throw new Error('Runtime download digest differs from signed manifest')
      signal.throwIfAborted()
      end = timing.start(COMPONENT_TIMING.sync)
      await file.sync()
      end()
      await file.close()
      end = timing.start(COMPONENT_TIMING.publish)
      await checkLineage(destination)
      await rename(temporary, destination)
      end()
    } finally {
      await file.close()
      await rm(temporary, { force: true })
    }
    failed = false
  } finally {
    timing.finish(failed)
  }
}
/** Downloads all missing archives before update quiescence or initial backend
 * launch. Existing usable components require neither archive reads nor network. */
export async function downloadRuntimeComponents(options: ComponentDeliveryOptions): Promise<void> {
  const paths = new ComponentTimer(
    { kind: COMPONENT_TIMING.runtime, version: options.manifest.target },
    COMPONENT_TIMING.paths,
    options.log
  )
  let pathFailure = true
  try {
    verifyComponentPaths(options.root, options.manifest)
    pathFailure = false
  } finally {
    paths.finish(pathFailure)
  }
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(COMPONENT_DELIVERY.timeout),
  ])
  const missing: RuntimeComponent[] = []
  for (const component of options.manifest.components) {
    signal.throwIfAborted()
    options.onProgress?.({
      kind: component.kind,
      phase: 'checking',
      received: 0,
      total: component.archiveBytes,
    })
    const timing = new ComponentTimer(component, COMPONENT_TIMING.reuse, options.log)
    let failed = true
    try {
      const end = timing.start(COMPONENT_TIMING.reuse)
      const reused = await reusableComponent(
        options.root,
        options.manifest,
        component,
        signal,
        timing
      )
      end()
      if (!reused) missing.push(component)
      else timing.event.status = COMPONENT_TIMING.reused
      failed = false
    } finally {
      timing.finish(failed)
    }
  }
  if (!missing.length) return
  // Windows native pins retain every physical ancestor without deletion
  // sharing. Create one child under a pinned parent and keep the capabilities
  // across all awaits, including partial-file cleanup; lstat alone cannot do so.
  const pins: unknown[] = []
  try {
    const installation = process.platform === 'win32' ? windowsComponentDelivery(options) : null
    let directory = options.root
    let parent = installation
      ? installation.native.pin(directory, false, 'installation')
      : options.native.pin(directory, false)
    pins.push(parent)
    for (const name of [COMPONENT_DELIVERY.runtime, COMPONENT_DELIVERY.archives]) {
      options.native.createChild(parent, name)
      directory = join(directory, name)
      parent = installation
        ? installation.native.pinChild(parent, name)
        : options.native.pin(directory, false)
      pins.push(parent)
    }
    const pending: RuntimeComponent[] = []
    let required = BigInt(COMPONENT_DELIVERY.reserveBytes)
    for (const component of missing) {
      signal.throwIfAborted()
      required += BigInt(component.expandedBytes)
      const timing = new ComponentTimer(component, COMPONENT_TIMING.archive, options.log)
      let failed = true
      try {
        const end = timing.start(COMPONENT_TIMING.archive)
        const retained = await retainedArchive(
          componentArchivePath(options.root, component),
          component,
          signal
        )
        end()
        if (!retained) {
          required += BigInt(component.archiveBytes)
          pending.push(component)
        } else timing.event.status = COMPONENT_TIMING.retained
        failed = false
      } finally {
        timing.finish(failed)
      }
    }
    const space = await statfs(directory, { bigint: true })
    if (space.bavail * space.bsize < required)
      throw new Error('Insufficient disk space for runtime components')
    for (const component of pending) {
      signal.throwIfAborted()
      await downloadComponent(options, component, signal)
      options.onProgress?.({
        kind: component.kind,
        phase: 'verifying',
        received: component.archiveBytes,
        total: component.archiveBytes,
      })
    }
  } finally {
    // A failed release is not proof of closure. Native deliberately retains
    // remaining capabilities until process exit if this loop throws.
    while (pins.length) options.native.release(pins.pop())
  }
}
