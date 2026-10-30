import assert from 'node:assert/strict'
import test from 'node:test'
import { AUTH_CHANNEL } from '../authentication.ts'
import { AuthenticationOwner } from './authentication.ts'
import { registerAuthenticationIpc } from './authenticationipc.ts'

function fixture() {
  const handlers = new Map<string, (event: { sender: unknown; senderFrame?: { url: string } | null }, ...args: unknown[]) => Promise<unknown>>()
  const frame = { url: 'https://product.test/' }
  const session = {}
  const webContents = { session, mainFrame: frame, isDestroyed: () => false }
  let epoch = 0
  let token = 'A'
  const authority = Object.freeze({ cookieUrl: 'https://serve.test/', serveBase: 'https://serve.test', namespace: 'test' })
  const owner = new AuthenticationOwner({
    authority: () => authority,
    readAccess: async () => token,
    setAccess: async (_authority, value) => { token = value },
    removeAccess: async () => { token = '' },
    persistence: { read: () => ({ status: 'absent' }), write: () => ({ status: 'persisted' }), remove: () => ({ status: 'absent' }) },
    fetch: async () => Response.json({ ok: false }), revoke: async () => undefined
  })
  registerAuthenticationIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, owner,
    () => ({ webContents, origin: 'https://product.test', navigationEpoch: epoch }))
  return { owner, webContents, frame, handlers, token: () => token, navigate: () => { epoch += 1 } }
}

test('missing frame, subframe, foreign window and external origin cannot capture or read secrets', async () => {
  const state = fixture()
  for (const event of [{ sender: state.webContents }, { sender: state.webContents, senderFrame: { url: state.frame.url } }, { sender: {}, senderFrame: state.frame }]) {
    assert.deepEqual(await state.handlers.get(AUTH_CHANNEL.capture)!(event), { ok: false, code: 'invalid_sender' })
    assert.equal(await state.handlers.get('veda:auth-token-get')!(event), '')
  }
  state.frame.url = 'https://foreign.test/'
  assert.deepEqual(await state.handlers.get(AUTH_CHANNEL.capture)!({ sender: state.webContents, senderFrame: state.frame }), { ok: false, code: 'invalid_sender' })
})

test('sender navigation while mutation is queued is rechecked at actual commit', async () => {
  const state = fixture()
  const result = state.handlers.get('veda:auth-token-set')!({ sender: state.webContents, senderFrame: state.frame }, 'B', '')
  state.navigate()
  assert.deepEqual(await result, { ok: false, code: 'invalid_sender' })
  assert.equal(state.token(), 'A')
})

test('empty setter and surplus capture or logout parameters cause zero side effects', async () => {
  const state = fixture()
  const event = { sender: state.webContents, senderFrame: state.frame }
  assert.deepEqual(await state.handlers.get('veda:auth-token-set')!(event, ''), { ok: false, code: 'invalid_request' })
  assert.deepEqual(await state.handlers.get(AUTH_CHANNEL.capture)!(event, 'extra'), { ok: false, code: 'invalid_request' })
  assert.deepEqual(await state.handlers.get(AUTH_CHANNEL.logout)!(event, { expectedRevision: 0, extra: true }), { ok: false, code: 'invalid_request' })
  assert.equal(state.token(), 'A')
})
