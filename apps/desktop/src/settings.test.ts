import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSettingsLease, parseSettingsMessage, settingsLeaseMatches, visibleSettingsPages } from './settings.ts'
import { createAvailabilityPolicy } from './renderer/src/app/policy.ts'

const identifier = '12345678-1234-4234-8234-123456789abc'
const lease = { ownerId: identifier, windowGeneration: 1, productDocumentGeneration: 1, sessionId: identifier,
  pageEpoch: 1, inputGeneration: 1, requestId: identifier, authGeneration: 0, backendGeneration: 0,
  projectRevision: 0, catalogRevision: 0 }
const startup = { kind: 'bootstrap', ownerId: identifier, windowGeneration: 1, productDocumentGeneration: 1,
  language: 'zh', theme: 'dark' }

test('lease parses complete Main UUID metadata and rejects every malformed field', () => {
  assert.deepEqual(parseSettingsLease(lease), lease)
  assert.equal(parseSettingsLease({ ...lease, secret: 'forbidden' }), null)
  for (const field of ['ownerId', 'sessionId', 'requestId']) {
    for (const value of ['', identifier + 'x', '任意权限', 1, null,
      '12345678-1234-5234-8234-123456789abc', '12345678-1234-4234-7234-123456789abc', identifier.toUpperCase()]) {
      assert.equal(parseSettingsLease({ ...lease, [field]: value }), null)
    }
    const missing = { ...lease } as Record<string, unknown>
    delete missing[field]
    assert.equal(parseSettingsLease(missing), null)
  }
  for (const field of ['windowGeneration', 'productDocumentGeneration', 'pageEpoch', 'inputGeneration', 'authGeneration', 'backendGeneration', 'projectRevision', 'catalogRevision']) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) assert.equal(parseSettingsLease({ ...lease, [field]: value }), null)
    const missing = { ...lease } as Record<string, unknown>
    delete missing[field]
    assert.equal(parseSettingsLease(missing), null)
  }
  for (const field of ['windowGeneration', 'productDocumentGeneration', 'pageEpoch', 'inputGeneration']) assert.equal(parseSettingsLease({ ...lease, [field]: 0 }), null)
  for (const value of [null, [], true]) assert.equal(parseSettingsLease(value), null)
})

test('lease comparison rejects every old authority dimension', () => {
  assert.equal(settingsLeaseMatches(lease, { ...lease }), true)
  for (const field of Object.keys(lease)) {
    const changed = typeof lease[field as keyof typeof lease] === 'number' ? 2 : 'abcdefab-1234-4234-8234-123456789abc'
    assert.equal(settingsLeaseMatches({ ...lease, [field]: changed }, lease), false)
  }
  assert.equal(settingsLeaseMatches(null, null), false)
})

test('sidebar honors policy without restoring hidden pages or secret permissions', () => {
  const ordinary = ['notifications', 'prompts', 'models', 'skills', 'developer', 'files', 'storage', 'archives', 'about']
  assert.deepEqual(visibleSettingsPages(createAvailabilityPolicy(false)), ordinary)
  assert.deepEqual(visibleSettingsPages(createAvailabilityPolicy(true)), [...ordinary.slice(0, 5), 'browser', ...ordinary.slice(5)])
})

test('bootstrap uses owned language and resolved theme and rejects arbitrary payload', () => {
  assert.deepEqual(parseSettingsMessage(startup), startup)
  for (const value of [{ ...startup, language: 'zh-CN' }, { ...startup, theme: 'system' }, { ...startup, secret: 'no' },
    { ...startup, language: 'fr' }, { ...startup, kind: 'invoke', operation: 'fetch' }]) assert.equal(parseSettingsMessage(value), null)
})

test('qualification and page/input acknowledgements have exact discriminated fields', () => {
  const messages = [
    startup,
    { kind: 'qualification', ownerId: identifier, windowGeneration: 1, productDocumentGeneration: 1, status: 'ready' },
    { kind: 'reserve', lease, page: 'models', section: null },
    { kind: 'reserve', lease, page: 'browser', section: 'history' },
    { kind: 'paint', lease, presentationRevision: 1 },
    { kind: 'input-lease', lease, mode: 'settings' },
    { kind: 'close', lease, reason: 'escape', sequenceId: identifier },
    { kind: 'close', lease, reason: 'explicit-close' },
    { kind: 'sequence-terminal', lease, sequenceId: identifier, terminal: 'pointer-click' },
    { kind: 'suspend', lease, reason: 'window-blur' },
    { kind: 'revoke', lease, reason: 'product-crash' }
  ]
  for (const message of messages) {
    assert.deepEqual(parseSettingsMessage(message), message)
    assert.equal(parseSettingsMessage({ ...message, payload: { api_key: 'forbidden' } }), null)
    for (const field of Object.keys(message)) {
      const missing = { ...message } as Record<string, unknown>
      delete missing[field]
      assert.equal(parseSettingsMessage(missing), null)
    }
  }
})

