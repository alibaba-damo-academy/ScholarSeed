import { isAbsolute, join } from 'node:path'

import type { DomainNative } from '../../native/domains.cjs'
import { uncertainRecordWriteCode } from './journal.ts'
import {
  POLICY_SCHEMA_VERSION,
  emptyPolicy,
  parsePolicy,
  normalizePolicyOrigin,
} from './policy-record.ts'
import type {
  BrowserAgentAction,
  BrowserAgentDecision,
  BrowserAgentPersistentAction,
  StoredPolicy,
  SiteRule,
} from './policy-record.ts'
import { assertDirectoryOwnership, retainUncertainDirectoryOwnership } from './writer.ts'
import { beginDomains, ensureDirectories } from '../../native/domains.cjs'
export { normalizePolicyOrigin } from './policy-record.ts'
export type {
  BrowserAgentAction,
  BrowserAgentDecision,
  BrowserAgentPersistentAction,
} from './policy-record.ts'

const MAX_POLICY_BYTES = 1024 * 1024
const READ_RETRY_BUDGET_MILLISECONDS = 20
const WRITE_BUDGET_MILLISECONDS = 100
const RETRY_BACKOFF_MILLISECONDS = 2
const MAX_POLICY_CONFLICT_RETRIES = 3
const POLICY_IO_ERROR = 'browser_policy_io_unavailable'
const POLICY_CONFLICT_ERROR = 'browser_policy_revision_conflict'
const POLICY_INVALID_ERROR = 'browser_policy_invalid'
const POLICY_CORRUPT_ERROR = 'browser_policy_corrupt'
const BROWSER_DIRECTORY = 'browser'
const POLICY_LEAF = 'agent-policy.json'

function backoff(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_BACKOFF_MILLISECONDS)
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

/**
 * Read and publish through one qualified policy transaction. On macOS, writes
 * also retain the flock used by the legacy Python writer.
 */
function createPolicyIo(home: string, native: DomainNative, coordinator: string) {
  if (!isAbsolute(home)) throw new Error(POLICY_IO_ERROR)
  const directory = join(home, BROWSER_DIRECTORY)
  type Occupancy = ReturnType<typeof beginDomains>
  let closed = false

  const verifyBarriers = (domains: Occupancy): void => {
    try {
      domains.verifyReadBarriers()
    } catch (error) {
      if (errorCode(error) !== 'ERR_LEASE_BUSY') throw error
      throw new Error(POLICY_IO_ERROR, { cause: error })
    }
  }

  const close = (): void => {
    closed = true
  }

  const lockBinding = (domains: Occupancy) => {
    const binding = domains.policyBinding(home)
    const name = binding.lineage.at(-1)!.replaceAll(':', '-') + '-policy'
    return { acquire: () => binding.acquire(name), release: binding.release }
  }

  const transaction = <T>(
    roots: string[],
    run: (domains: Occupancy, lock: (pin: unknown) => void) => T
  ): T => {
    assertDirectoryOwnership()
    let domains: Occupancy | undefined
    const locks: { handle: unknown; release: (handle: unknown) => void }[] = []
    let uncertain = false
    try {
      domains = beginDomains(native, coordinator, roots)
      domains.occupy()
      verifyBarriers(domains)
      const binding = lockBinding(domains)
      locks.push({ handle: binding.acquire(), release: binding.release })
      domains.check()
      return run(domains, (pin) => {
        if (!native.lockDirectoryAt) throw new Error(POLICY_IO_ERROR)
        locks.push({
          handle: native.lockDirectoryAt(pin),
          release: (handle) => native.release(handle),
        })
      })
    } catch (error) {
      uncertain = uncertainRecordWriteCode(error) !== undefined
      if (uncertain) retainUncertainDirectoryOwnership(domains, locks, error)
      throw error
    } finally {
      if (!uncertain) {
        try {
          while (locks.length) {
            const lock = locks[locks.length - 1]
            lock.release(lock.handle)
            locks.pop()
          }
          domains?.close()
        } catch (error) {
          retainUncertainDirectoryOwnership(domains, locks, error)
          throw new Error(POLICY_IO_ERROR, { cause: error })
        }
      }
    }
  }

  const retry = <T>(deadline: number, run: () => T): T => {
    for (;;) {
      try {
        return run()
      } catch (error) {
        const code = errorCode(error)
        if (
          (code !== 'ERR_LEASE_BUSY' && code !== 'ERR_LEASE_CHANGED') ||
          performance.now() >= deadline
        )
          throw error
        backoff()
      }
    }
  }

  const parse = (bytes: Buffer | null): StoredPolicy =>
    bytes === null ? emptyPolicy() : parsePolicy(bytes.toString('utf8'))

  const read = (): StoredPolicy => {
    if (closed) throw new Error(POLICY_IO_ERROR)
    return retry(performance.now() + READ_RETRY_BUDGET_MILLISECONDS, () => {
      try {
        // Release the shared Home lease after each read so storage maintenance can proceed.
        const bytes = transaction([home, directory], (domains) =>
          domains.read(directory, POLICY_LEAF, MAX_POLICY_BYTES)
        )
        return parse(bytes)
      } catch (error) {
        if (errorCode(error) !== 'ERR_LEASE_MISSING') throw error
      }
      return transaction([home], (domains) => {
        // Confirm absence only after acquiring both home occupancy and the policy
        // lock. A writer may have created the directory since the first attempt.
        let pin: unknown
        try {
          pin = native.pin(directory, false)
        } catch (error) {
          if (errorCode(error) !== 'ERR_LEASE_MISSING') throw error
          domains.check()
          return emptyPolicy()
        }
        try {
          native.release(pin)
        } catch (error) {
          retainUncertainDirectoryOwnership(pin)
          throw Object.assign(new Error(POLICY_IO_ERROR, { cause: error }), {
            code: 'ERR_LEASE_RELEASE',
          })
        }
        throw Object.assign(new Error(POLICY_IO_ERROR), { code: 'ERR_LEASE_CHANGED' })
      })
    })
  }

  const write = (expectedRevision: number, next: StoredPolicy, deadline: number): void => {
    const bytes = Buffer.from(JSON.stringify(next), 'utf8')
    if (bytes.length > MAX_POLICY_BYTES) throw new Error(POLICY_INVALID_ERROR)
    retry(deadline, () => {
      assertDirectoryOwnership()
      // Check the home before preparing its child. The preparation itself
      // uses domains admission and checks the durable mutation barriers.
      transaction([home], () => {})
      ensureDirectories(native, coordinator, [directory])
      transaction([home, directory], (domains, lock) => {
        if (process.platform !== 'win32') lock(domains.policyBinding(directory).pin)
        const current = parse(domains.read(directory, POLICY_LEAF, MAX_POLICY_BYTES))
        if (current.revision !== expectedRevision) throw new Error(POLICY_CONFLICT_ERROR)
        domains.admit()
        domains.replace(directory, POLICY_LEAF, bytes)
      })
    })
  }

  return { read, write, close }
}

