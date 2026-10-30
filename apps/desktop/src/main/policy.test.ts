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
import { join } from 'node:path'
import test from 'node:test'

import { createBrowserPolicy, normalizePolicyOrigin } from './policy.ts'
import { createBrowserReadGrants } from './grant.ts'
import { emptyPolicy, parsePolicy } from './policy-record.ts'

const PYTHON = '/usr/bin/python3'
const persistedTest = process.platform === 'win32' ? test.skip : test
const DEFAULT_SITES = [
  { origin: 'https://www.bing.com', read: 'allow', interact: 'allow' },
  { origin: 'https://cn.bing.com', read: 'allow', interact: 'allow' },
]

persistedTest(
  'atomic policy inspection returns a coherent decision and revision without caching revocations',
  () =>
    withHome((home) => {
      const policy = createBrowserPolicy(home, PYTHON)
      const original = policy.inspect('https://www.bing.com', 'read')
      assert.equal(original.decision, 'allow')
      const other = createBrowserPolicy(home, PYTHON)
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
      const policy = createBrowserPolicy(home, PYTHON)
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
      const restored = createBrowserPolicy(home, PYTHON)
      assert.equal(restored.agentUseEnabled(), false)
      assert.equal(restored.decision('https://www.bing.com', 'read'), 'block')
      restored.setAgentBrowserUse(true)
      restored.set('https://cn.bing.com', 'interact', 'block')
      assert.equal(
        createBrowserPolicy(home, PYTHON).effectiveDecision('https://cn.bing.com', 'interact'),
        'block'
      )
      restored.remove('https://cn.bing.com')
      assert.equal(
        createBrowserPolicy(home, PYTHON).effectiveDecision('https://cn.bing.com', 'read'),
        'ask'
      )
      assert.equal(
        createBrowserPolicy(home, PYTHON).effectiveDecision('https://cn.bing.com', 'interact'),
        'ask'
      )
      restored.remove('https://www.bing.com')
      assert.equal(
        createBrowserPolicy(home, PYTHON).effectiveDecision('https://www.bing.com', 'read'),
        'ask'
      )
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
      const policy = createBrowserPolicy(home, PYTHON)
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
  const home = mkdtempSync(join(tmpdir(), 'scholarseed-browser-policy-'))
  try {
    run(realpathSync.native(home))
  } finally {
    rmSync(home, { recursive: true, force: true })
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
    const policy = createBrowserPolicy(home, PYTHON)
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
      const policy = createBrowserPolicy(home, PYTHON)
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
      assert.equal(createBrowserPolicy(home, PYTHON).snapshot().agentBrowserUseEnabled, false)
      assert.equal(
        JSON.parse(readFileSync(join(browserHome, 'agent-policy.json'), 'utf8')).schemaVersion,
        2
      )
    })
)

persistedTest('disabling Agent Browser Use invalidates a live snapshot read lease', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scholarseed-browser-policy-'))
  try {
    const policy = createBrowserPolicy(realpathSync.native(home), PYTHON)
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
      policy: (origin) => ({
        revision: policy.revision(),
        decision: policy.effectiveDecision(origin, 'read'),
      }),
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
    policy.setAgentBrowserUse(false)
    assert.equal(grants.validateAuthority(authority), false)
    assert.throws(() => grants.readAuthority({ scope, tabId: 'tab', snapshotId: 'snapshot' }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

persistedTest('block takes precedence over a prior allow and submit always asks', () =>
  withHome((home) => {
    const policy = createBrowserPolicy(home, PYTHON)
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
      const first = createBrowserPolicy(firstHome, PYTHON)
      first.set('https://example.com/', 'interact', 'allow')
      assert.equal(
        createBrowserPolicy(firstHome, PYTHON).decision('https://example.com/', 'interact'),
        'allow'
      )
      assert.equal(
        createBrowserPolicy(secondHome, PYTHON).decision('https://example.com/', 'interact'),
        'ask'
      )
    })
  )
)

persistedTest('corrupt stored policy fails closed and cannot be silently overwritten', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome)
    writeFileSync(join(browserHome, 'agent-policy.json'), '{bad json', 'utf8')
    const policy = createBrowserPolicy(home, PYTHON)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
    assert.equal(readFileSync(join(browserHome, 'agent-policy.json'), 'utf8'), '{bad json')
  })
)

persistedTest('world-writable policy file cannot grant access or be overwritten', () =>
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
    const policy = createBrowserPolicy(home, PYTHON)
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
    const policy = createBrowserPolicy(home, PYTHON)
    policy.set('https://example.com/', 'read', 'allow')
    const captured = policy.revision()
    policy.revoke('https://example.com/', 'read')
    assert.ok(policy.revision() > captured)
    assert.equal(policy.valid('https://example.com/', 'read', captured), false)
    assert.equal(policy.decision('https://example.com/', 'read'), 'ask')
    assert.deepEqual(policy.sites(), DEFAULT_SITES)
    assert.equal(createBrowserPolicy(home, PYTHON).decision('https://example.com/', 'read'), 'ask')
  })
)

persistedTest('policy revision observer fires for local and external revocation', () =>
  withHome((home) => {
    const policy = createBrowserPolicy(home, PYTHON)
    const other = createBrowserPolicy(home, PYTHON)
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
    const policy = createBrowserPolicy(home, PYTHON)
    policy.set('https://example.com', 'read', 'allow')
    policy.set('https://example.com', 'interact', 'block')
    const previous = policy.revision()
    policy.remove('https://example.com')
    assert.equal(policy.revision(), previous + 1)
    assert.deepEqual(policy.sites(), DEFAULT_SITES)
    assert.equal(createBrowserPolicy(home, PYTHON).decision('https://example.com', 'read'), 'ask')
    assert.equal(
      createBrowserPolicy(home, PYTHON).decision('https://example.com', 'interact'),
      'ask'
    )
  })
)