test('protocol rejects invalid discriminants and structurally invalid acknowledgements', () => {
  for (const value of [null, [], { kind: 'action', lease, operation: 'genericInvoke' }, { kind: 'secret-once', lease, text: 'no' },
    { kind: 'paint', lease, presentationRevision: 0 }, { kind: 'input-lease', lease, mode: 'arbitrary' },
    { kind: 'close', lease, reason: 'outside', sequenceId: '' }, { kind: 'sequence-terminal', lease, sequenceId: identifier, terminal: 'timeout' },
    { kind: 'suspend', lease, reason: 'arbitrary-modal' }, { kind: 'revoke', lease, reason: 'window-blur' },
    { kind: 'qualification', ownerId: identifier, windowGeneration: 1, productDocumentGeneration: 1, status: 'secret-ready' }]) {
    assert.equal(parseSettingsMessage(value), null)
  }
})

test('reserved page handshake uses visible canonical pages and exact browser sections', () => {
  for (const value of [{ kind: 'reserve', lease, page: 'models', section: null },
    { kind: 'reserve', lease, page: 'browser', section: 'history' }]) assert.deepEqual(parseSettingsMessage(value), value)
  for (const value of [{ kind: 'reserve', lease, page: 'account', section: null },
    { kind: 'reserve', lease, page: 'model-settings', section: null },
    { kind: 'reserve', lease, page: 'browser', section: null },
    { kind: 'reserve', lease, page: 'models', section: 'history' },
    { kind: 'reserve', lease, page: 'browser', section: 'secret' }]) assert.equal(parseSettingsMessage(value), null)
})

test('programmatic close has no invented input sequence authority', () => {
  const close = { kind: 'close', lease, reason: 'explicit-close' }
  assert.deepEqual(parseSettingsMessage(close), close)
  assert.equal(parseSettingsMessage({ ...close, sequenceId: identifier }), null)
})

test('each user close reason requires a canonical sequence ticket', () => {
  for (const reason of ['outside', 'escape', 'close-button']) {
    const close = { kind: 'close', lease, reason, sequenceId: identifier }
    assert.deepEqual(parseSettingsMessage(close), close)
    assert.equal(parseSettingsMessage({ kind: 'close', lease, reason }), null)
    for (const sequenceId of ['12345678-1234-5234-8234-123456789abc',
      '12345678-1234-4234-7234-123456789abc', identifier.toUpperCase()]) {
      assert.equal(parseSettingsMessage({ ...close, sequenceId }), null)
    }
  }
})

test('records reject symbol keys, accessors and custom prototypes without invoking accessors', () => {
  let accessorReads = 0
  const accessorLease = { ...lease }
  Object.defineProperty(accessorLease, 'ownerId', { enumerable: true, get: () => { accessorReads += 1; return identifier } })
  const accessorMessage = { ...startup }
  Object.defineProperty(accessorMessage, 'kind', { enumerable: true, get: () => { accessorReads += 1; return 'bootstrap' } })
  for (const candidate of [{ ...lease, [Symbol('unknown')]: true }, accessorLease,
    Object.assign(Object.create({ injected: true }), lease)]) {
    assert.equal(parseSettingsLease(candidate), null)
    assert.equal(parseSettingsMessage({ kind: 'paint', lease: candidate, presentationRevision: 1 }), null)
  }
  for (const candidate of [{ ...startup, [Symbol('unknown')]: true }, accessorMessage,
    Object.assign(Object.create({ injected: true }), startup)]) assert.equal(parseSettingsMessage(candidate), null)
  assert.equal(accessorReads, 0)
})

test('parsed outer records and nested lease are detached from input mutations', () => {
  const inputLease = { ...lease }
  const parsedLease = parseSettingsLease(inputLease)
  assert.deepEqual(parsedLease, inputLease)
  assert.notEqual(parsedLease, inputLease)
  inputLease.ownerId = 'abcdefab-1234-4234-8234-123456789abc'
  assert.equal(parsedLease?.ownerId, identifier)

  const input = { kind: 'paint', lease: { ...lease }, presentationRevision: 1 }
  const parsed = parseSettingsMessage(input)
  assert.deepEqual(parsed, input)
  assert.notEqual(parsed, input)
  assert.ok(parsed?.kind === 'paint')
  assert.notEqual(parsed.lease, input.lease)
  input.lease.pageEpoch = 2
  input.presentationRevision = 2
  assert.equal(parsed.lease.pageEpoch, 1)
  assert.equal(parsed.presentationRevision, 1)
})