export function createBrowserPolicy(
  home: string,
  native: DomainNative | null,
  coordinator: string
) {
  const changeListeners = new Set<() => void>()
  const notifyChange = (): void => {
    for (const listener of changeListeners) {
      try {
        listener()
      } catch {}
    }
  }
  const io = native ? createPolicyIo(home, native, coordinator) : null
  let policy: StoredPolicy
  let unavailable = false
  try {
    if (!io) throw new Error(POLICY_IO_ERROR)
    policy = io.read()
  } catch {
    policy = emptyPolicy()
    unavailable = true
  }
  const assertWritable = (): void => {
    if (unavailable) throw new Error(POLICY_IO_ERROR)
  }
  const refresh = (): void => {
    try {
      if (!io) throw new Error(POLICY_IO_ERROR)
      const latest = io.read()
      if (latest.revision < policy.revision) throw new Error(POLICY_CORRUPT_ERROR)
      const changed = unavailable || latest.revision !== policy.revision
      policy = latest
      unavailable = false
      if (changed) notifyChange()
    } catch {
      if (!unavailable) {
        unavailable = true
        notifyChange()
      }
    }
  }
  // One immediate disk read per authorization decision. Every independent
  // authorization re-reads, so a revoke takes effect at once; nothing is reused
  // across decisions.
  const observe = (): StoredPolicy | null => {
    refresh()
    return unavailable ? null : policy
  }
  const ruleFor = (
    snapshot: StoredPolicy,
    input: string,
    action: BrowserAgentAction
  ): BrowserAgentDecision => {
    if (!snapshot.agentBrowserUseEnabled) return 'block'
    if (action === 'submit') return 'ask'
    return snapshot.sites[normalizePolicyOrigin(input)]?.[action] ?? 'ask'
  }
  const decision = (input: string, action: BrowserAgentAction): BrowserAgentDecision => {
    if (action === 'submit') return 'ask'
    const snapshot = observe()
    if (!snapshot) return 'block'
    return snapshot.sites[normalizePolicyOrigin(input)]?.[action] ?? 'ask'
  }
  const commit = (change: (current: StoredPolicy) => StoredPolicy): void => {
    refresh()
    assertWritable()
    if (!io) throw new Error(POLICY_IO_ERROR)
    const deadline = performance.now() + WRITE_BUDGET_MILLISECONDS
    for (let attempt = 0; attempt < MAX_POLICY_CONFLICT_RETRIES; attempt += 1) {
      const candidate = change(policy)
      if (candidate === policy) return
      const next: StoredPolicy = {
        schemaVersion: POLICY_SCHEMA_VERSION,
        revision: policy.revision + 1,
        agentBrowserUseEnabled: candidate.agentBrowserUseEnabled,
        sites: candidate.sites,
      }
      try {
        io.write(policy.revision, next, deadline)
      } catch (error) {
        if (error instanceof Error && error.message === POLICY_CONFLICT_ERROR) {
          refresh()
          assertWritable()
          if (performance.now() < deadline) continue
          throw error
        }
        unavailable = true
        notifyChange()
        throw error
      }
      policy = next
      notifyChange()
      return
    }
    throw new Error(POLICY_CONFLICT_ERROR)
  }
  const update = (input: string, change: (existing: SiteRule) => SiteRule): void => {
    const origin = normalizePolicyOrigin(input)
    commit((current) => {
      const existing = current.sites[origin] ?? { read: 'ask', interact: 'ask' }
      const updated = change(existing)
      if (existing.read === updated.read && existing.interact === updated.interact) return current
      const sites = { ...current.sites, [origin]: updated }
      if (sites[origin].read === 'ask' && sites[origin].interact === 'ask') delete sites[origin]
      return { ...current, sites }
    })
  }
  const set = (
    input: string,
    action: BrowserAgentPersistentAction,
    choice: BrowserAgentDecision
  ): void => {
    if (action !== 'read' && action !== 'interact') throw new Error(POLICY_INVALID_ERROR)
    if (choice !== 'ask' && choice !== 'allow' && choice !== 'block')
      throw new Error(POLICY_INVALID_ERROR)
    update(input, (existing) => ({ ...existing, [action]: choice }))
  }
  return {
    close: (): void => {
      try {
        io?.close()
      } catch {
        // The owner is retained and new admissions already fail closed.
      } finally {
        unavailable = true
      }
    },
    onChange(listener: () => void): () => void {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
    agentUseEnabled: (): boolean => {
      refresh()
      assertWritable()
      return policy.agentBrowserUseEnabled
    },
    agentUseRevision: (): number | null => {
      refresh()
      assertWritable()
      return policy.agentBrowserUseEnabled ? policy.revision : null
    },
    decision,
    inspect: (
      input: string,
      action: BrowserAgentAction
    ): { revision: number; decision: BrowserAgentDecision } => {
      refresh()
      assertWritable()
      return { revision: policy.revision, decision: ruleFor(policy, input, action) }
    },
    effectiveDecision: (input: string, action: BrowserAgentAction): BrowserAgentDecision => {
      const snapshot = observe()
      return snapshot ? ruleFor(snapshot, input, action) : 'block'
    },
    /** One snapshot for the whole action fence: switch, grant revision and rule. */
    fence: (input: string, action: BrowserAgentAction, grantRevision: number): boolean => {
      const snapshot = observe()
      if (!snapshot) return false
      return (
        snapshot.agentBrowserUseEnabled &&
        snapshot.revision === grantRevision &&
        ruleFor(snapshot, input, action) !== 'block'
      )
    },
    setAgentBrowserUse(enabled: boolean): void {
      if (typeof enabled !== 'boolean') throw new Error(POLICY_INVALID_ERROR)
      commit((current) =>
        current.agentBrowserUseEnabled === enabled
          ? current
          : { ...current, agentBrowserUseEnabled: enabled }
      )
    },
    revision: (): number => {
      refresh()
      assertWritable()
      return policy.revision
    },
    valid: (
      input: string,
      action: BrowserAgentPersistentAction,
      capturedRevision: number
    ): boolean => {
      const snapshot = observe()
      return (
        snapshot !== null &&
        snapshot.agentBrowserUseEnabled &&
        snapshot.revision === capturedRevision &&
        ruleFor(snapshot, input, action) === 'allow'
      )
    },
    sites: (): Array<{
      origin: string
      read: BrowserAgentDecision
      interact: BrowserAgentDecision
    }> => {
      refresh()
      return unavailable
        ? []
        : Object.entries(policy.sites).map(([origin, rule]) => ({ origin, ...rule }))
    },
    snapshot: () => {
      refresh()
      assertWritable()
      return {
        revision: policy.revision,
        agentBrowserUseEnabled: policy.agentBrowserUseEnabled,
        sites: Object.entries(policy.sites).map(([origin, rule]) => ({ origin, ...rule })),
      }
    },
    set,
    revoke: (input: string, action: BrowserAgentPersistentAction): void =>
      set(input, action, 'ask'),
    remove: (input: string): void => update(input, () => ({ read: 'ask', interact: 'ask' })),
  }
}
