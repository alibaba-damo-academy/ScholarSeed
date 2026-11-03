// Windows only. Velopack owns patching/replacement; the native handoff owns restart.
import {
  VelopackApp,
  UpdateManager,
  FileSource,
  type VelopackAsset,
  type UpdateInfo,
  type VelopackLocatorConfig,
} from 'velopack'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { app } from 'electron'
import { applicationResources } from './resources.ts'
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  prepareWindowsToolGroup,
  prepareWindowsTransfer,
  type WindowsTransfer,
} from './transfer.ts'
import {
  COMPONENT_DELIVERY,
  downloadRuntimeComponents,
  verifyRuntimeEnvelope,
} from './components.ts'
import { RUNTIME_MANIFEST_LIMIT } from '../../runtime/components.cjs'
import type { DomainNative } from '../../native/domains.cjs'
import type { LatestVersionMeta } from '../updates.ts'
import type { HandoffAuthorization } from './update-authorization.ts'
import {
  VELOPACK_POLICY,
  assertNewerPackage,
  updateCacheDirectory,
  patchDirectory,
  assertWindowsPath,
  verifyPackageEnvelope,
  verifyPackageAsset,
  verifyPackageInventory,
  readPackageMember,
  verifyApplicationPaths,
  verifyDeltaPackagePaths,
  type PackageAsset,
  type PackageManifest,
  type PackageKeys,
  type PackageIdentity,
} from './nupkg.ts'

const POLICY = Object.freeze({
  updater: 'Update.exe',
  nuspec: 'sq.version',
  receipt: 'scholarseed-release.json',
  packages: 'packages',
  source: 'verified-',
  staging: 'VelopackTemp',
  stagingLeaf: 'tmp_0000000000000000',
  timeout: 30 * 60_000,
  maximumDeltas: 1,
})
let initialized = false
export function initializeWindowsVelopack(): void {
  if (process.platform !== 'win32' || initialized) return
  const startup = VelopackApp.build().setAutoApplyOnStartup(false)
  if (app.isPackaged) startup.setLocator(installedLocator())
  startup.run()
  initialized = true
}
// index.ts imports this module first: installer hooks run before normal app state.
initializeWindowsVelopack()
export interface PrepareWindowsVelopackOptions {
  /** Pinned published release directory, ending in /velopack (not a moving latest feed). */
  baseUrl: string
  componentBaseUrl: string
  native: DomainNative
  candidate: LatestVersionMeta
  keys: PackageKeys
  appId: string
  diagnosticFile: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}
export interface PreparedWindowsVelopack {
  packagePath: string
  manifest: PackageManifest
  lock(restartArgs: string[], signal?: AbortSignal): Promise<void>
  verify(): Promise<void>
  /** Acquire authorization after UAC; after commit the caller must quit. */
  apply(authorize: HandoffAuthorization): Promise<void>
  close(): Promise<void>
}
function officialAsset(asset: PackageAsset, appId: string): VelopackAsset {
  return { ...asset, PackageId: appId, SHA1: '', NotesMarkdown: '', NotesHtml: '' }
}
function installedLocator(): VelopackLocatorConfig {
  const current = dirname(applicationResources(app))
  const root = realpathSync(dirname(current))
  return {
    RootAppDir: root,
    CurrentBinaryDir: current,
    PackagesDir: join(root, POLICY.packages),
    UpdateExePath: join(root, POLICY.updater),
    ManifestPath: join(current, POLICY.nuspec),
    IsPortable: false,
  }
}
async function locator(): Promise<VelopackLocatorConfig> {
  const installed = installedLocator()
  const cacheRoot = updateCacheDirectory(installed.RootAppDir)
  const packages = cacheRoot
  await mkdir(packages, { recursive: true })
  const updater = join(cacheRoot, POLICY.updater)
  // Do not execute an unverified stale cached updater left by an earlier download.
  await copyFile(installed.UpdateExePath, updater)
  return {
    ...installed,
    PackagesDir: packages,
    UpdateExePath: updater,
  }
}
async function responseBytes(url: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'error' })
  if (!response.ok || !response.body)
    throw new Error(`Velopack manifest request failed (${response.status})`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maximum) throw new Error('Velopack manifest exceeds size limit')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
