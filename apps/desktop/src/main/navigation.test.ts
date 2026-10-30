import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_ERROR, parseBrowserCommand } from '../browser.ts'
import * as navigation from './navigation.ts'
import { browserResourceAllowed, normalizeBrowserInput } from './navigation.ts'

test('does not expose a mutable scheme allowlist to callers', () => {
  assert.equal(Object.hasOwn(navigation, 'BROWSER_SCHEMES'), false)
  assert.throws(() => normalizeBrowserInput('file:///tmp/a'), { message: BROWSER_ERROR.invalidUrl })
})

for (const [input, expected] of [
  ['example.com', 'https://example.com/'],
  ['example.com:8443/path', 'https://example.com:8443/path'],
  [' example.com ', 'https://example.com/'],
  ['HTTP://Example.com/path?q=1', 'http://example.com/path?q=1'],
  ['https://example.com/a', 'https://example.com/a']
]) {
  test(`normalizes ${input}`, () => {
    assert.equal(normalizeBrowserInput(input).href, expected)
  })
}

for (const input of [
  '', '   ', 'file:///tmp/a', 'javascript:alert(1)', 'data:text/html,hello',
  'chrome://settings', 'file:123', 'https:999', 'https://user:pass@example.com', 'https://user@example.com',
  'https://example.com:bad', 'https://bad host', 'https://-bad.example',
  'http:/example.com', 'https://example.com\n.evil.test'
]) {
  test(`rejects unsafe browser input ${JSON.stringify(input)}`, () => {
    assert.throws(() => normalizeBrowserInput(input), { message: BROWSER_ERROR.invalidUrl })
  })
}

const remoteOrigin = 'https://example.com'
const apiOrigin = 'http://127.0.0.1:8000'

for (const destination of [
  'http://127.0.0.1:8000/api/healthz', 'http://localhost:8000/',
  'http://sub.localhost/', 'http://10.2.3.4/', 'http://172.16.0.1/',
  'http://192.168.1.1/', 'http://169.254.1.1/', 'http://[::1]/',
  'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[::ffff:7f00:1]/', 'file:///tmp/a',
  'javascript:alert(1)'
]) {
  test(`rejects remote-page resource ${destination}`, () => {
    assert.equal(browserResourceAllowed({
      url: new URL(destination), topOrigin: remoteOrigin,
      approvedLocalOrigin: null, apiOrigin
    }), false)
  })
}

test('rejects a remote-page redirect to the current API origin', () => {
  assert.equal(browserResourceAllowed({
    url: new URL('http://127.0.0.1:8000/redirected'), topOrigin: remoteOrigin,
    approvedLocalOrigin: apiOrigin, apiOrigin
  }), false)
})

test('allows an explicitly approved tab only at its current API origin', () => {
  const request = { topOrigin: apiOrigin, approvedLocalOrigin: apiOrigin, apiOrigin }
  assert.equal(browserResourceAllowed({ ...request, url: new URL('http://127.0.0.1:8000/app') }), true)
  assert.equal(browserResourceAllowed({ ...request, url: new URL('http://127.0.0.1:8001/app') }), false)
  assert.equal(browserResourceAllowed({ ...request, apiOrigin: 'http://127.0.0.1:9000', url: new URL('http://127.0.0.1:8000/app') }), false)
  assert.equal(browserResourceAllowed({ ...request, topOrigin: remoteOrigin, url: new URL('http://127.0.0.1:8000/app') }), false)
  const privateApiOrigin = 'http://169.254.169.254:8000'
  assert.equal(browserResourceAllowed({ url: new URL(`${privateApiOrigin}/app`), topOrigin: privateApiOrigin,
    approvedLocalOrigin: privateApiOrigin, apiOrigin: privateApiOrigin }), false)
})

test('allows ordinary public HTTPS resources', () => {
  assert.equal(browserResourceAllowed({
    url: new URL('https://cdn.example.com/app.js'), topOrigin: remoteOrigin,
    approvedLocalOrigin: null, apiOrigin
  }), true)
})

test('allows public IPv4-mapped IPv6 but rejects private mappings', () => {
  const context = { topOrigin: remoteOrigin, approvedLocalOrigin: null, apiOrigin }
  assert.equal(browserResourceAllowed({
    ...context, url: new URL('http://[::ffff:8.8.8.8]/')
  }), true)
  assert.equal(browserResourceAllowed({
    ...context, url: new URL('http://[::ffff:127.0.0.1]/')
  }), false)
})

for (const command of [
  { kind: 'open' }, { kind: 'open', input: 'example.com' },
  { kind: 'navigate', tabId: 'tab-1', input: 'example.com' },
  { kind: 'select', tabId: 'tab-1' },
  { kind: 'bounds', tabId: 'tab-1', visible: true, x: 0, y: 2, width: 300, height: 200 },
  { kind: 'devtools', tabId: 'tab-1', open: false },
  { kind: 'automation', enabled: true }, { kind: 'copy-endpoint' }
]) {
  test(`accepts browser command ${command.kind}`, () => {
    assert.deepEqual(parseBrowserCommand(command), command)
  })
}

for (const command of [
  null, [], { kind: 'unknown' }, { kind: 'open', input: 3 },
  { kind: 'navigate', tabId: '', input: 'example.com' },
  { kind: 'select', tabId: 'tab-1', webContentsId: 2 },
  { kind: 'bounds', tabId: 'tab-1', visible: true, x: 0, y: 0, width: -1, height: 10 },
  { kind: 'bounds', tabId: 'tab-1', visible: true, x: Number.NaN, y: 0, width: 1, height: 1 },
  { kind: 'automation', enabled: 'true' }, { kind: 'copy-endpoint', token: 'secret' }
]) {
  test(`rejects malformed browser command ${JSON.stringify(command)}`, () => {
    assert.throws(() => parseBrowserCommand(command), { message: BROWSER_ERROR.invalidCommand })
  })
}
