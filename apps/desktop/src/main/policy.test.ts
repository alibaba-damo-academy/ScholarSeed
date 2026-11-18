import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import type { DomainNative } from '../../native/domains.cjs'
import { beginDomains } from '../../native/domains.cjs'
import { REGISTRY_DIRECTORY } from '../../native/registry.cjs'
import { DatabaseSync } from 'node:sqlite'
import { createBrowserPolicy, normalizePolicyOrigin } from './policy.ts'
import { createBrowserReadGrants } from './grant.ts'
import { emptyPolicy, parsePolicy } from './policy-record.ts'

// The record IO is native now; inject the actual compiled library rather than a
// host interpreter. SCHOLARSEED_LEASE_LIBRARY selects an explicit build, matching
// the native contract convention.
const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const NATIVE = createRequire(import.meta.url)(
  process.env.SCHOLARSEED_LEASE_LIBRARY ?? resolve(DESKTOP, 'out/main/lease.node')
) as DomainNative
const persistedTest = test
// POSIX mode bits have no Windows equivalent; these authority cases are Darwin-only
// rather than silently passing on a platform that cannot express the precondition.
const posixTest = process.platform === 'win32' ? test.skip : test
// A directory junction is the Windows reparse-point equivalent of a directory
// symlink; both must be rejected by the pinned-directory qualification.
function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

// Windows refuses to rename a directory while our pinned handle is open, so the
// macOS directory-replacement injection cannot run there. Inject a leaf-level
// failure instead; the fail-closed and recovery contract under test is identical.
function breakPolicyAccess(home: string, otherHome: string): void {
  if (process.platform === 'win32') {
    const leaf = join(home, 'browser', 'agent-policy.json')
    renameSync(leaf, join(home, 'browser', 'agent-policy.saved'))
    mkdirSync(leaf)
    return
  }
  renameSync(join(home, 'browser'), join(home, 'browser-old'))
  linkDirectory(otherHome, join(home, 'browser'))
}

function restorePolicyAccess(home: string): void {
  if (process.platform === 'win32') {
    const leaf = join(home, 'browser', 'agent-policy.json')
    rmSync(leaf, { recursive: true, force: true })
    renameSync(join(home, 'browser', 'agent-policy.saved'), leaf)
    return
  }
  rmSync(join(home, 'browser'))
  renameSync(join(home, 'browser-old'), join(home, 'browser'))
}
// Isolated coordination sibling: outside the data root, never the real OS account
// directory, so tests cannot create or mutate the user's actual lock namespace.
function coordinationFor(home: string): string {
  const coordination = join(dirname(home), `.coordination-${basename(home)}`)
  mkdirSync(coordination, { recursive: true })
  return coordination
}

const openPolicies = new Set<ReturnType<typeof createBrowserPolicy>>()
function openPolicy(home: string, native: DomainNative | null = NATIVE) {
  const policy = createBrowserPolicy(home, native, coordinationFor(home))
  openPolicies.add(policy)
  return policy
}

function closePolicies(policies: ReadonlySet<ReturnType<typeof createBrowserPolicy>>): void {
  for (const policy of openPolicies) {
    if (policies.has(policy)) continue
    policy.close()
    openPolicies.delete(policy)
  }
}

persistedTest('a missing browser directory cannot bypass or retry a durable home barrier', (t) =>
  withHome((home) => {
    const coordinator = coordinationFor(home)
    const migration = beginDomains(NATIVE, coordinator, [home], true)
    migration.occupy()
    migration.reserveMutation('browser-policy-test')
    migration.close()
    const scans = t.mock.fn(NATIVE.listAt)
    const transport = new Proxy({} as DomainNative, {
      get(_target, key) {
        return key === 'listAt' ? scans : Reflect.get(NATIVE, key)
      },
    })
    const policy = openPolicy(home, transport)
    const initialScans = scans.mock.callCount()
    assert.ok(initialScans > 0)
    assert.equal(policy.effectiveDecision('https://www.bing.com', 'read'), 'block')
    assert.equal(scans.mock.callCount(), initialScans * 2)
    assert.equal(existsSync(join(home, 'browser')), false)
    const recovery = beginDomains(NATIVE, coordinator, [home], true)
    recovery.occupy()
    recovery.reserveMutation('browser-policy-test').finish()
    recovery.close()
    assert.equal(policy.effectiveDecision('https://www.bing.com', 'read'), 'allow')
  })
)

