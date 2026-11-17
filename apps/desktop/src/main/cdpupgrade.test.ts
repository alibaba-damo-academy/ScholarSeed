import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import test from 'node:test'
import { authorizedChromiumUpgrade } from './chromiumrelay.ts'

test('upgrade requires loopback peer, exact Host, absent Origin and exact token path', () => {
  const request = {
    url: '/devtools/browser/secret',
    headers: { host: '127.0.0.1:1234' },
    socket: { remoteAddress: '127.0.0.1', localPort: 1234 },
  }
  const authorized = () =>
    authorizedChromiumUpgrade(request as unknown as IncomingMessage, 'secret')
  assert.equal(authorized(), true)
  request.socket.remoteAddress = '192.168.1.12'
  assert.equal(authorized(), false)
  request.socket.remoteAddress = '127.0.0.1'
  request.headers.host = 'localhost:1234'
  assert.equal(authorized(), false)
  request.headers.host = '127.0.0.1:1234'
  const headers = request.headers as Record<string, string>
  headers.origin = 'https://example.com'
  assert.equal(authorized(), false)
  delete headers.origin
  request.url = '/devtools/browser/other'
  assert.equal(authorized(), false)
})
