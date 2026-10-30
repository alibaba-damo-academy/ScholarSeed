import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AuthenticationOwner, accessDigest, parseRefreshPayload, refreshPayload, createRefreshPersistence } from './authentication.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

function fixture() {
  let access = 'A'
  let refresh = parseRefreshPayload(refreshPayload('A', 'refresh-A'))
  let authority = Object.freeze({ cookieUrl: 'http://serve.test/', serveBase: 'http://serve.test', namespace: 'test' })
  let failedRemove = false
  let persistence: 'persisted' | 'unavailable' | 'failed' = 'persisted'
  let readGate: Promise<void> | undefined
  let setGate: Promise<void> | undefined
  let httpGate: Promise<void> | undefined
  let finalReadGate: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined
  let httpResponse = Response.json({ ok: false })
  const writes: string[] = []
  const revocations: string[] = []
  const requests: Array<{ url: string; init: RequestInit }> = []
  const owner = new AuthenticationOwner({
    authority: () => authority,
    readAccess: async () => {
      if (readGate) await readGate
      if (!access && finalReadGate) { finalReadGate.entered.resolve(); await finalReadGate.release.promise }
      return access
    },
    setAccess: async (_authority, token) => { writes.push(`cookie:${token}`); if (setGate) await setGate; access = token },
    removeAccess: async () => { writes.push('cookie:remove'); access = '' },
    persistence: {
      read: () => refresh,
      write: (_namespace, token, nextAccess) => {
        writes.push(`refresh:${token}`)
        if (persistence === 'persisted') refresh = parseRefreshPayload(refreshPayload(nextAccess, token))
        return { status: persistence }
      },
      remove: () => { writes.push('refresh:remove'); if (failedRemove) return { status: 'failed' }; refresh = { status: 'absent' }; return { status: 'absent' } }
    },
    fetch: async (url, init) => { requests.push({ url, init }); if (httpGate) await httpGate; return httpResponse },
    revoke: async (_authority, token) => { revocations.push(token) }
  })
  return { owner, writes, requests, revocations, access: () => access,
    readGate: (value: Promise<void> | undefined) => { readGate = value },
    setGate: (value: Promise<void> | undefined) => { setGate = value },
    httpGate: (value: Promise<void> | undefined) => { httpGate = value },
    finalReadGate: (value: typeof finalReadGate) => { finalReadGate = value },
    response: (value: Response) => { httpResponse = value },
    failRemove: (value: boolean) => { failedRemove = value },
    persistence: (value: typeof persistence) => { persistence = value },
    refresh: (value: typeof refresh) => { refresh = value },
    invalidate: () => { authority = Object.freeze({ ...authority }) }
  }
}

test('snapshot reads A while queued B does not publish B revision early', async () => {
  const state = fixture()
  const gate = deferred()
  state.readGate(gate.promise)
  const snapshot = state.owner.snapshot()
  const replacement = state.owner.replace('B', 'refresh-B')
  gate.resolve()
  const captured = await snapshot
  assert.equal(captured.ok, true)
  if (!captured.ok) return
  assert.equal(captured.access, 'A')
  assert.equal(captured.revision, 0)
  assert.deepEqual(await replacement, { ok: true, revision: 1 })
})

test('late A logout never clears B or revokes B refresh family', async () => {
  const state = fixture()
  const gate = deferred()
  state.httpGate(gate.promise)
  const captured = await state.owner.capture()
  assert.equal(captured.ok, true)
  if (!captured.ok) return
  const logout = state.owner.logout({ expectedRevision: captured.revision })
  await new Promise(resolve => setImmediate(resolve))
  await state.owner.replace('B', 'refresh-B')
  gate.resolve()
  assert.deepEqual(await logout, { ok: false, code: 'auth_revision_stale' })
  assert.equal(state.access(), 'B')
  assert.deepEqual(state.revocations, [])
  assert.equal((state.requests[0].init.headers as Record<string, string>).authorization, 'Bearer A')
  assert.equal(state.requests[0].init.redirect, 'error')
})