persistedTest('action authorization reads policy once at every fence', (t) =>
  withHome((home) => {
    const origin = 'https://example.com'
    const writer = openPolicy(home)
    writer.set(origin, 'interact', 'allow')
    const reads = t.mock.fn(NATIVE.readAt)
    const policy = openPolicy(
      home,
      new Proxy({} as DomainNative, {
        get(_target, key) {
          return key === 'readAt' ? reads : Reflect.get(NATIVE, key)
        },
      })
    )
    const revision = policy.revision()
    reads.mock.resetCalls()
    const durations = Array.from({ length: 20 }, () => {
      const started = performance.now()
      assert.equal(policy.fence(origin, 'interact', revision), true)
      return performance.now() - started
    })
    assert.equal(reads.mock.callCount(), durations.length)
    t.diagnostic(
      JSON.stringify({
        platform: process.platform,
        reads: reads.mock.callCount(),
        meanSyncMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
        maxSyncMs: Math.max(...durations),
      })
    )
    writer.set(origin, 'interact', 'block')
    assert.equal(policy.fence(origin, 'interact', revision), false)
    assert.equal(reads.mock.callCount(), durations.length + 1)
  })
)

persistedTest('an open browser policy leaves Home available for exclusive maintenance', () =>
  withHome((home) => {
    mkdirSync(join(home, 'browser'))
    const coordinator = join(dirname(home), REGISTRY_DIRECTORY)
    mkdirSync(coordinator, { mode: 0o700 })
    const policy = createBrowserPolicy(home, NATIVE, coordinator)
    const origin = 'https://www.bing.com'
    try {
      assert.equal(policy.effectiveDecision(origin, 'read'), 'allow')
      const maintenance = beginDomains(NATIVE, coordinator, [home], true)
      try {
        maintenance.occupy()
        assert.equal(policy.effectiveDecision(origin, 'read'), 'block')
      } finally {
        maintenance.close()
      }
      assert.equal(policy.effectiveDecision(origin, 'read'), 'allow')
    } finally {
      policy.close()
    }
  })
)

persistedTest('policy readers respect the same home lock as writers', () =>
  withHome((home) => {
    const policy = openPolicy(home)
    policy.set('https://example.com', 'read', 'allow')
    const homePin = NATIVE.pin(home, false)
    const coordinator = NATIVE.pin(coordinationFor(home), false)
    const name = NATIVE.lineage(homePin).at(-1)!.replaceAll(':', '-') + '-policy'
    const lock = NATIVE.acquireAt(coordinator, name, true)
    try {
      assert.equal(policy.effectiveDecision('https://example.com', 'read'), 'block')
    } finally {
      NATIVE.release(lock)
      NATIVE.release(coordinator)
      NATIVE.release(homePin)
    }
    assert.equal(policy.effectiveDecision('https://example.com', 'read'), 'allow')
  })
)
persistedTest('policy readers and writers share a registry slot with the directory flock', () =>
  withHome((home) => {
    const coordinator = join(dirname(home), REGISTRY_DIRECTORY)
    mkdirSync(coordinator, { mode: 0o700 })
    const policy = createBrowserPolicy(home, NATIVE, coordinator)
    const origin = 'https://example.com'
    try {
      policy.set(origin, 'read', 'allow')
      const database = new DatabaseSync(join(coordinator, 'registry.sqlite'))
      try {
        const policySlot = database.prepare("SELECT slot FROM slots WHERE name LIKE '%-policy'")
        assert.equal(policySlot.get(), undefined)
        const domains = beginDomains(NATIVE, coordinator, [home])
        try {
          domains.occupy()
          const binding = domains.policyBinding(home)
          const name = binding.lineage.at(-1)!.replaceAll(':', '-') + '-policy'
          const lock = binding.acquire(name)
          try {
            const active = policySlot.get()
            assert.equal(typeof active?.slot, 'number')
            const sweeper = beginDomains(NATIVE, coordinator, [home])
            try {
              sweeper.occupy()
              assert.deepEqual(policySlot.get(), active)
              assert.throws(() => sweeper.policyBinding(home).acquire(name), {
                code: 'ERR_LEASE_BUSY',
              })
            } finally {
              sweeper.close()
            }
            assert.equal(policy.effectiveDecision(origin, 'read'), 'block')
          } finally {
            binding.release(lock)
          }
        } finally {
          domains.close()
        }
        assert.equal(policySlot.get(), undefined)
      } finally {
        database.close()
      }
      assert.equal(policy.effectiveDecision(origin, 'read'), 'allow')
      if (process.platform === 'darwin') {
        const browser = NATIVE.pin(join(home, 'browser'), false)
        try {
          const legacy = NATIVE.lockDirectoryAt!(browser)
          try {
            assert.throws(() => policy.set(origin, 'read', 'block'))
          } finally {
            NATIVE.release(legacy)
          }
          policy.set(origin, 'read', 'block')
        } finally {
          NATIVE.release(browser)
        }
      }
    } finally {
      policy.close()
    }
  })
)

