import assert from 'node:assert/strict'
import test from 'node:test'

import { installOfficeFontPermission, type PermissionSession } from './fonts.ts'

function fixture(): {
  contents: object
  check: Parameters<PermissionSession['setPermissionCheckHandler']>[0]
  request: Parameters<PermissionSession['setPermissionRequestHandler']>[0]
  requestAccess: () => Promise<boolean>
} {
  let check: Parameters<PermissionSession['setPermissionCheckHandler']>[0] | null = null
  let request: Parameters<PermissionSession['setPermissionRequestHandler']>[0] | null = null
  const session: PermissionSession = {
    setPermissionCheckHandler(handler) { check = handler },
    setPermissionRequestHandler(handler) { request = handler }
  }
  const contents = {}
  const permission = installOfficeFontPermission(session, contents, 'http://127.0.0.1:8765/')
  assert.ok(check)
  assert.ok(request)
  return { contents, check, request, requestAccess: permission.requestAccess }
}

test('local font access is granted by default only to the embedded Office editor', async () => {
  const { contents, check, request } = fixture()
  const details = { embeddingOrigin: 'http://127.0.0.1:8765', requestingUrl: 'about:srcdoc', isMainFrame: false }

  assert.equal(check(contents, 'local-fonts', 'http://127.0.0.1:8765', details), true)
  assert.equal(await new Promise((done) => request(contents, 'local-fonts', done, details)), true)
})

test('the renderer can explicitly prepare default font access', async () => {
  const { requestAccess } = fixture()

  assert.equal(await requestAccess(), true)
  assert.equal(await requestAccess(), true)
})

test('clipboard permissions stay scoped to the Office frame and the renderer main frame', async () => {
  const { contents, check, request } = fixture()
  const details = { embeddingOrigin: 'http://127.0.0.1:8765', requestingUrl: 'about:srcdoc', isMainFrame: false }
  const mainFrame = { requestingUrl: 'http://127.0.0.1:8765/', isMainFrame: true }

  for (const permission of ['clipboard-read', 'clipboard-sanitized-write']) {
    assert.equal(check(contents, permission, 'http://127.0.0.1:8765', details), true)
    assert.equal(await new Promise((done) => request(contents, permission, done, details)), true)
    assert.equal(check({}, permission, 'http://127.0.0.1:8765', details), false)
    assert.equal(check(contents, permission, 'https://example.com', details), false)
    assert.equal(await new Promise((done) => request(contents, permission, done, {
      ...details,
      embeddingOrigin: 'https://example.com'
    })), false)
  }
  // Clipboard write is a Chromium main-frame default the installed handler must preserve.
  assert.equal(check(contents, 'clipboard-sanitized-write', 'http://127.0.0.1:8765', mainFrame), true)
  assert.equal(await new Promise((done) => request(contents, 'clipboard-sanitized-write', done, mainFrame)), true)
  assert.equal(check(contents, 'clipboard-read', 'http://127.0.0.1:8765', mainFrame), false)
  assert.equal(check({}, 'clipboard-sanitized-write', 'http://127.0.0.1:8765', mainFrame), false)
  assert.equal(check(contents, 'clipboard-sanitized-write', 'https://example.com', mainFrame), false)
  assert.equal(check(contents, 'clipboard-sanitized-write', 'http://127.0.0.1:8765', { ...mainFrame, isMainFrame: false }), false)
})

test('Office permissions never escape the exact window, origin, iframe, or allowlist', async () => {
  const { contents, check, request } = fixture()
  const details = { embeddingOrigin: 'http://127.0.0.1:8765', requestingUrl: 'about:srcdoc', isMainFrame: false }
  const rejected = async (requester: unknown, permission: string): Promise<boolean> => new Promise((done) => {
    request(requester, permission, done, details)
  })

  assert.equal(await rejected({}, 'local-fonts'), false)
  assert.equal(await rejected(contents, 'geolocation'), false)
  assert.equal(await new Promise((done) => request(contents, 'local-fonts', done, { ...details, requestingUrl: 'https://example.com' })), false)
  assert.equal(check(contents, 'local-fonts', 'https://example.com', details), false)
})
