import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import {
  VaultOwner,
  VAULT_FORMAT,
  deriveVaultKey,
  encryptVault,
  decryptVault,
  vaultEnvelope,
  decodeVaultPayload,
  validateVaultPayload,
  vaultKdfBusy,
} from './vault.ts'
import type { StoreObservation, StorePort, StoreTerminal } from './vaultstorage.ts'

test('Main authenticated vault owner implementation exists', () => {
  assert.equal(existsSync(new URL('./vault.ts', import.meta.url)), true)
})

const payload = { version: 1, records: [], settings: { autofill: false, sites: [] } }
const password = 'actual master password 123'
test('async status and diagnostic rejection cannot become unhandled or skip remaining revoke listeners', async () => {
  const owner = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: async () => {
      throw new Error('private')
    },
    revokeFailure: async () => {
      throw new Error('private diagnostic')
    },
  })
  let last = false
  owner.onRevoke(() => {
    throw new Error('private')
  })
  owner.onRevoke(() => {
    last = true
  })
  owner.lock()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(last, true)
})
test('revocation isolates throwing and rejecting listeners and status consumers after synchronous secret revoke', async () => {
  let published = false
  let last = false
  const owner = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: () => {
      published = true
      throw new Error('private')
    },
  })
  owner.onRevoke(() => {
    throw new Error('private')
  })
  owner.onRevoke(async () => {
    throw new Error('private')
  })
  owner.onRevoke(() => {
    last = true
  })
  const before = owner.status().generation
  assert.doesNotThrow(() => owner.lock())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(last, true)
  assert.equal(published, true)
  assert.equal(owner.status().generation, before + 1)
  assert.notEqual(owner.status().state, 'locking')
  assert.equal(owner.listMetadata(), null)
})
function storageFixture() {
  let body: Buffer | null = null
  let live = true
  let sequence = 0
  let writes = 0
  const digest = () => (body ? createHash('sha256').update(body).digest('hex') : null)
  const terminal = (observed: StoreObservation, verb: 'replace' | 'remove'): StoreTerminal => ({
    operationId: observed.operationId,
    sequence: observed.sequence,
    verb,
    outcome: 'committed',
    resultPresence: body ? 'present' : 'absent',
    result: { digest: digest(), identity: body ? ['1', '1'] : null },
    durability: 'namespace-synced',
  })
  const port: StorePort = {
    kind: 'vault',
    generation: 1,
    budget: VAULT_FORMAT.fileBytes,
    current: () => live,
    read: async () => ({
      bytes: Buffer.from(body ?? []),
      digest: digest(),
      token: 'token',
      operationId: 'operation',
      sequence: ++sequence,
    }),
    replace: async (observed, bytes, current) => {
      if (current && !current()) throw new Error('revoked')
      if (observed.digest !== digest()) throw new Error('browser_storage_conflict')
      writes++
      body = Buffer.from(bytes)
      return terminal(observed, 'replace')
    },
    removeConfirmed: async (observed, current) => {
      if (current && !current()) throw new Error('revoked')
      if (observed.digest !== digest()) throw new Error('browser_storage_conflict')
      writes++
      body = null
      return terminal(observed, 'remove')
    },
    inspect: async () => {
      throw new Error('browser_storage_unknown')
    },
  }
  return {
    port,
    bytes: () => body && Buffer.from(body),
    writes: () => writes,
    write: (bytes: Buffer) => {
      body = Buffer.from(bytes)
    },
    retire: () => {
      live = false
    },
  }
}
test('binary magic is exact including high-bit mutations before KDF', () => {
  const bytes = encryptVault(payload, randomBytes(32), randomBytes(32))
  bytes[0] |= 128
  assert.throws(() => vaultEnvelope(bytes), /invalid_format/)
})
for (const completion of ['resolve', 'reject'] as const) {
  test(`initial availability read ${completion} after ordinary lock gets one fresh observation`, async () => {
    const storage = storageFixture()
    let finish: () => void = () => undefined
    let reads = 0
    const initial = new Promise<void>((resolve, reject) => {
      finish =
        completion === 'resolve' ? resolve : () => reject(new Error('browser_storage_unavailable'))
    })
    const port: StorePort = {
      ...storage.port,
      read: async () => {
        reads++
        if (reads === 1) await initial
        return storage.port.read()
      },
    }
    const owner = new VaultOwner({
      current: () => true,
      debug: () => null,
      publish: () => undefined,
    })
    const binding = owner.bindStore(port)
    owner.lock()
    finish()
    await binding
    assert.equal(reads, 2)
    assert.equal(owner.status().state, 'uninitialized')
    assert.equal(owner.listMetadata(), null)
    assert.equal((await owner.begin('create', () => true)).intent, 'create')
    assert.equal(storage.writes(), 0)
    owner.dispose()
  })
}
test('availability cancellation is bounded and deduplicated; focused observation never revives metadata', async () => {
  const storage = storageFixture()
  let reads = 0
  let focus = true
  const port: StorePort = {
    ...storage.port,
    read: async () => {
      reads++
      owner.lock()
      return storage.port.read()
    },
  }
  const owner: VaultOwner = new VaultOwner({
    current: () => focus,
    debug: () => null,
    publish: () => undefined,
  })
  await owner.bindStore(port)
  assert.equal(reads, 2)
  assert.equal(owner.status().state, 'unavailable')
  focus = false
  await owner.refresh()
  assert.equal(reads, 2)
  focus = true
  await owner.refresh()
  assert.equal(reads, 4)
  assert.equal(owner.listMetadata(), null)
  owner.dispose()
})
test('same live Store availability probes share one pending read', async () => {
  const storage = storageFixture()
  let finish: () => void = () => undefined
  let reads = 0
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  const port: StorePort = {
    ...storage.port,
    read: async () => {
      reads++
      await wait
      return storage.port.read()
    },
  }
  const owner = new VaultOwner({ current: () => true, debug: () => null, publish: () => undefined })
  const binding = owner.bindStore(port)
  const probes = [owner.refresh(), owner.refresh(), owner.refresh()]
  assert.equal(reads, 1)
  finish()
  await Promise.all([binding, ...probes])
  assert.equal(reads, 1)
  assert.equal(owner.status().state, 'uninitialized')
  owner.dispose()
})
test('old background availability result cannot overwrite unknown mutation after ordinary lock or focus', async () => {
  const storage = storageFixture()
  let finish: () => void = () => undefined
  let reads = 0
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  const port: StorePort = {
    ...storage.port,
    read: async () => {
      reads++
      if (reads === 2) await wait
      return storage.port.read()
    },
    replace: async () => {
      throw new Error('browser_storage_unknown')
    },
    inspect: async () => {
      throw new Error('browser_storage_unknown')
    },
  }
  const owner = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: () => undefined,
    derive: async () => randomBytes(32),
  })
  await owner.bindStore(port)
  const pending = owner.refresh()
  const reply = await owner.submit(
    await owner.begin('create', () => true),
    password,
    password,
    () => true
  )
  assert.deepEqual(reply, { ok: false, error: 'unknown' })
  const before = owner.status()
  finish()
  await pending
  assert.deepEqual(owner.status(), before)
  owner.lock()
  await owner.refresh()
  assert.equal(owner.status().state, 'unavailable')
  assert.equal(reads, 3)
  assert.equal(owner.listMetadata(), null)
  owner.dispose()
})
test('stale availability completion cannot overwrite rebind, retirement, debug or asset revocation', async () => {
  for (const action of ['rebind', 'retire', 'debug', 'assets'] as const) {
    const storage = storageFixture()
    let finish: () => void = () => undefined
    let reads = 0
    const wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    const port: StorePort = {
      ...storage.port,
      read: async () => {
        reads++
        await wait
        return storage.port.read()
      },
    }
    const owner = new VaultOwner({
      current: () => true,
      debug: () => null,
      publish: () => undefined,
    })
    const old = owner.bindStore(port)
    if (action === 'rebind') await owner.bindStore(storageFixture().port)
    else if (action === 'retire') {
      storage.retire()
      await owner.bindStore(null)
    } else owner.lock(action === 'debug' ? 'debug_unsafe' : 'protected_assets_unavailable')
    const before = owner.status()
    finish()
    await old
    assert.deepEqual(owner.status(), before)
    assert.equal(reads, 1)
    assert.equal(owner.listMetadata(), null)
    if (action === 'debug' || action === 'assets') {
      owner.lock()
      await owner.refresh()
      assert.equal(reads, 1)
    }
    owner.dispose()
  }
})
test('actual fixed scrypt profile authenticates header/tag, rejects wrong password and never reinitializes', async () => {
  const storage = storageFixture()
  const owner = new VaultOwner({ current: () => true, debug: () => null, publish: () => undefined })
  await owner.bindStore(storage.port)
  assert.equal(owner.status().state, 'uninitialized')
  const creation = await owner.begin('create', () => true)
  assert.equal((await owner.submit(creation, password, password, () => true)).ok, true)
  const bytes = storage.bytes()!
  assert.equal(bytes.subarray(0, 8).toString(), 'SSVLTBIN')
  assert.equal(bytes.includes(Buffer.from(password)), false)
  owner.lock()
  assert.equal(owner.listMetadata(), null)
  assert.equal(
    (
      await owner.submit(
        await owner.begin('unlock', () => true),
        'incorrect password',
        undefined,
        () => true
      )
    ).ok,
    false
  )
  assert.deepEqual(storage.bytes(), bytes)
  assert.equal(storage.writes(), 1)
  assert.equal(owner.status().state, 'locked')
  const restart = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: () => undefined,
  })
  await restart.bindStore(storage.port)
  assert.equal(restart.status().state, 'locked')
  assert.equal(
    (
      await restart.submit(
        await restart.begin('unlock', () => true),
        password,
        undefined,
        () => true
      )
    ).ok,
    true
  )
  assert.equal(restart.listMetadata()?.count, 0)
  owner.dispose()
  restart.dispose()
})
test('AEAD original raw header and tag are authenticated and each save gets a fresh nonce', async () => {
  const salt = randomBytes(32)
  const key = await deriveVaultKey(Buffer.from(password), salt)
  try {
    const first = encryptVault(payload, key, salt)
    const second = encryptVault(payload, key, salt)
    assert.notDeepEqual(first.subarray(44, 56), second.subarray(44, 56))
    assert.deepEqual(decryptVault(first, key), payload)
    for (const offset of [0, 8, 10, 12, 44, 56, 60, first.length - 1]) {
      const changed = Buffer.from(first)
      changed[offset] ^= 1
      assert.throws(() => decryptVault(changed, key), /invalid_format|authentication_failed/)
    }
    assert.throws(() => vaultEnvelope(Buffer.concat([first, Buffer.from([0])])), /invalid_format/)
    assert.throws(() => vaultEnvelope(Buffer.alloc(VAULT_FORMAT.fileBytes + 1)), /invalid_format/)
  } finally {
    key.fill(0)
  }
})
test('authenticated payload rejects duplicate keys, unknown fields, nesting and record uniqueness violations', () => {
  assert.throws(
    () =>
      decodeVaultPayload(
        Buffer.from(
          '{"version":1,"version":1,"records":[],"settings":{"autofill":false,"sites":[]}}'
        )
      ),
    /invalid_format/
  )
  assert.throws(
    () => decodeVaultPayload(Buffer.from('['.repeat(17) + '0' + ']'.repeat(17))),
    /invalid_format/
  )
  assert.throws(() => decodeVaultPayload(Buffer.from([255])), /invalid_format/)
  assert.throws(() => validateVaultPayload({ ...payload, extra: true }), /invalid_format/)
  const record = {
    kind: 'password',
    id: '00000000-0000-0000-0000-000000000001',
    name: 'title',
    origin: 'https://example.org',
    username: 'user',
    password: 'secret',
  }
  assert.equal(validateVaultPayload({ ...payload, records: [record] }).records.length, 1)
  assert.throws(
    () =>
      validateVaultPayload({
        ...payload,
        records: [record, { ...record, id: '00000000-0000-0000-0000-000000000002' }],
      }),
    /invalid_format/
  )
  for (const origin of [
    'http://example.org',
    'https://example.org/path',
    'https://user:password@example.org',
    'https://example.org?secret',
  ]) {
    assert.throws(
      () => validateVaultPayload({ ...payload, records: [{ ...record, origin }] }),
      /invalid_format/
    )
  }
  assert.throws(
    () => validateVaultPayload({ ...payload, records: Array(10001).fill(record) }),
    /invalid_format/
  )
})
test('single process KDF latch persists across lock and new owners until callback actually settles', async () => {
  const storage = storageFixture()
  let release: (key: Buffer) => void = () => undefined
  let started: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    started = resolve
  })
  const derive = () => {
    started()
    return new Promise<Buffer>((resolve) => {
      release = resolve
    })
  }
  const first = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: () => undefined,
    derive,
  })
  await first.bindStore(storage.port)
  const pending = first.submit(
    await first.begin('create', () => true),
    password,
    password,
    () => true
  )
  await reached
  first.lock()
  assert.equal(vaultKdfBusy(), true)
  const second = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: () => undefined,
    derive,
  })
  await second.bindStore(storage.port)
  assert.deepEqual(
    await second.submit(await second.begin('create', () => true), password, password, () => true),
    { ok: false, error: 'busy' }
  )
  const key = Buffer.alloc(32, 7)
  release(key)
  assert.deepEqual(await pending, { ok: false, error: 'revoked' })
  assert.equal(vaultKdfBusy(), false)
  assert.equal(
    key.every((byte) => byte === 0),
    true
  )
  assert.equal(storage.writes(), 0)
  assert.notEqual(first.status().state, 'unlocked')
  first.dispose()
  second.dispose()
})
test('fresh reset observation cancels with zero writes and conflict preserves concurrent ciphertext', async () => {
  const storage = storageFixture()
  storage.write(Buffer.from('malformed opaque file'))
  const owner = new VaultOwner({ current: () => true, debug: () => null, publish: () => undefined })
  await owner.bindStore(storage.port)
  const cancelled = await owner.begin('reset', () => true)
  owner.lock()
  assert.equal((await owner.reset(cancelled, () => true)).ok, false)
  assert.equal(storage.writes(), 0)
  const conflicted = await owner.begin('reset', () => true)
  storage.write(Buffer.from('new opaque file'))
  assert.deepEqual(await owner.reset(conflicted, () => true), { ok: false, error: 'conflict' })
  assert.equal(storage.bytes()?.toString(), 'new opaque file')
  const fresh = await owner.begin('reset', () => true)
  assert.equal((await owner.reset(fresh, () => true)).ok, true)
  assert.equal(owner.status().state, 'uninitialized')
  owner.dispose()
})

