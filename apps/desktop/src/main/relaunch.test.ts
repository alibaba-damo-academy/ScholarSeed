import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DomainNative } from '../../native/domains.cjs'
import {
  decodeUpdateLaunch,
  explicitUpdateProfile,
  persistUpdateLaunch,
  restoreUpdateLaunch,
  observeUpdateLaunch,
  updateLaunchDirectory,
  type LaunchIdentity,
} from './relaunch.ts'

const VALID = {
  schema: 1,
  uid: 501,
  application: '/Applications/ScholarSeed.app',
  bundleId: 'com.scholarseed.desktop',
  sourceBuild: '202610120719',
  targetBuild: '202610121003',
  candidate: 'release-candidate',
  at: 100,
  home: '/Users/test/数据',
  userData: '/Users/test/Profile with spaces',
  workspace: '/Users/test/Projects',
  identities: Array.from({ length: 3 }, () => 'posix:0000000000000001:0000000000000002'),
}
test('launch record contains only bounded storage selection, never arbitrary environment', () => {
  assert.deepEqual(decodeUpdateLaunch(Buffer.from(JSON.stringify(VALID))), VALID)
  for (const value of [
    { ...VALID, environment: { TOKEN: 'secret' } },
    { ...VALID, home: '../relative' },
    { ...VALID, identities: ['invented'] },
    { ...VALID, targetBuild: '' },
    { ...VALID, uid: 1.5 },
    { ...VALID, schema: 2 },
  ])
    assert.throws(() => decodeUpdateLaunch(Buffer.from(JSON.stringify(value))))
})
test('explicit profile is recognized in both Electron command line forms', () => {
  const profile = '/Users/test/中文 profile'
  assert.equal(explicitUpdateProfile(['ScholarSeed', `--user-data-dir=${profile}`]), profile)
  assert.equal(explicitUpdateProfile(['ScholarSeed', '--user-data-dir', profile]), profile)
  assert.equal(explicitUpdateProfile(['ScholarSeed', '--remote-debugging-port=19222']), undefined)
})

test('launch context accepts optional CDP port while preserving legacy records and rejecting invalid ports', () => {
  for (const debugPort of [0, 9222, 65535]) {
    const record = { ...VALID, debugPort }
    assert.deepEqual(decodeUpdateLaunch(Buffer.from(JSON.stringify(record))), record)
  }
  for (const debugPort of [-1, 65536, 1.5, '9222', null]) {
    assert.throws(() => decodeUpdateLaunch(Buffer.from(JSON.stringify({ ...VALID, debugPort }))))
  }
})

const CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000

function identityOf(path: string): string {
  const digest = createHash('sha256').update(path).digest('hex')
  return `posix:${digest.slice(0, 16)}:${digest.slice(16, 32)}`
}

/** Filesystem-backed DomainNative stand-in: real directories, path-derived lineage. */
class FsNative implements DomainNative {
  device = '0000000000000001'
  volume = '11111111111111111111111111111111'
  birth = '0000000000000001:00000000'
  constructor(private readonly aliases = new Map<string, string>()) {}
  pin(path: string, create: boolean): unknown {
    path = this.aliases.get(path) ?? path
    if (!existsSync(path)) {
      if (!create)
        throw Object.assign(new Error(`missing directory ${path}`), { code: 'ERR_LEASE_MISSING' })
      mkdirSync(path)
    }
    return { path }
  }
  lineage(pin: unknown): string[] {
    return [
      identityOf((pin as { path: string }).path).replace(/posix:[^:]+:/, `posix:${this.device}:`),
    ]
  }
  persistentIdentity(pin: unknown): string {
    const inode = identityOf((pin as { path: string }).path).split(':')[2]
    return `darwin:${this.volume}:${inode}:${this.birth}`
  }
  createAt(pin: unknown, name: string, bytes: Buffer): void {
    writeFileSync(join((pin as { path: string }).path, name), bytes)
  }
  createChild(pin: unknown, name: string): string {
    const child = join((pin as { path: string }).path, name)
    mkdirSync(child)
    return this.lineage({ path: child })[0]
  }
  acquireAt(pin: unknown, name: string, _exclusive: boolean): unknown {
    return { pin, name }
  }
  readAt(pin: unknown, name: string, maxBytes: number): Buffer | null {
    const file = join((pin as { path: string }).path, name)
    if (!existsSync(file)) return null
    const bytes = readFileSync(file)
    if (bytes.length > maxBytes) throw new Error(`record exceeds ${maxBytes} bytes`)
    return bytes
  }
  listAt(pin: unknown, maxEntries: number, maxBytes: number): Record<string, Buffer> {
    const directory = (pin as { path: string }).path
    const names = readdirSync(directory)
    if (names.length > maxEntries) throw new Error(`directory exceeds ${maxEntries} entries`)
    const records: Record<string, Buffer> = {}
    for (const name of names) {
      const bytes = readFileSync(join(directory, name))
      if (bytes.length > maxBytes) throw new Error(`record exceeds ${maxBytes} bytes`)
      records[name] = bytes
    }
    return records
  }
  release(_pin: unknown): void {}
}

function launchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ss-relaunch-'))
  const coordinator = join(root, 'coordination')
  mkdirSync(coordinator)
  const application = VALID.application
  const selection = {
    home: VALID.home,
    userData: VALID.userData,
    workspace: VALID.workspace,
  }
  // The record describes macOS even when its filesystem fixture runs on Windows.
  const aliases = new Map(Object.entries(selection).map(([name, path]) => [path, join(root, name)]))
  for (const path of aliases.values()) mkdirSync(path)
  const native = new FsNative(aliases)
  const identity: LaunchIdentity = {
    uid: 501,
    application,
    bundleId: 'com.scholarseed.desktop',
    build: '202610132132',
  }
  const target = '202610141029'
  const at = 1_760_000_000_000
  const directory = updateLaunchDirectory(coordinator, application)
  const contextPresent = (): boolean => existsSync(join(directory, 'context.json'))
  const persist = (): void => {
    persistUpdateLaunch(native, coordinator, identity, selection, target, 'candidate-id', at)
  }
  const setAt = (value: number) => {
    const path = join(directory, 'context.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), at: value }))
  }
  const restore = (build: string, explicit: { userData?: string } = {}) =>
    restoreUpdateLaunch(native, coordinator, { ...identity, build }, explicit)
  return {
    native,
    coordinator,
    identity,
    selection,
    target,
    at,
    directory,
    contextPresent,
    persist,
    restore,
    setAt,
    root,
  }
}

