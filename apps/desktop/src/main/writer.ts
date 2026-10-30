import { userInfo } from 'node:os'
import { join } from 'node:path'
import { beginDomains, ensureDirectories, type DomainNative } from '../../native/domains.cjs'

export interface DirectoryWriter {
  close(): void
}

// An uncertain release must not become a fresh writer capability. Keep the
// remaining native owners reachable and reject later admissions until exit.
const retained: unknown[] = []
let uncertain = false

export function acquireDirectoryWriter(
  native: DomainNative,
  coordinator: string,
  root: string,
  maintenance = false
): DirectoryWriter {
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
  return { close }
}

/** Scope to the actual persistence directory, never a broad home lease. */
export function desktopDirectoryWriter(root: string): DirectoryWriter {
  const native = require('./lease.node') as DomainNative
  return acquireDirectoryWriter(native, join(userInfo().homedir, '.scholarseed-coordination'), root)
}

/** Exclusive maintenance refuses active ancestors, descendants and family owners. */
export function desktopDirectoryMaintenance(root: string): DirectoryWriter {
  const native = require('./lease.node') as DomainNative
  return acquireDirectoryWriter(
    native,
    join(userInfo().homedir, '.scholarseed-coordination'),
    root,
    true
  )
}