const DEFAULT_SITES = [
  { origin: 'https://www.bing.com', read: 'allow', interact: 'allow' },
  { origin: 'https://cn.bing.com', read: 'allow', interact: 'allow' },
]

persistedTest(
  'atomic policy inspection returns a coherent decision and revision without caching revocations',
  () =>
    withHome((home) => {
      const policy = openPolicy(home)
      const original = policy.inspect('https://www.bing.com', 'read')
      assert.equal(original.decision, 'allow')
      const other = openPolicy(home)
      other.set('https://www.bing.com', 'read', 'block')
      const blocked = policy.inspect('https://www.bing.com', 'read')
      assert.equal(blocked.decision, 'block')
      assert.ok(blocked.revision > original.revision)
      other.setAgentBrowserUse(false)
      assert.equal(policy.inspect('https://example.org', 'interact').decision, 'block')
      writeFileSync(join(home, 'browser', 'agent-policy.json'), '{invalid')
      assert.throws(
        () => policy.inspect('https://www.bing.com', 'read'),
        /browser_policy_io_unavailable/
      )
    })
)

test('new browser policy enables only exact Bing homepage origins and returns independent defaults', () => {
  const policy = emptyPolicy()
  assert.equal(policy.agentBrowserUseEnabled, true)
  assert.deepEqual(policy.sites, {
    'https://www.bing.com': { read: 'allow', interact: 'allow' },
    'https://cn.bing.com': { read: 'allow', interact: 'allow' },
  })
  policy.sites['https://cn.bing.com'].interact = 'block'
  assert.equal(emptyPolicy().sites['https://cn.bing.com'].interact, 'allow')
  policy.sites['https://www.bing.com'].read = 'block'
  assert.equal(emptyPolicy().sites['https://www.bing.com'].read, 'allow')
  for (const enabled of [false, true]) {
    const stored = {
      schemaVersion: 2,
      revision: 1,
      agentBrowserUseEnabled: enabled,
      sites: { 'https://www.bing.com': { read: 'block', interact: 'ask' } },
    }
    assert.deepEqual(parsePolicy(JSON.stringify(stored)), stored)
  }
})