test('expired launch context remains bound to its custom profile until a proved outcome', () => {
  for (const build of ['202610132132', '202610141029', '202610150000']) {
    const fixture = launchFixture()
    try {
      fixture.persist()
      fixture.setAt(Date.now() - CONTEXT_MAX_AGE_MS - 1)
      if (build === '202610150000') assert.throws(() => fixture.restore(build), /build differs/)
      else assert.ok(fixture.restore(build))
      assert.equal(fixture.contextPresent(), true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test('trusted observation never validates mutable roots or removes aged profile context before admission', () => {
  for (const offset of [-16 * 60_000, -CONTEXT_MAX_AGE_MS - 1, CONTEXT_MAX_AGE_MS]) {
    const fixture = launchFixture()
    try {
      fixture.persist()
      const path = join(fixture.directory, 'context.json')
      const record = JSON.parse(readFileSync(path, 'utf8'))
      record.at = Date.now() + offset
      writeFileSync(path, JSON.stringify(record))
      const before = readFileSync(path)
      rmSync(join(fixture.root, 'workspace'), { recursive: true, force: true })
      const observed = observeUpdateLaunch(fixture.native, fixture.coordinator, fixture.identity)
      assert.equal(observed?.context.home, fixture.selection.home)
      assert.ok(readFileSync(path).equals(before))
      assert.throws(() => observed!.verify(), /missing directory/)
      assert.equal(fixture.contextPresent(), true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test('observed launch bytes must remain unchanged until directory restoration', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    const observed = observeUpdateLaunch(fixture.native, fixture.coordinator, fixture.identity)!
    const path = join(fixture.directory, 'context.json')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...record, candidate: 'changed-candidate' }))
    assert.throws(
      () =>
        restoreUpdateLaunch(fixture.native, fixture.coordinator, fixture.identity, {}, observed),
      /context changed/
    )
    assert.equal(fixture.contextPresent(), true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('explicit CDP port survives source-to-target handoff and is consumed once', () => {
  const fixture = launchFixture()
  try {
    persistUpdateLaunch(
      fixture.native,
      fixture.coordinator,
      fixture.identity,
      fixture.selection,
      fixture.target,
      'candidate-id',
      fixture.at,
      ['--remote-debugging-port=9222']
    )
    const source = fixture.restore(fixture.identity.build)
    assert.ok(source)
    assert.equal(source.context.debugPort, 9222)
    source.complete()
    assert.equal(fixture.contextPresent(), true)
    const target = fixture.restore(fixture.target)
    assert.ok(target)
    assert.equal(target.context.debugPort, 9222)
    target.complete()
    assert.equal(fixture.restore(fixture.target), null)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('handoff without explicit CDP does not persist a port', () => {
  const fixture = launchFixture()
  try {
    persistUpdateLaunch(
      fixture.native,
      fixture.coordinator,
      fixture.identity,
      fixture.selection,
      fixture.target,
      'candidate-id',
      fixture.at,
      []
    )
    const target = fixture.restore(fixture.target)
    assert.ok(target)
    assert.equal(Object.hasOwn(target.context, 'debugPort'), false)
    target.complete()
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('clock skew cannot erase a pending custom profile', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    fixture.setAt(Date.now() + CONTEXT_MAX_AGE_MS)
    assert.ok(fixture.restore('202610132132'))
    assert.equal(fixture.contextPresent(), true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('unrelated builds cannot fall back to a different profile or destroy the pending transaction', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    assert.throws(() => fixture.restore('202610150000'), /build differs/)
    assert.equal(fixture.contextPresent(), true)
    const source = fixture.restore('202610132132')
    assert.ok(source)
    source.complete()
    assert.equal(fixture.contextPresent(), true)
    const target = fixture.restore(fixture.target)
    assert.ok(target)
    assert.deepEqual(target.context.userData, fixture.selection.userData)
    target.complete()
    assert.equal(fixture.contextPresent(), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('explicit override cannot discard a pending transaction', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    assert.throws(
      () => fixture.restore('202610150000', { userData: join(fixture.root, 'other') }),
      /selection differs/
    )
    assert.equal(fixture.contextPresent(), true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('proved superseded launch preserves the original profile and consumes only after readiness', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    const observed = observeUpdateLaunch(fixture.native, fixture.coordinator, fixture.identity)!
    const restored = restoreUpdateLaunch(
      fixture.native,
      fixture.coordinator,
      { ...fixture.identity, build: '202610150000' },
      {},
      observed,
      'superseded'
    )
    assert.ok(restored)
    assert.equal(restored.context.home, fixture.selection.home)
    assert.equal(restored.context.userData, fixture.selection.userData)
    assert.equal(fixture.contextPresent(), true)
    restored.complete()
    assert.equal(fixture.contextPresent(), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('superseded admission cannot bypass explicit selection, older builds or changed context', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    const observed = observeUpdateLaunch(fixture.native, fixture.coordinator, fixture.identity)!
    const restore = (build: string, explicit = {}) =>
      restoreUpdateLaunch(
        fixture.native,
        fixture.coordinator,
        { ...fixture.identity, build },
        explicit,
        observed,
        'superseded'
      )
    assert.throws(() => restore('202610010000'), /build differs/)
    assert.throws(
      () => restore('202610150000', { home: join(fixture.root, 'other') }),
      /selection differs/
    )
    const path = join(fixture.directory, 'context.json')
    const original = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...original, candidate: 'replacement' }))
    assert.throws(() => restore('202610150000'), /context changed/)
    assert.equal(fixture.contextPresent(), true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('identity mismatch remains a hard refusal', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    assert.throws(
      () =>
        restoreUpdateLaunch(
          fixture.native,
          fixture.coordinator,
          { ...fixture.identity, uid: 502 },
          {}
        ),
      /identity differs/
    )
    assert.equal(fixture.contextPresent(), true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('retry of the identical launch preserves the pending bytes even if the retry aborts', () => {
  const f = launchFixture()
  try {
    f.persist()
    const path = join(f.directory, 'context.json')
    const before = readFileSync(path)
    const cancel = persistUpdateLaunch(
      f.native,
      f.coordinator,
      f.identity,
      f.selection,
      f.target,
      'candidate-id',
      f.at + 1,
      []
    )
    assert.deepEqual(readFileSync(path), before)
    cancel()
    assert.deepEqual(readFileSync(path), before)
    f.restore(f.target)!.complete()
    assert.equal(f.contextPresent(), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('an installed target can hand off its next update before the old readiness acknowledgement', () => {
  const f = launchFixture()
  try {
    f.persist()
    const previous = f.restore(f.target)!
    const cancel = persistUpdateLaunch(
      f.native,
      f.coordinator,
      { ...f.identity, build: f.target },
      f.selection,
      '202610151029',
      'next-candidate',
      f.at + 1,
      []
    )
    const record = decodeUpdateLaunch(readFileSync(join(f.directory, 'context.json')))
    assert.equal(record.sourceBuild, f.target)
    assert.equal(record.targetBuild, '202610151029')
    assert.equal(record.candidate, 'next-candidate')
    assert.throws(() => previous.complete(), /context changed/)
    assert.equal(f.contextPresent(), true)
    cancel()
    assert.equal(f.restore(f.target)!.context.userData, f.selection.userData)
    previous.complete()
    assert.equal(f.contextPresent(), false)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('pending retry refuses conflicting candidate, builds, debug port, account and storage identity', () => {
  for (const patch of [
    { candidate: 'other-candidate' },
    { targetBuild: '202610151029' },
    { sourceBuild: '202610131000' },
    { uid: 502 },
    { bundleId: 'other.bundle' },
    { debugPort: 9222 },
    { home: '/Users/other' },
    { identities: VALID.identities },
  ]) {
    const f = launchFixture()
    try {
      f.persist()
      const path = join(f.directory, 'context.json')
      const record = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...record, ...patch }))
      const before = readFileSync(path)
      assert.throws(() =>
        persistUpdateLaunch(
          f.native,
          f.coordinator,
          f.identity,
          f.selection,
          f.target,
          'candidate-id',
          f.at + 1,
          []
        )
      )
      assert.deepEqual(readFileSync(path), before)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
})

const SHIPIT_GRACE_MS = 15 * 60 * 1000

test('update launch survives reboot device renumbering without changing storage selection', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    fixture.native.device = '0000000000000042'
    const restored = fixture.restore(fixture.target)!
    assert.equal(restored.context.home, fixture.selection.home)
    assert.equal(restored.context.userData, fixture.selection.userData)
    assert.equal(restored.context.workspace, fixture.selection.workspace)
    restored.complete()
    assert.equal(fixture.contextPresent(), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('persistent launch identity rejects a different volume or reused directory inode', () => {
  for (const field of ['volume', 'birth'] as const) {
    const fixture = launchFixture()
    try {
      fixture.persist()
      fixture.native[field] = fixture.native[field].replace(/1/g, '2')
      assert.throws(() => fixture.restore(fixture.target), /directory was replaced/)
      assert.equal(fixture.contextPresent(), true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test('legacy launch records retain full device and inode checks', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    const path = join(fixture.directory, 'context.json')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    record.schema = 1
    record.identities = ['home', 'userData', 'workspace'].map(
      (name) => fixture.native.lineage({ path: join(fixture.root, name) })[0]
    )
    writeFileSync(path, JSON.stringify(record))
    assert.ok(fixture.restore(fixture.target))
    fixture.native.device = '0000000000000042'
    assert.throws(() => fixture.restore(fixture.target), /directory was replaced/)
    assert.equal(fixture.contextPresent(), true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('stable launch identities reject malformed records and unavailable native support', () => {
  const stable =
    'darwin:11111111111111111111111111111111:0000000000000002:0000000000000001:00000000'
  const record = { ...VALID, schema: 2, identities: [stable, stable, stable] }
  assert.deepEqual(decodeUpdateLaunch(Buffer.from(JSON.stringify(record))), record)
  for (const identities of [
    [stable],
    [stable, stable, 'posix:0000000000000001:0000000000000002'],
    [stable, stable, `${stable}:extra`],
  ]) {
    assert.throws(() => decodeUpdateLaunch(Buffer.from(JSON.stringify({ ...record, identities }))))
  }
  const fixture = launchFixture()
  try {
    fixture.native.persistentIdentity = () => {
      throw new Error('volume identity unavailable')
    }
    assert.throws(fixture.persist, /volume identity unavailable/)
    assert.equal(fixture.contextPresent(), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('non-target launches past the handoff grace cannot destroy the pending transaction', () => {
  for (const build of ['202610132132', '202610150000']) {
    const fixture = launchFixture()
    try {
      fixture.persist()
      fixture.setAt(Date.now() - SHIPIT_GRACE_MS - 60_000)
      if (build === fixture.identity.build) assert.ok(fixture.restore(build))
      else assert.throws(() => fixture.restore(build), /build differs/)
      assert.equal(fixture.contextPresent(), true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test('within the handoff grace source recovery and third-build retention still apply', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    fixture.setAt(Date.now() - 10 * 60_000)
    assert.throws(() => fixture.restore('202610150000'), /build differs/)
    assert.equal(fixture.contextPresent(), true)
    const source = fixture.restore('202610132132')
    assert.ok(source)
    source.complete()
    assert.equal(fixture.contextPresent(), true)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('target workbench acknowledgement consumes even a long-lived launch context', () => {
  const fixture = launchFixture()
  try {
    fixture.persist()
    fixture.setAt(Date.now() - 2 * CONTEXT_MAX_AGE_MS)
    const target = fixture.restore(fixture.target)
    assert.ok(target)
    target.complete()
    assert.equal(fixture.contextPresent(), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
