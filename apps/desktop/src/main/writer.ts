import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { beginDomains, ensureDirectories, type DomainNative } from '../../native/domains.cjs'
import { REGISTRY_DIRECTORY } from '../../native/registry.cjs'
import { uncertainRecordWriteCode, writeRecord, type QualifiedRecordWriter } from './journal.ts'

export interface DirectoryWriter {
  close(): void
}

export interface DirectoryMaintenance extends DirectoryWriter {
  clearCache(aliases?: readonly (readonly [string, string])[]): void
  publishCache(staged: string, name: string): void
  consume(name: string, bytes: Buffer, device: string, inode: string): void
}

export interface RecordWriter extends DirectoryMaintenance, QualifiedRecordWriter {
  replace(name: string, bytes: Buffer): void
  withRecordLock(name: string, operation: () => void): void
}

// An uncertain release must not become a fresh writer capability. Keep the
// remaining native owners reachable and reject later admissions until exit.
const retained: unknown[] = []
let uncertain = false

export function assertDirectoryOwnership(): void {
  if (uncertain) throw new Error('Desktop directory ownership requires process exit')
}

export function retainUncertainDirectoryOwnership(...owners: unknown[]): void {
  retained.push(...owners)
  uncertain = true
}

export function acquireDirectoryWriter(
  native: DomainNative,
  coordinator: string,
  root: string,
  maintenance = false
): RecordWriter {
  if (uncertain) throw new Error('Desktop directory ownership requires process exit')
  const coordinate = native.pin(coordinator, true)
  try {
    native.release(coordinate)
  } catch (error) {
    retained.push(coordinate)
    uncertain = true
    throw error
  }
  // Creation holds the existing parent's namespace qualification. In native
  // launches the original application family also retains the encompassing
  // data-root membership; this is not a replacement for that guardian.
  let domains: ReturnType<typeof beginDomains>
  try {
    ensureDirectories(native, coordinator, [root])
    domains = beginDomains(native, coordinator, [root], maintenance)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_DOMAIN_RELEASE' || code === 'ERR_LEASE_RELEASE') {
      uncertain = true
      retained.push(error)
    }
    throw error
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      domains.close()
    } catch (error) {
      retained.push(domains)
      uncertain = true
      throw error
    }
  }
  try {
    domains.occupy()
    if (!maintenance) domains.admit()
  } catch (error) {
    try {
      close()
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'Desktop writer admission failed')
    }
    throw error
  }
  return {
    close,
    clearCache: (aliases) => domains.clearCache(root, aliases),
    publishCache: (staged, name) => domains.publishCache(root, staged, name),
    create: (name, bytes) => domains.create(root, name, bytes),
    replace: (name, bytes) => domains.replace(root, name, bytes),
    withRecordLock(name, operation) {
      if (closed || maintenance) throw new Error('Record lock requires an admitted writer')
      const pin = native.pin(root, false)
      let lock: unknown
      try {
        lock = native.acquireAt(pin, name, true)
        operation()
      } catch (error) {
        if (uncertainRecordWriteCode(error)) {
          closed = true
          retainUncertainDirectoryOwnership(lock, pin, domains)
        }
        throw error
      } finally {
        if (!closed) {
          try {
            if (lock !== undefined) native.release(lock)
            native.release(pin)
          } catch (error) {
            closed = true
            retainUncertainDirectoryOwnership(lock, pin, domains)
            throw error
          }
        }
      }
    },
    consume(name, bytes, device, inode) {
      if (closed || !maintenance || !native.consumeAt)
        throw new Error('Record consumption requires directory maintenance')
      domains.checkWritable()
      const pin = native.pin(root, false)
      try {
        native.consumeAt(pin, name, bytes, device, inode)
      } catch (error) {
        if (
          ['ERR_LEASE_SYNC', 'ERR_LEASE_RELEASE'].includes(
            (error as NodeJS.ErrnoException).code ?? ''
          )
        ) {
          closed = true
          retainUncertainDirectoryOwnership(pin, domains)
        }
        throw error
      } finally {
        if (!closed) {
          try {
            native.release(pin)
          } catch (error) {
            closed = true
            retainUncertainDirectoryOwnership(pin, domains)
            throw error
          }
        }
      }
    },
  }
}

/** Publish without inheriting sandbox-only ACLs from an existing Windows directory. */
export function writePrivateRecord(path: string, bytes: string | Uint8Array): void {
  const writer = desktopDirectoryWriter(dirname(path))
  try {
    writeRecord(path, bytes, undefined, writer)
  } finally {
    writer.close()
  }
}

export function desktopDirectoryNative(): DomainNative {
  return require('./lease.node') as DomainNative
}

/** Scope to the actual persistence directory, never a broad home lease. */
export function desktopDirectoryWriter(root: string): RecordWriter {
  return acquireDirectoryWriter(
    desktopDirectoryNative(),
    join(userInfo().homedir, REGISTRY_DIRECTORY),
    root
  )
}

/** Exclusive maintenance refuses active ancestors, descendants and family owners. */
export function desktopDirectoryMaintenance(root: string): RecordWriter {
  return acquireDirectoryWriter(
    desktopDirectoryNative(),
    join(userInfo().homedir, REGISTRY_DIRECTORY),
    root,
    true
  )
}