persistedTest(
  'fresh Home uses defaults without writing and explicit revocation survives restart',
  () =>
    withHome((home) => {
      const policy = openPolicy(home)
      assert.equal(policy.agentUseEnabled(), true)
      assert.equal(policy.effectiveDecision('https://www.bing.com/search?q=test', 'read'), 'allow')
      assert.equal(
        policy.effectiveDecision('https://www.bing.com/search?q=test', 'interact'),
        'allow'
      )
      assert.equal(policy.effectiveDecision('https://cn.bing.com/search?q=test', 'read'), 'allow')
      assert.equal(
        policy.effectiveDecision('https://cn.bing.com/search?q=test', 'interact'),
        'allow'
      )
      for (const origin of [
        'https://bing.com',
        'http://www.bing.com',
        'https://www.bing.com:8443',
        'https://example.org',
        'http://cn.bing.com',
        'https://cn.bing.com:8443',
        'https://other.bing.com',
        'https://cn.bing.com.example.org',
      ]) {
        assert.equal(policy.effectiveDecision(origin, 'read'), 'ask')
        assert.equal(policy.effectiveDecision(origin, 'interact'), 'ask')
      }
      assert.equal(policy.effectiveDecision('https://www.bing.com', 'submit'), 'ask')
      assert.equal(policy.effectiveDecision('https://cn.bing.com', 'submit'), 'ask')
      assert.equal(existsSync(join(home, 'browser', 'agent-policy.json')), false)
      policy.set('https://www.bing.com', 'read', 'block')
      policy.setAgentBrowserUse(false)
      const restored = openPolicy(home)
      assert.equal(restored.agentUseEnabled(), false)
      assert.equal(restored.decision('https://www.bing.com', 'read'), 'block')
      restored.setAgentBrowserUse(true)
      restored.set('https://cn.bing.com', 'interact', 'block')
      assert.equal(openPolicy(home).effectiveDecision('https://cn.bing.com', 'interact'), 'block')
      restored.remove('https://cn.bing.com')
      assert.equal(openPolicy(home).effectiveDecision('https://cn.bing.com', 'read'), 'ask')
      assert.equal(openPolicy(home).effectiveDecision('https://cn.bing.com', 'interact'), 'ask')
      restored.remove('https://www.bing.com')
      assert.equal(openPolicy(home).effectiveDecision('https://www.bing.com', 'read'), 'ask')
    })
)

persistedTest('existing v2 policy never gains default grants or replaces a saved disable', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome)
    const policyPath = join(browserHome, 'agent-policy.json')
    for (const enabled of [false, true]) {
      const contents = JSON.stringify({
        schemaVersion: 2,
        revision: 0,
        agentBrowserUseEnabled: enabled,
        sites: {},
      })
      writeFileSync(policyPath, contents)
      const policy = openPolicy(home)
      assert.equal(policy.agentUseEnabled(), enabled)
      assert.equal(policy.decision('https://www.bing.com', 'read'), 'ask')
      assert.equal(policy.decision('https://www.bing.com', 'interact'), 'ask')
      assert.equal(policy.decision('https://cn.bing.com', 'read'), 'ask')
      assert.equal(policy.decision('https://cn.bing.com', 'interact'), 'ask')
      assert.deepEqual(policy.sites(), [])
      assert.equal(readFileSync(policyPath, 'utf8'), contents)
    }
  })
)

function withHome(run: (home: string) => void): void {
  const previous = new Set(openPolicies)
  const base = mkdtempSync(join(tmpdir(), 'scholarseed-browser-policy-'))
  const home = join(base, 'home')
  mkdirSync(home)
  try {
    run(realpathSync.native(home))
  } finally {
    // Windows refuses to delete a directory while native handles stay open, so
    // every policy must release its occupancy before the fixture is removed.
    closePolicies(previous)
    rmSync(base, { recursive: true, force: true })
  }
}

test('normalizes exact web origin including effective port and rejects opaque origins', () => {
  assert.equal(
    normalizePolicyOrigin('HTTPS://Example.COM:443/path?q=1#fragment'),
    'https://example.com'
  )
  assert.equal(normalizePolicyOrigin('https://example.com:8443/path'), 'https://example.com:8443')
  assert.equal(normalizePolicyOrigin('http://example.com:80/'), 'http://example.com')
  for (const value of [
    'file:///tmp/a',
    'data:text/html,a',
    'https://user:secret@example.com/',
    'not a url',
  ]) {
    assert.throws(() => normalizePolicyOrigin(value))
  }
})