async function downloadAsset(
  base: URL,
  asset: PackageAsset,
  directory: string,
  signal: AbortSignal,
  progress?: (percent: number) => void
): Promise<void> {
  const url = new URL(encodeURIComponent(asset.FileName), base)
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:')
    throw new Error(`Velopack asset request failed (${response.status})`)
  const destination = join(directory, asset.FileName)
  const file = await open(destination, 'wx')
  let size = 0
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted()
      size += chunk.length
      if (size > asset.Size) throw new Error('Velopack asset exceeds signed size')
      let offset = 0
      while (offset < chunk.length) {
        const result = await file.write(chunk, offset, chunk.length - offset)
        offset += result.bytesWritten
      }
      progress?.(Math.floor((size / asset.Size) * 100))
    }
  } finally {
    await file.close()
  }
  await verifyPackageAsset(destination, asset, signal)
}
async function writeReceipt(path: string, envelope: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}`
  try {
    await writeFile(temporary, JSON.stringify(envelope), { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function prepareWindowsVelopack(
  options: PrepareWindowsVelopackOptions
): Promise<PreparedWindowsVelopack> {
  if (process.platform !== 'win32') throw new Error('Velopack is Windows only')
  initializeWindowsVelopack()
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(POLICY.timeout),
  ])
  const base = new URL(`${options.baseUrl.replace(/\/$/, '')}/`)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Velopack release source must be a pinned HTTPS directory')
  const identity: PackageIdentity = {
    product_id: options.candidate.product_id,
    bundle_id: options.candidate.bundle_id,
    arch_type: options.candidate.arch_type,
    channel: options.candidate.channel,
    app_id: options.appId,
  }
  const envelope = JSON.parse(
    (
      await responseBytes(new URL('manifest', base).href, VELOPACK_POLICY.manifestBytes * 2, signal)
    ).toString('utf8')
  )
  const manifest = verifyPackageEnvelope(envelope, options.keys, identity, options.candidate)
  const paths = await locator()
  // Apply is launched after elevation with the installation's package directory.
  // Download/delta cache remains user-owned and need not share its volume.
  const staging = join(paths.RootAppDir, POLICY.packages, POLICY.staging, POLICY.stagingLeaf)
  verifyApplicationPaths(manifest, [paths.CurrentBinaryDir, staging])
  // Update.exe patch auto-locates independently from the JS locator; a per-user
  // copy in the product cache falls back to the inherited OS temporary directory.
  const patchRoots = [patchDirectory(paths.RootAppDir, paths.UpdateExePath, staging, tmpdir())]
  const patchWorkRoots = patchRoots.map((root) => join(root, '_work'))
  for (const asset of manifest.assets) assertWindowsPath(paths.PackagesDir, asset.FileName)
  const temporary = await mkdtemp(join(paths.PackagesDir, POLICY.source))
  const receipt = join(paths.PackagesDir, POLICY.receipt)
  const full = manifest.assets.find((asset) => asset.Type === 'Full')!
  const packagePath = join(paths.PackagesDir, full.FileName)
  let manager: UpdateManager
  let current: string
  try {
    manager = new UpdateManager(
      new FileSource(temporary),
      {
        AllowVersionDowngrade: false,
        MaximumDeltasBeforeFallback: POLICY.maximumDeltas,
        ExplicitChannel: manifest.channel,
      },
      paths
    )
    if (manager.getAppId() !== manifest.app_id)
      throw new Error('Installed Velopack application identity differs')
    current = manager.getCurrentVersion()
    assertNewerPackage(manifest.pack_version, current)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
  const target: UpdateInfo = {
    TargetFullRelease: officialAsset(full, manifest.app_id),
    DeltasToTarget: [],
    IsDowngrade: false,
  }
  let verified = false
  let handedOff = false
  let transfer: WindowsTransfer | null = null
  const verifyPrepared = async () => {
    await verifyPackageInventory(packagePath, manifest, [], options.signal)
    verified = true
  }
  try {
    // Signed baseline receipt is cache metadata, not a rollback record. Its absence is a full fallback.
    const delta = manifest.assets.find((asset) => asset.Type === 'Delta')
    if (delta && manifest.base_version === current) {
      try {
        const previous = verifyPackageEnvelope(
          JSON.parse(await readFile(receipt, 'utf8')),
          options.keys,
          identity
        )
        const baseAsset = previous.assets.find((asset) => asset.Type === 'Full')!
        if (previous.pack_version === current) {
          await verifyPackageInventory(
            join(paths.PackagesDir, baseAsset.FileName),
            previous,
            patchWorkRoots,
            signal
          )
          for (const member of manifest.files)
            for (const root of patchWorkRoots) assertWindowsPath(root, member.path)
          target.BaseRelease = officialAsset(baseAsset, manifest.app_id)
          target.DeltasToTarget = [officialAsset(delta, manifest.app_id)]
        }
      } catch {
        signal.throwIfAborted() /* Missing/invalid baseline is never patched. */
      }
    }
    // Never let the SDK's "already exists" shortcut accept unchecked bytes.
    try {
      await verifyPrepared()
      await writeReceipt(receipt, envelope)
    } catch (error) {
      verified = false
      signal.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await rm(packagePath, { force: true })
      if (target.DeltasToTarget.length) {
        try {
          await downloadAsset(base, delta!, temporary, signal, options.onProgress)
          await verifyDeltaPackagePaths(join(temporary, delta!.FileName), patchRoots, signal)
          await manager.downloadUpdateAsync(target, options.onProgress)
          await verifyPrepared()
        } catch {
          signal.throwIfAborted()
          await rm(packagePath, { force: true })
          target.BaseRelease = undefined
          target.DeltasToTarget = []
        }
      }
      if (!verified) {
        await downloadAsset(base, full, temporary, signal, options.onProgress)
        await manager.downloadUpdateAsync(
          { ...target, BaseRelease: undefined, DeltasToTarget: [] },
          options.onProgress
        )
        await verifyPrepared()
      }
      await writeReceipt(receipt, envelope)
    }
    const runtime = verifyRuntimeEnvelope(
      JSON.parse(
        (
          await readPackageMember(
            packagePath,
            manifest,
            COMPONENT_DELIVERY.packageManifest,
            RUNTIME_MANIFEST_LIMIT,
            signal
          )
        ).toString('utf8')
      ),
      options.keys
    )
    await downloadRuntimeComponents({
      root: paths.RootAppDir,
      native: options.native,
      baseUrl: options.componentBaseUrl,
      manifest: runtime,
      signal,
      onProgress: (state) => options.onProgress?.(Math.floor((state.received / state.total) * 100)),
    })
    return {
      packagePath,
      manifest,
      async lock(restartArgs, signal) {
        if (handedOff || transfer) throw new Error('Windows handoff already exists')
        await prepareWindowsToolGroup(
          paths.CurrentBinaryDir,
          (message) => console.error(message.trimEnd()),
          signal ?? options.signal
        )
        transfer = await prepareWindowsTransfer({
          operation: 'apply',
          application: paths.CurrentBinaryDir,
          packagePath,
          releaseEnvelope: envelope,
          restartArgs,
          diagnosticFile: options.diagnosticFile,
          signal: signal ?? options.signal,
          log: (message) => console.error(message.trimEnd()),
        })
      },
      async verify() {
        verified = false
        await verifyPrepared()
      },
      async apply(authorize) {
        if (!verified || handedOff || !transfer)
          throw new Error('Velopack update is not verified or already handed off')
        options.signal?.throwIfAborted()
        await transfer.start(authorize)
        handedOff = true
      },
      async close() {
        if (handedOff) return
        const pending = transfer
        transfer = null
        await pending?.close()
      },
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