test('clear final readback authority replacement rejects success before queued invalidation', async () => {
  const state = fixture()
  const gate = { entered: deferred(), release: deferred() }
  state.finalReadGate(gate)
  const capture = await state.owner.capture()
  assert.equal(capture.ok, true)
  if (!capture.ok) return
  const logout = state.owner.logout({ expectedRevision: capture.revision })
  await gate.entered.promise
  state.invalidate()
  const invalidating = state.owner.invalidate()
  const capturing = state.owner.capture()
  let invalidationSettled = false
  void invalidating.then(() => { invalidationSettled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(invalidationSettled, false)
  gate.release.resolve()
  assert.deepEqual(await logout, { ok: false, code: 'auth_revision_stale' })
  assert.deepEqual(state.revocations, [])
  assert.deepEqual(await invalidating, { ok: true, revision: 2 })
  assert.deepEqual(await capturing, { ok: true, revision: 2 })
  assert.deepEqual(await state.owner.snapshot(), { ok: false, code: 'auth_unavailable' })
  assert.deepEqual(await state.owner.replace('B', 'refresh-B'), { ok: true, revision: 3 })
  assert.equal(state.access(), 'B')
})

test('clear final readback producer invalidation remains blocked without revoking captured refresh', async () => {
  const state = fixture()
  const gate = { entered: deferred(), release: deferred() }
  state.finalReadGate(gate)
  let current = true
  const capture = await state.owner.capture()
  assert.equal(capture.ok, true)
  if (!capture.ok) return
  const logout = state.owner.logout({ expectedRevision: capture.revision }, () => current)
  await gate.entered.promise
  current = false
  gate.release.resolve()
  assert.deepEqual(await logout, { ok: false, code: 'auth_revision_stale' })
  assert.deepEqual(state.revocations, [])
  assert.deepEqual(await state.owner.capture(), { ok: true, revision: 1 })
  assert.deepEqual(await state.owner.snapshot(), { ok: false, code: 'auth_unavailable' })
  assert.deepEqual(await state.owner.replace('B', 'refresh-B'), { ok: true, revision: 2 })
  assert.equal(state.access(), 'B')
})

test('normal clear confirms its operation revision and revokes only captured paired refresh', async () => {
  const state = fixture()
  const capture = await state.owner.capture()
  assert.equal(capture.ok, true)
  if (!capture.ok) return
  assert.deepEqual(await state.owner.logout({ expectedRevision: capture.revision }), { ok: true, revision: 1 })
  assert.equal(state.access(), '')
  assert.deepEqual(state.revocations, ['refresh-A'])
  const snapshot = await state.owner.snapshot()
  assert.equal(snapshot.ok, true)
  if (snapshot.ok) assert.equal(snapshot.coherence, 'empty')
})

test('cookie await excludes queued writer until its predecessor finishes', async () => {
  const state = fixture()
  const gate = deferred()
  state.setGate(gate.promise)
  const first = state.owner.replace('B', 'refresh-B')
  await new Promise(resolve => setImmediate(resolve))
  const second = state.owner.replace('C', 'refresh-C')
  assert.deepEqual(state.writes, ['refresh:refresh-B', 'cookie:B'])
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(state.access(), 'C')
})

test('blocked pair permits active cleanup capture and new login recovery', async () => {
  const state = fixture()
  state.failRemove(true)
  state.persistence('unavailable')
  assert.deepEqual(await state.owner.replace('B', 'refresh-B'), { ok: false, code: 'auth_mutation_failed' })
  assert.equal(state.access(), 'A')
  assert.deepEqual(await state.owner.snapshot(), { ok: false, code: 'auth_unavailable' })
  const capture = await state.owner.capture()
  assert.equal(capture.ok, true)
  if (!capture.ok) return
  state.failRemove(false)
  assert.equal((await state.owner.logout({ expectedRevision: capture.revision })).ok, true)
  assert.equal(state.access(), '')
  state.persistence('persisted')
  assert.equal((await state.owner.replace('C', 'refresh-C')).ok, true)
})

test('producer cancelled after queueing performs no mutation', async () => {
  const state = fixture()
  const gate = deferred()
  state.readGate(gate.promise)
  const pending = state.owner.snapshot()
  let current = true
  const capture = { revision: 0, authority: state.owner.authority()! }
  const replacement = state.owner.replace('B', 'refresh-B', { ...capture, isCurrent: () => current })
  current = false
  gate.resolve()
  await pending
  assert.deepEqual(await replacement, { ok: false, code: 'auth_revision_stale' })
  assert.deepEqual(state.writes, [])
})

test('conditional refresh success and rejection cannot mutate newer credential', async () => {
  for (const clear of [false, true]) {
    const state = fixture()
    const capture = await state.owner.snapshot()
    assert.equal(capture.ok, true)
    if (!capture.ok) return
    await state.owner.replace('B', 'refresh-B')
    const result = clear ? await state.owner.clear(capture) : await state.owner.replace('old-A', 'old-refresh', capture)
    assert.deepEqual(result, { ok: false, code: 'auth_revision_stale' })
    assert.equal(state.access(), 'B')
  }
})

test('authority replacement rejects captured mutation and HTTP', async () => {
  const state = fixture()
  const capture = await state.owner.capture()
  assert.equal(capture.ok, true)
  if (!capture.ok) return
  state.invalidate()
  assert.deepEqual(await state.owner.logout({ expectedRevision: capture.revision }), { ok: false, code: 'auth_revision_stale' })
  assert.deepEqual(state.requests, [])
})

test('HTTP rejection or malformed endpoint result retains credentials', async () => {
  for (const response of [Response.json({ ok: true }, { status: 500 }), Response.json({ nope: true }), new Response('not JSON')]) {
    const state = fixture()
    state.response(response)
    assert.deepEqual(await state.owner.logout({ expectedRevision: 0 }), { ok: false, code: 'auth_http_failed' })
    assert.equal(state.access(), 'A')
    assert.deepEqual(state.writes, [])
  }
})

test('invalid bound envelopes cannot downgrade to legacy or absence', () => {
  for (const payload of ['scholarseed.auth-refresh.v2:{}', 'scholarseed.auth-refresh.v1:no JSON', 'scholarseed.auth-refresh.v1:{"version":1,"refreshToken":"r","accessDigest":"bad"}', 'scholarseed.auth-refresh.v1:{"version":1,"refreshToken":"r","accessDigest":"' + 'a'.repeat(64) + '","extra":1}']) {
    assert.deepEqual(parseRefreshPayload(payload), { status: 'invalid' })
  }
  assert.deepEqual(parseRefreshPayload('legacy'), { status: 'legacy-unbound', refreshToken: 'legacy' })
  assert.equal(parseRefreshPayload(refreshPayload('A', 'r')).status, 'bound-v1')
  assert.equal(accessDigest('A').length, 64)
})

test('typed persistence uses same encrypted file and distinguishes unavailable from absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'auth-persistence-'))
  const filename = join(directory, 'auth-refresh.test.enc')
  let available = true
  const storage = createRefreshPersistence(() => filename, {
    isEncryptionAvailable: () => available,
    encryptString: payload => Buffer.from(payload),
    decryptString: encrypted => encrypted.toString()
  })
  try {
    assert.deepEqual(storage.read('test'), { status: 'absent' })
    assert.deepEqual(storage.write('test', 'r', 'A'), { status: 'persisted' })
    assert.equal(storage.read('test').status, 'bound-v1')
    const before = readFileSync(filename)
    available = false
    assert.deepEqual(storage.read('test'), { status: 'unavailable' })
    assert.deepEqual(storage.write('test', 'new', 'B'), { status: 'unavailable' })
    assert.deepEqual(readFileSync(filename), before)
    assert.deepEqual(storage.remove('test'), { status: 'absent' })
    assert.deepEqual(storage.remove('test'), { status: 'absent' })
    available = true
    writeFileSync(filename, 'scholarseed.auth-refresh.v9:garbage')
    assert.deepEqual(storage.read('test'), { status: 'invalid' })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