persistedTest('read and interact policies match scheme host and effective port exactly', () =>
  withHome((home) => {
    const policy = openPolicy(home)
    policy.set('https://example.com/page', 'read', 'allow')
    assert.equal(policy.decision('https://example.com/other', 'read'), 'allow')
    assert.equal(policy.decision('https://example.com/other', 'interact'), 'ask')
    assert.equal(policy.decision('https://sub.example.com/', 'read'), 'ask')
    assert.equal(policy.decision('https://example.com:8443/', 'read'), 'ask')
    assert.equal(policy.decision('http://example.com/', 'read'), 'ask')
    assert.equal(policy.decision('https://example.com/', 'submit'), 'ask')
  })
)

persistedTest(
  'legacy Agent Browser Use stays off, upgrades v1 without losing sites, and revokes read immediately',
  () =>
    withHome((home) => {
      const browserHome = join(home, 'browser')
      mkdirSync(browserHome)
      writeFileSync(
        join(browserHome, 'agent-policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          revision: 3,
          sites: { 'https://example.org': { read: 'allow', interact: 'ask' } },
        })
      )
      const policy = openPolicy(home)
      assert.equal(policy.snapshot().agentBrowserUseEnabled, false)
      assert.equal(policy.agentUseEnabled(), false)
      assert.equal(policy.agentUseRevision(), null)
      assert.equal(policy.effectiveDecision('https://example.org', 'read'), 'block')
      assert.equal(policy.decision('https://example.org', 'read'), 'allow')
      policy.setAgentBrowserUse(true)
      assert.equal(policy.agentUseEnabled(), true)
      assert.equal(policy.agentUseRevision(), 4)
      assert.equal(policy.effectiveDecision('https://example.org', 'read'), 'allow')
      assert.deepEqual(policy.snapshot().sites, [
        { origin: 'https://example.org', read: 'allow', interact: 'ask' },
      ])
      assert.equal(policy.snapshot().revision, 4)
      const captured = policy.revision()
      policy.setAgentBrowserUse(false)
      assert.equal(policy.agentUseEnabled(), false)
      assert.equal(policy.agentUseRevision(), null)
      assert.equal(policy.revision(), captured + 1)
      assert.equal(policy.valid('https://example.org', 'read', captured), false)
      assert.equal(policy.effectiveDecision('https://example.org', 'read'), 'block')
      assert.equal(openPolicy(home).snapshot().agentBrowserUseEnabled, false)
      assert.equal(
        JSON.parse(readFileSync(join(browserHome, 'agent-policy.json'), 'utf8')).schemaVersion,
        2
      )
    })
)

persistedTest('disabling Agent Browser Use invalidates a live snapshot read lease', async () => {
  const previous = new Set(openPolicies)
  const base = mkdtempSync(join(tmpdir(), 'scholarseed-browser-policy-'))
  const home = join(base, 'home')
  mkdirSync(home)
  try {
    let diskReads = 0
    let policyCalls = 0
    let syncMs = 0
    const transport = new Proxy({} as DomainNative, {
      get(_target, key) {
        if (key !== 'readAt') return Reflect.get(NATIVE, key)
        return (...args: Parameters<DomainNative['readAt']>) => {
          diskReads += 1
          return NATIVE.readAt(...args)
        }
      },
    })
    const policy = openPolicy(realpathSync.native(home), transport)
    policy.setAgentBrowserUse(false)
    const scope = {
      sessionId: 'session',
      instanceId: 'instance',
      productTurnId: 'product',
      turnId: 'turn',
      generation: 1,
      interruptGeneration: 0,
      lifecycleEpoch: 1,
    }
    const target = { instanceId: 'tab-instance', generation: 1, origin: 'https://example.org' }
    const grants = createBrowserReadGrants({
      scope: () => scope,
      target: () => target,
      policy: (origin) => {
        const started = performance.now()
        try {
          return policy.inspect(origin, 'read')
        } finally {
          policyCalls += 1
          syncMs += performance.now() - started
        }
      },
    })
    assert.throws(() =>
      grants.prepareRead({
        sessionId: 'session',
        turnId: 'turn',
        requestId: 'off',
        tabId: 'tab',
        intent: 'Read page',
      })
    )
    policy.setAgentBrowserUse(true)
    policy.set('https://example.org', 'read', 'allow')
    diskReads = policyCalls = syncMs = 0
    const proof = grants.prepareRead({
      sessionId: 'session',
      turnId: 'turn',
      requestId: 'on',
      tabId: 'tab',
      intent: 'Read page',
    })
    const authority = await grants.acquireSnapshot({
      scope,
      requestId: 'on',
      proofId: proof.proofId,
      tabId: 'tab',
    })
    grants.finishSnapshot(authority, 'snapshot')
    assert.equal(grants.validateAuthority(authority), true)
    assert.ok(policyCalls > 1)
    assert.equal(diskReads, policyCalls)
    console.log(
      JSON.stringify({ platform: process.platform, grantChainDiskReads: diskReads, syncMs })
    )
    policy.setAgentBrowserUse(false)
    assert.equal(grants.validateAuthority(authority), false)
    assert.throws(() => grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'snapshot' }))
  } finally {
    closePolicies(previous)
    rmSync(base, { recursive: true, force: true })
  }
})

