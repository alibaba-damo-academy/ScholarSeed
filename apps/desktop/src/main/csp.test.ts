import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow, OnHeadersReceivedListenerDetails } from 'electron'
import { installContentSecurityPolicy, mainWindowContentSecurityPolicy } from './csp.ts'

type HeadersListener = Parameters<Electron.WebRequest['onHeadersReceived']>[0]
type HeadersReply = Parameters<Parameters<NonNullable<HeadersListener>>[1]>[0]

const WINDOW_ID = 17
const OTHER_WINDOW_ID = 18
const POLICY = "default-src 'self'"
const CSP_HEADER = 'Content-Security-Policy'

function fixture() {
  let listener: HeadersListener = null
  let destroyed = false
  const webContents = {
    get id() {
      assert.equal(destroyed, false, 'Object has been destroyed: webContents.id')
      return WINDOW_ID
    },
    session: {
      webRequest: {
        onHeadersReceived(next: HeadersListener) {
          listener = next
        },
      },
    },
  }
  const win = {
    get webContents() {
      assert.equal(destroyed, false, 'Object has been destroyed: window.webContents')
      return webContents
    },
  } as unknown as BrowserWindow
  installContentSecurityPolicy(win, POLICY)
  return {
    destroy() {
      destroyed = true
    },
    respond(
      webContentsId: number | undefined,
      resourceType: OnHeadersReceivedListenerDetails['resourceType'],
      responseHeaders?: Record<string, string[]>
    ) {
      assert.ok(listener)
      const replies: HeadersReply[] = []
      listener(
        { webContentsId, resourceType, responseHeaders } as OnHeadersReceivedListenerDetails,
        (reply) => replies.push(reply)
      )
      assert.equal(replies.length, 1)
      return replies[0]
    },
  }
}

test('CSP applies only to the target main frame without mutating response headers', () => {
  const request = fixture()
  const original = { 'Content-Type': ['text/html'], [CSP_HEADER]: ['old-policy'] }
  assert.deepEqual(request.respond(WINDOW_ID, 'mainFrame', original), {
    responseHeaders: { ...original, [CSP_HEADER]: [POLICY] },
  })
  assert.deepEqual(original[CSP_HEADER], ['old-policy'])
})

test('CSP preserves responses for other windows, subresources and requests without a window', () => {
  const request = fixture()
  const original = { 'Content-Type': ['text/plain'] }
  for (const [id, type] of [
    [OTHER_WINDOW_ID, 'mainFrame'],
    [WINDOW_ID, 'xhr'],
    [WINDOW_ID, 'subFrame'],
    [undefined, 'mainFrame'],
  ] as const) {
    assert.strictEqual(request.respond(id, type, original).responseHeaders, original)
  }
})

test('late target response after window destruction completes without accessing native objects', () => {
  const request = fixture()
  request.destroy()
  assert.deepEqual(request.respond(WINDOW_ID, 'mainFrame'), {
    responseHeaders: { [CSP_HEADER]: [POLICY] },
  })
})

test('late unrelated responses after window destruction still complete unchanged', () => {
  const request = fixture()
  request.destroy()
  assert.deepEqual(request.respond(OTHER_WINDOW_ID, 'mainFrame'), { responseHeaders: undefined })
  assert.deepEqual(request.respond(WINDOW_ID, 'xhr'), { responseHeaders: undefined })
})

test('CSP retains all desktop directives and scopes account access to its origin', () => {
  assert.deepEqual(
    mainWindowContentSecurityPolicy('https://account.example.test/login').split('; '),
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' http://127.0.0.1:* data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* https://account.example.test",
      "frame-src 'self' scholarseed-plugin:",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
    ]
  )
})

test('CSP without account service retains loopback connectivity', () => {
  const directives = mainWindowContentSecurityPolicy('').split('; ')
  assert.ok(directives.includes("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*"))
  assert.ok(directives.includes("img-src 'self' http://127.0.0.1:* data: blob:"))
})