test('unknown mutation uses original inspect without retry and unresolved result never creates or unlocks', async () => {
  const storage = storageFixture()
  let mutations = 0
  let inspections = 0
  const port: StorePort = {
    ...storage.port,
    replace: async () => {
      mutations++
      throw new Error('browser_storage_unknown')
    },
    inspect: async (operationId, sequence) => {
      inspections++
      assert.equal(operationId, 'operation')
      assert.equal(sequence, 2)
      throw new Error('browser_storage_unknown')
    },
  }
  const owner = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: () => undefined,
    derive: async () => randomBytes(32),
  })
  await owner.bindStore(port)
  assert.deepEqual(
    await owner.submit(await owner.begin('create', () => true), password, password, () => true),
    { ok: false, error: 'unknown' }
  )
  assert.equal(mutations, 1)
  assert.equal(inspections, 1)
  assert.equal(storage.bytes(), null)
  assert.equal(owner.status().state, 'unavailable')
  await assert.rejects(
    owner.begin('create', () => true),
    /unknown|unavailable/
  )
  owner.dispose()
})
test('vault rejects a downloads port even if its projected budget is large enough', async () => {
  const storage = storageFixture()
  let reads = 0
  const wrong: StorePort = {
    ...storage.port,
    kind: 'downloads',
    read: async () => {
      reads++
      return storage.port.read()
    },
  }
  const owner = new VaultOwner({ current: () => true, debug: () => null, publish: () => undefined })
  await owner.bindStore(wrong)
  await assert.rejects(
    owner.begin('create', () => true),
    /unavailable/
  )
  assert.equal(reads, 0)
  owner.dispose()
})
test('background observation cannot downgrade an unlocked owner or retain a hidden key', async () => {
  const storage = storageFixture()
  const owner = new VaultOwner({
    current: () => true,
    debug: () => null,
    publish: () => undefined,
    derive: async () => randomBytes(32),
  })
  await owner.bindStore(storage.port)
  assert.equal(
    (await owner.submit(await owner.begin('create', () => true), password, password, () => true))
      .ok,
    true
  )
  await owner.refresh()
  assert.equal(owner.status().state, 'unlocked')
  assert.equal(owner.listMetadata()?.count, 0)
  owner.dispose()
})
test('prebudget invalid profile prevents KDF; dynamic debug after KDF prevents any store mutation', async () => {
  const storage = storageFixture()
  let derivations = 0
  let unsafe = false
  const owner = new VaultOwner({
    current: () => true,
    debug: () => (unsafe ? 'debug_unsafe' : null),
    publish: () => undefined,
    derive: async () => {
      derivations++
      unsafe = true
      return randomBytes(32)
    },
  })
  await owner.bindStore(storage.port)
  assert.deepEqual(
    await owner.submit(await owner.begin('create', () => true), password, password, () => true),
    { ok: false, error: 'debug_unsafe' }
  )
  assert.equal(storage.writes(), 0)
  unsafe = false
  const bytes = encryptVault(payload, randomBytes(32), randomBytes(32))
  bytes.writeUInt16BE(65535, 10)
  storage.write(bytes)
  await owner.bindStore(storage.port)
  await assert.rejects(
    owner.begin('unlock', () => true),
    /invalid_format/
  )
  assert.equal(derivations, 1)
  assert.equal(storage.writes(), 0)
  owner.dispose()
})