persistedTest('block takes precedence over a prior allow and submit always asks', () =>
  withHome((home) => {
    const policy = openPolicy(home)
    policy.set('https://example.com/', 'read', 'allow')
    policy.set('https://example.com/', 'read', 'block')
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.equal(policy.decision('https://example.com/', 'submit'), 'ask')
    assert.throws(() => policy.set('https://example.com/', 'submit' as 'read', 'allow'))
  })
)

persistedTest('rules persist across restart and remain isolated to their user home', () =>
  withHome((firstHome) =>
    withHome((secondHome) => {
      const first = openPolicy(firstHome)
      first.set('https://example.com/', 'interact', 'allow')
      assert.equal(openPolicy(firstHome).decision('https://example.com/', 'interact'), 'allow')
      assert.equal(openPolicy(secondHome).decision('https://example.com/', 'interact'), 'ask')
    })
  )
)

persistedTest('corrupt stored policy fails closed and cannot be silently overwritten', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome)
    writeFileSync(join(browserHome, 'agent-policy.json'), '{bad json', 'utf8')
    const policy = openPolicy(home)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
    assert.equal(readFileSync(join(browserHome, 'agent-policy.json'), 'utf8'), '{bad json')
  })
)

posixTest('world-writable policy file cannot grant access or be overwritten', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome, { mode: 0o755 })
    chmodSync(browserHome, 0o755)
    const policyPath = join(browserHome, 'agent-policy.json')
    const contents = JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      sites: { 'https://example.com': { read: 'allow', interact: 'ask' } },
    })
    writeFileSync(policyPath, contents, 'utf8')
    chmodSync(policyPath, 0o666)
    const policy = openPolicy(home)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(
      () => policy.set('https://example.com/', 'read', 'block'),
      /browser_policy_io_unavailable/
    )
    assert.equal(readFileSync(policyPath, 'utf8'), contents)
  })
)

persistedTest('revoke increments revision and invalidates a captured grant before returning', () =>
  withHome((home) => {
    const policy = openPolicy(home)
    policy.set('https://example.com/', 'read', 'allow')
    const captured = policy.revision()
    policy.revoke('https://example.com/', 'read')
    assert.ok(policy.revision() > captured)
    assert.equal(policy.valid('https://example.com/', 'read', captured), false)
    assert.equal(policy.decision('https://example.com/', 'read'), 'ask')
    assert.deepEqual(policy.sites(), DEFAULT_SITES)
    assert.equal(openPolicy(home).decision('https://example.com/', 'read'), 'ask')
  })
)

persistedTest('policy revision observer fires for local and external revocation', () =>
  withHome((home) => {
    const policy = openPolicy(home)
    const other = openPolicy(home)
    let changes = 0
    const unsubscribe = policy.onChange(() => {
      changes += 1
    })
    policy.set('https://example.com', 'read', 'allow')
    assert.equal(changes, 1)
    other.revoke('https://example.com', 'read')
    assert.equal(policy.decision('https://example.com', 'read'), 'ask')
    assert.equal(changes, 2)
    unsubscribe()
  })
)

