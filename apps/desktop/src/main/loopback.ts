import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { newHandoffState } from './handoff-url.ts'

const LOOPBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/auth/callback'
const AUTOMATIC_PORT = 0
const CALLBACK_REQUEST_TIMEOUT_MS = 5_000
const CALLBACK_HEADER_BYTES = 8_192
const HANDOFF_VALUE = /^[A-Za-z0-9_-]{43}$/
const CALLBACK_ACCEPTED = 204
const CALLBACK_REJECTED = 404

export interface LoginReceiver {
  port: number
  close(): void
}

export function newLoginProof(): { verifier: string; challenge: string } {
  const verifier = newHandoffState()
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function listenForLoginCallback(
  receive: (state: string, code: string) => boolean
): Promise<LoginReceiver> {
  return new Promise((resolve, reject) => {
    let host = ''
    const server = createServer(
      {
        requestTimeout: CALLBACK_REQUEST_TIMEOUT_MS,
        headersTimeout: CALLBACK_REQUEST_TIMEOUT_MS,
        connectionsCheckingInterval: CALLBACK_REQUEST_TIMEOUT_MS,
        maxHeaderSize: CALLBACK_HEADER_BYTES,
      },
      (request, response) => {
        const target = request.url ?? ''
        let accepted = false
        if (
          request.method === 'GET' &&
          request.headers.host === host &&
          target.startsWith(CALLBACK_PATH + '?')
        ) {
          const query = new URLSearchParams(target.slice(CALLBACK_PATH.length + 1))
          const states = query.getAll('state')
          const codes = query.getAll('code')
          if (
            states.length === 1 &&
            codes.length === 1 &&
            HANDOFF_VALUE.test(states[0]) &&
            HANDOFF_VALUE.test(codes[0])
          )
            accepted = receive(states[0], codes[0])
        }
        response
          .writeHead(accepted ? CALLBACK_ACCEPTED : CALLBACK_REJECTED, {
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            Connection: 'close',
          })
          .end()
      }
    )
    const close = (): void => {
      server.close()
      server.closeAllConnections()
    }
    server.once('error', reject)
    server.listen(AUTOMATIC_PORT, LOOPBACK_HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        close()
        reject(new Error('Loopback listener has no TCP address'))
        return
      }
      host = `${LOOPBACK_HOST}:${address.port}`
      server.unref()
      resolve({ port: address.port, close })
    })
  })
}