persistedTest('a failed policy write invalidates prior allow in memory', () =>
  withHome((home) =>
    withHome((otherHome) => {
      const policy = createBrowserPolicy(home, PYTHON)
      policy.set('https://example.com/', 'read', 'allow')
      renameSync(join(home, 'browser'), join(home, 'browser-old'))
      symlinkSync(otherHome, join(home, 'browser'))
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
      const policy = createBrowserPolicy(home, PYTHON)
      policy.set('https://example.com/', 'read', 'allow')
      const captured = policy.revision()
      renameSync(join(home, 'browser'), join(home, 'browser-old'))
      symlinkSync(otherHome, join(home, 'browser'))
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
        const policy = createBrowserPolicy(home, PYTHON)
        policy.setAgentBrowserUse(true)
        policy.set('https://example.com/', 'read', 'allow')
        const captured = policy.revision()
        renameSync(join(home, 'browser'), join(home, 'browser-old'))
        symlinkSync(otherHome, join(home, 'browser'))
        assert.equal(policy.valid('https://example.com/', 'read', captured), false)
        assert.equal(policy.effectiveDecision('https://example.com/', 'read'), 'block')
        rmSync(join(home, 'browser'))
        renameSync(join(home, 'browser-old'), join(home, 'browser'))
        const other = createBrowserPolicy(home, PYTHON)
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
    const policy = createBrowserPolicy(home, PYTHON)
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

persistedTest('a revision conflict refreshes before retrying without restoring a revoke', () =>
  withHome((home) => {
    const first = createBrowserPolicy(home, PYTHON)
    first.set('https://example.com/', 'read', 'allow')
    const second = createBrowserPolicy(home, PYTHON)
    let conflicted = false
    const competingOrigin = {
      toString: () => {
        if (!conflicted) {
          conflicted = true
          second.revoke('https://example.com/', 'read')
        }
        return 'https://other.example/'
      },
    } as unknown as string
    first.set(competingOrigin, 'interact', 'allow')
    const latest = createBrowserPolicy(home, PYTHON)
    assert.equal(latest.decision('https://example.com/', 'read'), 'ask')
    assert.equal(latest.decision('https://other.example/', 'interact'), 'allow')
    assert.equal(first.revision(), latest.revision())
  })
)

persistedTest('symlinked browser policy directory is not followed', () =>
  withHome((home) =>
    withHome((otherHome) => {
      symlinkSync(otherHome, join(home, 'browser'))
      const policy = createBrowserPolicy(home, PYTHON)
      assert.equal(policy.decision('https://example.com/', 'read'), 'block')
      assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
    })
  )
)

test('missing secure filesystem transport never grants persistent access', () =>
  withHome((home) => {
    const policy = createBrowserPolicy(home, null)
    assert.throws(() => policy.agentUseEnabled(), /browser_policy_io_unavailable/)
    assert.throws(() => policy.agentUseRevision(), /browser_policy_io_unavailable/)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.equal(policy.decision('https://example.com/', 'submit'), 'ask')
    assert.throws(() => policy.revision(), /browser_policy_io_unavailable/)
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  }))

persistedTest('a stale process preserves another process revoke when updating another site', () =>
  withHome((home) => {
    const first = createBrowserPolicy(home, PYTHON)
    first.set('https://example.com/', 'read', 'allow')
    const stale = createBrowserPolicy(home, PYTHON)
    first.revoke('https://example.com/', 'read')
    stale.set('https://other.example/', 'interact', 'allow')
    assert.equal(createBrowserPolicy(home, PYTHON).decision('https://example.com/', 'read'), 'ask')
    assert.equal(stale.decision('https://other.example/', 'interact'), 'allow')
  })
)

persistedTest('a stale no-op revoke refreshes before deciding there is nothing to write', () =>
  withHome((home) => {
    const stale = createBrowserPolicy(home, PYTHON)
    const other = createBrowserPolicy(home, PYTHON)
    other.set('https://example.com/', 'read', 'allow')
    stale.revoke('https://example.com/', 'read')
    assert.equal(createBrowserPolicy(home, PYTHON).decision('https://example.com/', 'read'), 'ask')
  })
)

persistedTest('a live policy notices external revoke before validating captured allow', () =>
  withHome((home) => {
    const first = createBrowserPolicy(home, PYTHON)
    first.set('https://example.com/', 'read', 'allow')
    const second = createBrowserPolicy(home, PYTHON)
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
    const policy = createBrowserPolicy(home, PYTHON)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)

persistedTest('a group-writable browser directory cannot carry persistent grants', () =>
  withHome((home) => {
    const browserHome = join(home, 'browser')
    mkdirSync(browserHome)
    chmodSync(browserHome, 0o770)
    const policy = createBrowserPolicy(home, PYTHON)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)

persistedTest('a group-writable home cannot carry persistent grants', () =>
  withHome((home) => {
    chmodSync(home, 0o770)
    const policy = createBrowserPolicy(home, PYTHON)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)

persistedTest('a group-writable ancestor cannot redirect a private policy home', () =>
  withHome((parent) => {
    const home = join(parent, 'nested-home')
    mkdirSync(home, { mode: 0o700 })
    chmodSync(parent, 0o770)
    const policy = createBrowserPolicy(home, PYTHON)
    assert.equal(policy.decision('https://example.com/', 'read'), 'block')
    assert.throws(() => policy.set('https://example.com/', 'read', 'allow'))
  })
)