persistedTest('removing a site revokes read and interact in one revision', () =>
  withHome((home) => {
    const policy = openPolicy(home)
    policy.set('https://example.com', 'read', 'allow')
    policy.set('https://example.com', 'interact', 'block')
    const previous = policy.revision()
    policy.remove('https://example.com')
    assert.equal(policy.revision(), previous + 1)
    assert.deepEqual(policy.sites(), DEFAULT_SITES)
    assert.equal(openPolicy(home).decision('https://example.com', 'read'), 'ask')
    assert.equal(openPolicy(home).decision('https://example.com', 'interact'), 'ask')
  })
)

persistedTest('a failed policy write invalidates prior allow in memory', () =>
  withHome((home) =>
    withHome((otherHome) => {
      const policy = openPolicy(home)
      policy.set('https://example.com/', 'read', 'allow')
      breakPolicyAccess(home, otherHome)
      assert.throws(() => policy.revoke('https://example.com/', 'read'))
      assert.equal(policy.decision('https://example.com/', 'read'), 'block')
      assert.throws(() => policy.revision(), /browser_policy_io_unavailable/)
      assert.equal(policy.valid('https://example.com/', 'read', 1), false)
    })
  )
)

persistedTest('refresh failure never exposes a cached revision', () =>
  withHome((home) =>
    withHome((otherHome) => {
      const policy = openPolicy(home)
      policy.set('https://example.com/', 'read', 'allow')
      const captured = policy.revision()
      breakPolicyAccess(home, otherHome)
      assert.throws(() => policy.revision(), /browser_policy_io_unavailable/)
      assert.equal(policy.valid('https://example.com/', 'read', captured), false)
      assert.throws(() => policy.revision(), /browser_policy_io_unavailable/)
    })
  )
)

persistedTest(
  'policy recovers after a temporary read failure without restoring a stale grant',
  () =>
    withHome((home) =>
      withHome((otherHome) => {
        const policy = openPolicy(home)
        policy.setAgentBrowserUse(true)
        policy.set('https://example.com/', 'read', 'allow')
        const captured = policy.revision()
        breakPolicyAccess(home, otherHome)
        assert.equal(policy.valid('https://example.com/', 'read', captured), false)
        assert.equal(policy.effectiveDecision('https://example.com/', 'read'), 'block')
        restorePolicyAccess(home)
        const other = openPolicy(home)
        other.revoke('https://example.com/', 'read')
        assert.equal(policy.valid('https://example.com/', 'read', captured), false)
        assert.equal(policy.decision('https://example.com/', 'read'), 'ask')
        assert.equal(policy.agentUseEnabled(), true)
      })
    )
)

persistedTest('policy retries an unavailable initial read after the secure file is repaired', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome)
    writeFileSync(join(browserHome, 'agent-policy.json'), '{bad json', 'utf8')
    const policy = openPolicy(home)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.snapshot(), /browser_policy_io_unavailable/)
    rmSync(join(browserHome, 'agent-policy.json'))
    assert.deepEqual(policy.snapshot(), {
      revision: 0,
      agentBrowserUseEnabled: true,
      sites: DEFAULT_SITES,
    })
    policy.set('https://example.com/', 'read', 'allow')
    assert.equal(policy.decision('https://example.com/', 'read'), 'allow')
  })
)

