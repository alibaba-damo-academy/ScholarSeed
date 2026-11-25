import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DomainNative } from '../../native/domains.cjs'
import { MacZipIntegrityError, UnsafeMacCacheError } from './maccomponentfailure.ts'
import { UpdateTransportError } from './retry.ts'

export type MacCacheNative = Pick<DomainNative, 'pin' | 'lineage' | 'lockDirectoryAt' | 'release'>

export async function lockMacComponentCache(
  native: MacCacheNative,
  directory: string,
  signal: AbortSignal,
  wait = true
): Promise<{ check(): void; close(): void }> {
  if (!native.lockDirectoryAt) throw new Error('ZIP component directory lock unavailable')
  const pin = native.pin(directory, false)
  try {
    const identity = native.lineage(pin).join('/')
    for (;;) {
      signal.throwIfAborted()
      try {
        const lock = native.lockDirectoryAt(pin)
        return {
          check() {
            const current = native.pin(directory, false)
            try {
              if (native.lineage(current).join('/') !== identity)
                throw new Error('ZIP component cache directory was replaced')
            } finally {
              native.release(current)
            }
          },
          close() {
            try {
              native.release(lock)
            } finally {
              native.release(pin)
            }
          },
        }
      } catch (error) {
        if (!wait || (error as NodeJS.ErrnoException).code !== 'ERR_LEASE_BUSY') throw error
        await delay(250, undefined, { signal })
      }
    }
  } catch (error) {
    native.release(pin)
    throw error
  }
}

export interface MacZipObject {
  bytes: number
  sha256: string
  url: URL
}

/** A crashed writer leaves only its eight numbered objects and the unpublished ZIP. */
export async function clearMacStaging(path: string, signal?: AbortSignal): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return
  if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new UnsafeMacCacheError('Unsafe ZIP component staging directory')
  for await (const entry of await opendir(path)) {
    signal?.throwIfAborted()
    if (!/^(?:[0-7]|assembled\.zip)$/.test(entry.name) || !entry.isFile())
      throw new UnsafeMacCacheError('Unexpected ZIP component staging entry')
    await unlink(join(path, entry.name))
  }
  await rmdir(path)
}

export async function openMacComponentCache(
  directory: string,
  parent: string,
  create = true
): Promise<void> {
  if (
    directory !== resolve(directory) ||
    dirname(directory) !== parent ||
    parent !== (await realpath(parent))
  )
    throw new UnsafeMacCacheError('Unsafe ZIP component cache path')
  const owner = process.getuid?.()
  const profile = await lstat(parent)
  if (!profile.isDirectory() || profile.uid !== owner || profile.mode & 0o022)
    throw new UnsafeMacCacheError('Unsafe ZIP profile directory')
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  const cache = await lstat(directory)
  if (!cache.isDirectory() || cache.uid !== owner || cache.mode & 0o077)
    throw new UnsafeMacCacheError('Unsafe ZIP component cache directory')
}

export async function retainedMacObject(
  directory: string,
  object: MacZipObject,
  signal: AbortSignal
): Promise<FileHandle | null> {
  const file = await open(
    join(directory, object.sha256),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!file) return null
  let retain = false
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o022)
      throw new UnsafeMacCacheError('Unsafe ZIP component cache entry')
    if (info.size !== object.bytes) return null
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of file.createReadStream({
      start: 0,
      end: object.bytes - 1,
      autoClose: false,
      signal,
    })) {
      size += chunk.length
      hash.update(chunk)
    }
    retain = size === object.bytes && hash.digest('hex') === object.sha256
    return retain ? file : null
  } finally {
    if (!retain) await file.close()
  }
}

/** Each signed URL addresses a final object. Never redirect the request or expose the query in errors. */
export async function fetchMacObject(
  path: string,
  object: MacZipObject,
  signal: AbortSignal,
  progress: (bytes: number) => void
): Promise<FileHandle> {
  const timeout = new AbortController()
  const combined = AbortSignal.any([signal, timeout.signal])
  const timer = setTimeout(
    () => timeout.abort(new DOMException('ZIP component download stalled', 'TimeoutError')),
    30_000
  )
  const file = await open(path, 'wx+', 0o600).catch((error) => {
    clearTimeout(timer)
    throw error
  })
  let retain = false
  try {
    const response = await fetch(object.url, { signal: combined, redirect: 'error' })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new UpdateTransportError(response.status)
    }
    const declared = response.headers.get('content-length')
    if (
      !response.body ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== object.bytes))
    ) {
      await response.body?.cancel()
      throw new MacZipIntegrityError('Invalid ZIP component download response')
    }
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of response.body) {
      combined.throwIfAborted()
      if (!chunk.byteLength) continue
      timer.refresh()
      size += chunk.byteLength
      if (size > object.bytes) throw new MacZipIntegrityError('ZIP component exceeds declared size')
      hash.update(chunk)
      await file.writeFile(chunk)
      progress(chunk.byteLength)
    }
    if (size !== object.bytes || hash.digest('hex') !== object.sha256)
      throw new MacZipIntegrityError('ZIP component differs from release object')
    combined.throwIfAborted()
    retain = true
    return file
  } catch (error) {
    combined.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
    if (!retain) await file.close()
  }
}

/** The caller holds the cache directory flock through pruning and publishing. */
export async function pruneMacObjects(
  directory: string,
  keep: Set<string>,
  signal?: AbortSignal
): Promise<void> {
  for await (const entry of await opendir(directory)) {
    signal?.throwIfAborted()
    if (/^[a-f0-9]{64}$/.test(entry.name) && !keep.has(entry.name) && entry.isFile()) {
      await unlink(join(directory, entry.name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}

/** Inactive lanes are opportunistic. Hold their lock only if it is immediately available. */
export async function reclaimMacComponentCache(
  native: MacCacheNative,
  directory: string,
  signal: AbortSignal,
  inactiveBefore?: number
): Promise<void> {
  signal.throwIfAborted()
  try {
    await openMacComponentCache(directory, dirname(directory), false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const lock = await lockMacComponentCache(
    native,
    directory,
    signal,
    inactiveBefore === undefined
  ).catch((error: NodeJS.ErrnoException) => {
    if (inactiveBefore !== undefined && error.code === 'ERR_LEASE_BUSY') return null
    throw error
  })
  if (!lock) return
  try {
    if (inactiveBefore !== undefined) {
      // Creating and retiring staging refreshes the directory even when every object was reused.
      const cache = await lstat(directory)
      if (cache.mtimeMs > inactiveBefore || cache.dev !== (await lstat(dirname(directory))).dev)
        return
    }
    lock.check()
    await clearMacStaging(join(directory, 'staging'), signal)
    lock.check()
    await pruneMacObjects(directory, new Set(), signal)
  } finally {
    lock.close()
  }
}
