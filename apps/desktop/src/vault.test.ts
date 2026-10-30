import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { parseVaultOpen, parseVaultSubmit, parseVaultReset, validVaultPassword } from './vault.ts'

test('vault public and protected protocol implementation exists', () => {
  assert.equal(existsSync(new URL('./vault.ts', import.meta.url)), true)
})

test('ordinary intent rejects secret and extra fields; protected schema binds exact purposes', () => {
  assert.equal(parseVaultOpen({ intent: 'unlock', password: 'secret' }), null)
  assert.equal(parseVaultOpen({ intent: ['unlock'] }), null)
  assert.equal(parseVaultOpen({ intent: 'create' }), 'create')
  const request = { sessionId: 'session', generation: 1, requestId: 'request', kind: 'create', password: 'abcdefghijkl', confirmation: 'abcdefghijkl' }
  assert.deepEqual(parseVaultSubmit(request), request)
  assert.equal(parseVaultSubmit({ ...request, path: '/private' }), null)
  assert.equal(parseVaultSubmit({ ...request, confirmation: 'ABCDEFGHIJKL' }), null)
  assert.equal(parseVaultSubmit({ ...request, kind: 'reset' }), null)
  assert.equal(parseVaultReset({ sessionId: 'session', generation: 1, requestId: 'reset', confirmation: true })?.confirmation, true)
  assert.equal(parseVaultReset({ sessionId: 'session', generation: 1, requestId: 'reset', confirmation: 'true' }), null)
})

test('password codepoints and bytes are exact without normalization, old unlock minimum or surrogate replacement', () => {
  assert.equal(validVaultPassword('😀'.repeat(11), true), false)
  assert.equal(validVaultPassword('😀'.repeat(12), true), true)
  assert.equal(validVaultPassword(' '.repeat(12), true), true)
  assert.equal(validVaultPassword('short', false), true)
  assert.equal(validVaultPassword('a'.repeat(1024), true), true)
  assert.equal(validVaultPassword('a'.repeat(1025), true), false)
  assert.equal(validVaultPassword('\uD800'.repeat(12), true), false)
  assert.equal(parseVaultSubmit({ sessionId: 'session', generation: 1, requestId: 'request', kind: 'create', password: 'é'.repeat(12), confirmation: 'é'.repeat(12) }), null)
})