persistedTest('a revision conflict refreshes before retrying without restoring a revoke', (t) => {
  t.mock.method(performance, 'now', () => 0)
  withHome((home) => {
    const second = openPolicy(home)
    second.set('https://example.com/', 'read', 'allow')
    let armed = false
    let publishes = 0
    let policyAcquisitions = 0
    const overrides: Pick<DomainNative, 'acquireAt' | 'replaceAt'> = {
      acquireAt(pin, name, exclusive) {
        if (armed && name.endsWith('-policy') && ++policyAcquisitions === 2) {
          armed = false
          second.revoke('https://example.com/', 'read')
          assert.equal(publishes, 0)
        }
        return NATIVE.acquireAt(pin, name, exclusive)
      },
      replaceAt(pin, name, bytes) {
        publishes += 1
        NATIVE.replaceAt(pin, name, bytes)
      },
    }
    const first = openPolicy(
      home,
      new Proxy({} as DomainNative, {
        get(_target, key) {
          return Object.hasOwn(overrides, key)
            ? Reflect.get(overrides, key)
            : Reflect.get(NATIVE, key)
        },
      })
    )
    armed = true
    first.set('https://other.example/', 'interact', 'allow')
    const latest = openPolicy(home)
    assert.equal(publishes, 1)
    assert.equal(latest.revision(), 3)
    assert.equal(latest.decision('https://example.com/', 'read'), 'ask')
    assert.equal(latest.decision('https://other.example/', 'interact'), 'allow')
    assert.equal(first.revision(), latest.revision())
  })
})

persistedTest('symlinked browser policy directory is not followed', () =>
  withHome((home) =>
    withHome((otherHome) => {
      linkDirectory(otherHome, join(home, 'browser'))
      const policy = openPolicy(home)
      assert.equal(policy.decision('https://example.com/', 'read'), 'block')
      assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
    })
  )
)

test('missing secure filesystem transport never grants persistent access', () =>
  withHome((home) => {
    const policy = openPolicy(home, null)
    assert.throws(() => policy.agentUseEnabled(), /browser_policy_io_unavailable/)
    assert.throws(() => policy.agentUseRevision(), /browser_policy_io_unavailable/)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.equal(policy.decision('https://example.com/', 'submit'), 'ask')
    assert.throws(() => policy.revision(), /browser_policy_io_unavailable/)
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  }))

persistedTest('a stale process preserves another process revoke when updating another site', () =>
  withHome((home) => {
    const first = openPolicy(home)
    first.set('https://example.com/', 'read', 'allow')
    const stale = openPolicy(home)
    first.revoke('https://example.com/', 'read')
    stale.set('https://other.example/', 'interact', 'allow')
    assert.equal(openPolicy(home).decision('https://example.com/', 'read'), 'ask')
    assert.equal(stale.decision('https://other.example/', 'interact'), 'allow')
  })
)

persistedTest('a stale no-op revoke refreshes before deciding there is nothing to write', () =>
  withHome((home) => {
    const stale = openPolicy(home)
    const other = openPolicy(home)
    other.set('https://example.com/', 'read', 'allow')
    stale.revoke('https://example.com/', 'read')
    assert.equal(openPolicy(home).decision('https://example.com/', 'read'), 'ask')
  })
)

persistedTest('a live policy notices external revoke before validating captured allow', () =>
  withHome((home) => {
    const first = openPolicy(home)
    first.set('https://example.com/', 'read', 'allow')
    const second = openPolicy(home)
    const captured = second.revision()
    first.revoke('https://example.com/', 'read')
    assert.equal(second.valid('https://example.com/', 'read', captured), false)
    assert.equal(second.decision('https://example.com/', 'read'), 'ask')
  })
)

persistedTest('literal missing marker in a policy file is treated as corrupt', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome)
    writeFileSync(join(browserHome, 'agent-policy.json'), 'MISSING', 'utf8')
    const policy = openPolicy(home)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)

posixTest('a group-writable browser directory cannot carry persistent grants', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome)
    chmodSync(browserHome, 0o770)
    const policy = openPolicy(home)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)

posixTest('a group-writable home cannot carry persistent grants', () =>
  withHome((home) => {
    chmodSync(home, 0o770)
    const policy = openPolicy(home)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)

posixTest('a group-writable ancestor cannot redirect a private policy home', () =>
  withHome((parent) => {
    const home = join(parent, 'nested-home')
    mkdirSync(home, { mode: 0o700 })
    chmodSync(parent, 0o770)
    const policy = openPolicy(home)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)
