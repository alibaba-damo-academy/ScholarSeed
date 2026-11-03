import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorizationFailure,
  authorizationMethods,
  authorizationStatus,
  authorizationUrl,
} from './authorization.ts'

test('authorization labels do not claim successful authorization for local or anonymous servers', () => {
  const connector = {
    authorized: true,
    custom: true,
    method: null,
    methods: [] as ('key' | 'oauth')[],
    transport: 'stdio' as const,
    tools_fetched_at: null,
  }
  assert.equal(authorizationStatus(connector), 'none')
  assert.equal(authorizationStatus({ ...connector, transport: 'http' }), 'unknown')
  assert.equal(
    authorizationStatus({ ...connector, transport: 'http', tools_fetched_at: 1 }),
    'none'
  )
  assert.equal(authorizationStatus({ ...connector, methods: ['key'] }), 'saved')
  assert.equal(
    authorizationStatus({ ...connector, methods: ['key'], tools_fetched_at: 1 }),
    'authorized'
  )
  assert.equal(authorizationStatus({ ...connector, authorized: false }), 'unknown')
})

test('connection failures distinguish saved custom keys from verified authorization', () => {
  assert.equal(
    authorizationFailure({ authorized: true, custom: true, method: null, methods: ['key'] }),
    'saved'
  )
  assert.equal(
    authorizationFailure({ authorized: true, custom: true, method: 'oauth', methods: ['oauth'] }),
    'authorized'
  )
  assert.equal(
    authorizationFailure({ authorized: true, custom: false, method: 'key', methods: ['key'] }),
    'authorized'
  )
  assert.equal(
    authorizationFailure({ authorized: false, custom: true, method: null, methods: ['key'] }),
    null
  )
  assert.equal(
    authorizationFailure({ authorized: true, custom: true, method: null, methods: [] }),
    null
  )
})

test('API Key is always before OAuth regardless of provider order', () => {
  assert.deepEqual(authorizationMethods(['oauth', 'key']), ['key', 'oauth'])
  assert.deepEqual(authorizationMethods(['key', 'oauth', 'key']), ['key', 'oauth'])
})

test('verified custom credentials remain authorized across connection failures, not invalid credentials', () => {
  const connector = {
    authorized: true,
    custom: true,
    method: null,
    methods: ['key'] as ('key' | 'oauth')[],
    tools_fetched_at: 1,
  }
  assert.equal(authorizationFailure(connector), 'authorized')
  assert.equal(authorizationFailure({ ...connector, authorized: false }), null)
  assert.equal(authorizationFailure({ ...connector, tools_fetched_at: null }), 'saved')
  assert.equal(authorizationFailure({ ...connector, methods: [] }), null)
})

test('only methods actually supported by the provider are offered', () => {
  assert.deepEqual(authorizationMethods(['oauth']), ['oauth'])
  assert.deepEqual(authorizationMethods(['key']), ['key'])
  assert.deepEqual(authorizationMethods(['unknown']), [])
})

test('OAuth opens the actual HTTPS authorization URL without a demo fallback', () => {
  const url = 'https://accounts.example.com/oauth/authorize?state=opaque&code_challenge=opaque'
  assert.equal(authorizationUrl(url), url)
  for (const value of [
    'about:blank',
    'data:text/html,demo',
    'javascript:void(0)',
    'file:///demo.html',
    'http://example.com/authorize',
    'https://user:password@example.com',
    '',
  ]) {
    assert.throws(() => authorizationUrl(value))
  }
})
