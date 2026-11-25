import { mkdir, open, rename, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertSquirrelArchiveSize } from './archive.ts'
import { assertUpdateSpace } from './download.ts'
import {
  clearMacStaging,
  fetchMacObject,
  lockMacComponentCache,
  openMacComponentCache,
  pruneMacObjects,
  retainedMacObject,
  type MacZipObject,
  type MacCacheNative,
} from './maccomponentcache.ts'
import { assembleMacZip } from './maclayout.ts'
import { componentStep } from './maccomponentfailure.ts'

const KINDS = ['app', 'browser', 'codex', 'electron', 'frameworks', 'python', 'texlive']
const MAX_LAYOUT_BYTES = 64 * 1024 * 1024

interface RebuildOptions {
  native: MacCacheNative
  downloadUrl: string
  components: unknown
  expected: { file_size: number; sha512: string }
  cacheDirectory: string
  destination: string
  signal?: AbortSignal
  checkSpaceAfterPruning?: (check: () => void, signal: AbortSignal) => Promise<void>
  onProgress?: (percent: number, receivedBytes: number) => void
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid ZIP components')
  return value as Record<string, unknown>
}

function releaseObjects(
  value: unknown,
  expected: RebuildOptions['expected'],
  downloadUrl: string
): MacZipObject[] {
  assertSquirrelArchiveSize(expected.file_size)
  const releaseUrl = new URL(downloadUrl)
  if (
    releaseUrl.protocol !== 'https:' ||
    releaseUrl.username ||
    releaseUrl.password ||
    releaseUrl.hash
  )
    throw new Error('ZIP components require a direct HTTPS release URL')
  const manifest = record(value)
  if (
    manifest.version !== 1 ||
    manifest.zip_bytes !== expected.file_size ||
    !/^[0-9a-f]{128}$/i.test(expected.sha512) ||
    manifest.zip_sha512 !== expected.sha512.toLowerCase()
  )
    throw new Error('ZIP component metadata differs from release identity')
  const order = manifest.component_order
  const objects = record(manifest.objects)
  if (
    !Array.isArray(order) ||
    !order.length ||
    order.length > KINDS.length ||
    order.some((name, i) => !KINDS.includes(name) || (i > 0 && order[i - 1] >= name)) ||
    Object.keys(objects).length !== order.length + 1
  )
    throw new Error('Invalid ZIP component order')
  let payloadBytes = 0
  return [...order, 'layout'].map((name) => {
    const { bytes, sha256, url } = record(objects[name])
    if (
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      typeof sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      typeof url !== 'string' ||
      url.length > 8192
    )
      throw new Error('Invalid ZIP component object')
    const source = new URL(url)
    if (
      source.protocol !== 'https:' ||
      source.origin !== releaseUrl.origin ||
      source.username ||
      source.password ||
      source.hash
    )
      throw new Error('ZIP components require direct HTTPS URLs on the release origin')
    if (name === 'layout') {
      if (bytes > MAX_LAYOUT_BYTES) throw new Error('Compressed ZIP layout exceeds limit')
    } else {
      payloadBytes += bytes
      if (payloadBytes > expected.file_size) throw new Error('ZIP components exceed archive size')
    }
    return { bytes, sha256, url: source }
  })
}

export async function rebuildMacUpdateZip(
  options: RebuildOptions
): Promise<{ downloadedBytes: number; reusedBytes: number }> {
  const { cacheDirectory, destination, expected, onProgress } = options
  const signal = options.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const objects = await componentStep('manifest', () =>
    releaseObjects(options.components, expected, options.downloadUrl)
  )
  const total = objects.reduce((bytes, obj) => bytes + obj.bytes, 0)
  const keep = new Set(objects.map((obj) => obj.sha256))
  await openMacComponentCache(cacheDirectory, dirname(destination))
  const lock = await lockMacComponentCache(options.native, cacheDirectory, signal)
  const files: (FileHandle | null)[] = []
  const fresh: { path: string; digest: string }[] = []
  const stage = join(cacheDirectory, 'staging')
  let downloadedBytes = 0
  let reusedBytes = 0
  function report(): void {
    // The download view also counts verified cache hits. ZIP headers represented
    // by the compressed layout become available on disk during final assembly.
    const available = Math.min(downloadedBytes + reusedBytes, expected.file_size - 1)
    onProgress?.(Math.floor((100 * available) / expected.file_size), available)
  }
  try {
    // Only the owner may write here. A crash leaves at most one staging directory.
    lock.check()
    await clearMacStaging(stage)
    for (const obj of objects) {
      signal.throwIfAborted()
      const retained = await retainedMacObject(cacheDirectory, obj, signal)
      files.push(retained)
      if (retained) {
        reusedBytes += obj.bytes
        report()
      }
    }
    const required = BigInt(total - reusedBytes + expected.file_size)
    const check = () => assertUpdateSpace(cacheDirectory, required)
    try {
      check()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error
      lock.check()
      await pruneMacObjects(cacheDirectory, keep)
      if (options.checkSpaceAfterPruning) await options.checkSpaceAfterPruning(check, signal)
      else check()
    }
    lock.check()
    await mkdir(stage, { mode: 0o700 })
    for (const [i, obj] of objects.entries()) {
      if (files[i]) continue
      signal.throwIfAborted()
      lock.check()
      const path = join(stage, String(i))
      files[i] = await componentStep('download', () =>
        fetchMacObject(path, obj, signal, (bytes) => {
          downloadedBytes += bytes
          report()
        })
      )
      fresh.push({ path, digest: obj.sha256 })
    }
    const sources = objects.map((obj, i) => ({ bytes: obj.bytes, file: files[i]! }))
    const layout = sources.pop()!
    const assembled = join(stage, 'assembled.zip')
    lock.check()
    const output = await open(assembled, 'wx', 0o600)
    try {
      await componentStep('assembly', () =>
        assembleMacZip(
          output,
          layout,
          sources,
          { ...expected, sha512: expected.sha512.toLowerCase() },
          signal
        )
      )
    } finally {
      await output.close()
    }
    // Retire the previous set first. Even repeated crashes during publication cannot
    // accumulate older digests. The stable cache holds at most seven blobs plus layout.
    lock.check()
    await pruneMacObjects(cacheDirectory, keep)
    for (const obj of fresh) {
      signal.throwIfAborted()
      await rename(obj.path, join(cacheDirectory, obj.digest))
    }
    signal.throwIfAborted()
    await rename(assembled, destination)
    onProgress?.(100, expected.file_size)
    return { downloadedBytes, reusedBytes }
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally {
    try {
      await Promise.all(files.map((file) => file?.close()))
    } finally {
      try {
        lock.check()
        await clearMacStaging(stage)
      } finally {
        lock.close()
      }
    }
  }
}
