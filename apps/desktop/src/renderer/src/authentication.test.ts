import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebAuthentication } from './authentication.ts'

function webFixture() {
  let token = 'A'
  let available = true
  let writable = true
  let gate: Promise<void> | undefined
  let queue = Promise.resolve()
  const requests: RequestInit[] = []
  const ports = {
    available: () => available,
    authority: () => 'https://web.test/',
    read: () => token,
    write: (value: string) => { if (writable) token = value },
    lock: async <Result>(action: () => Promise<Result>): Promise<Result> => {
      const operation = queue.then(action)
      queue = operation.then(() => undefined, () => undefined)
      return operation
    },
    fetch: async (_url: string, init: RequestInit) => { requests.push(init); if (gate) await gate; return Response.json({ ok: false }) }
  }
  return { first: createWebAuthentication(ports), second: createWebAuthentication(ports), requests,
    token: () => token, available: (value: boolean) => { available = value }, writable: (value: boolean) => { writable = value }, gate: (value: Promise<void>) => { gate = value } }
}

test('new capture observes other document cookie without rebinding old revision', async () => {
  const state = webFixture()
  const first = await state.first.capture()
  assert.equal(first.ok, true)
  if (!first.ok) return
  await state.second.set('B')
  const second = await state.first.capture()
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.notEqual(first.revision, second.revision)
  assert.deepEqual(await state.first.logout({ expectedRevision: first.revision }), { ok: false, code: 'auth_revision_stale' })
  assert.equal(state.token(), 'B')
  assert.deepEqual(state.requests, [])
})

test('cross document replacement during captured Bearer logout retains new cookie', async () => {
  const state = webFixture()
  let release!: () => void
  state.gate(new Promise(resolve => { release = resolve }))
  const captured = await state.first.capture()
  assert.equal(captured.ok, true)
  if (!captured.ok) return
  const logout = state.first.logout({ expectedRevision: captured.revision })
  await new Promise(resolve => setImmediate(resolve))
  await state.second.set('B')
  release()
  assert.deepEqual(await logout, { ok: false, code: 'auth_revision_stale' })
  assert.equal(state.token(), 'B')
  assert.deepEqual(state.requests[0].headers, { authorization: 'Bearer A' })
  assert.equal(state.requests[0].credentials, 'omit')
})

test('unavailable lock and denied cookie writes retain account and fail honestly', async () => {
  const state = webFixture()
  state.available(false)
  assert.deepEqual(await state.first.capture(), { ok: false, code: 'auth_unavailable' })
  assert.equal(state.token(), 'A')
  state.available(true)
  state.writable(false)
  assert.deepEqual(await state.first.set('B'), { ok: false, code: 'auth_mutation_failed' })
  assert.deepEqual(await state.first.set(''), { ok: false, code: 'invalid_request' })
  const capture = await state.first.capture()
  assert.equal(capture.ok, true)
  if (!capture.ok) return
  assert.deepEqual(await state.first.logout({ expectedRevision: capture.revision }), { ok: false, code: 'auth_mutation_failed' })
  assert.equal(state.token(), 'A')
})
