import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import {
  ActivationExpired,
  ActivationCandidateChanged,
  commitWithActivation,
  activationCandidate,
  activationCommitGuard,
  parseActivationKeys,
  verifyActivationGrant,
} from './update-authorization.ts'

const pair = generateKeyPairSync('ed25519')
const pem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const keys = parseActivationKeys({ test: pem })
const candidate = {
  id: 'one',
  version: '0.2.0',
  build_number: '202609280001',
  channel: 'preview',
  arch_type: 'windows-amd64',
  product_id: 'scholarseed',
  bundle_id: 'com.scholarseed.desktop',
  team_id: undefined,
  file_size: 100,
  sha512: 'a'.repeat(128),
}
const now = 1800000000000
const nonce = 'a'.repeat(64)
const payload = {
  domain: 'scholarseed.update.activation',
  schema: 1,
  artifact_kind: 'installer',
  nonce,
  candidate: activationCandidate(candidate),
  revision: '2',
  issued_at: now / 1000,
  expires_at: now / 1000 + 60,
}
function envelope(data = payload) {
  const bytes = Buffer.from(JSON.stringify(data))
  return {
    kid: 'test',
    payload: bytes.toString('base64url'),
    signature: sign(null, bytes, pair.privateKey).toString('base64url'),
  }
}

test('accepts exact signed artifact from packaged trust root', () => {
  assert.deepEqual(verifyActivationGrant(envelope(), keys, candidate, nonce, now), {
    revision: '2',
    expiresAt: now + 60000,
  })
})
test('rejects unknown root, tampered payload, signature and replay nonce', () => {
  assert.throws(() =>
    verifyActivationGrant({ ...envelope(), kid: 'other' }, keys, candidate, nonce, now)
  )
  assert.throws(() =>
    verifyActivationGrant(
      { ...envelope(), payload: Buffer.from('{}').toString('base64url') },
      keys,
      candidate,
      nonce,
      now
    )
  )
  assert.throws(() =>
    verifyActivationGrant({ ...envelope(), signature: 'a'.repeat(86) }, keys, candidate, nonce, now)
  )
  assert.throws(() => verifyActivationGrant(envelope(), keys, candidate, 'b'.repeat(64), now))
})
test('rejects changed identity and digest even if signed by trusted key', () => {
  for (const [field, value] of Object.entries(activationCandidate(candidate))) {
    const changed = {
      ...payload,
      candidate: {
        ...payload.candidate,
        [field]: typeof value === 'number' ? value + 1 : 'changed',
      },
    }
    assert.throws(
      () => verifyActivationGrant(envelope(changed), keys, candidate, nonce, now),
      field
    )
  }
})
test('rejects expiry, future issuance, oversized lifetime and wrong domain', () => {
  for (const changed of [
    { expires_at: now / 1000 },
    { issued_at: now / 1000 + 6 },
    { expires_at: now / 1000 + 121 },
    { domain: 'other' },
    { schema: 2 },
    { revision: '0' },
    { artifact_kind: 'payload' },
  ])
    assert.throws(() =>
      verifyActivationGrant(envelope({ ...payload, ...changed }), keys, candidate, nonce, now)
    )
})
test('policy rejects private keys and non-Ed25519 keys and bounds trust roots', () => {
  assert.deepEqual(Object.keys(parseActivationKeys(undefined)), [])
  assert.throws(() =>
    parseActivationKeys({
      test: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    })
  )
  assert.throws(() =>
    parseActivationKeys({
      test: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .publicKey.export({ format: 'pem', type: 'spki' })
        .toString(),
    })
  )
  assert.throws(() =>
    parseActivationKeys(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), pem])))
  )
})

test('public-key policy rejects concatenated private material', () => {
  const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  assert.throws(() => parseActivationKeys({ test: pem + privatePem }))
  assert.throws(() => parseActivationKeys({ test: pem + 'trailing data' }))
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' })
  const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' })
  for (const body of [
    Buffer.concat([publicDer, privateDer]).toString('base64'),
    publicDer.toString('base64') + privateDer.toString('base64'),
  ]) {
    assert.throws(() =>
      parseActivationKeys({
        test: `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`,
      })
    )
  }
  assert.equal(
    parseActivationKeys({ test: pem.replace(/\n/g, '\r\n') }).test.replace(/\r\n/g, '\n'),
    pem
  )
})

test('handoff guard rejects suspend past expiry and backwards wall-clock changes', () => {
  let wall = now
  let monotonic = 100
  const guard = activationCommitGuard(
    now + 60000,
    () => wall,
    () => monotonic
  )
  guard()
  wall += 60000
  assert.throws(guard, /expired/)
  wall = now - 1000
  monotonic += 60000
  assert.throws(guard, /expired/)
})

test('HTTP authorization binds a fresh nonce, rejects changed releases and oversized responses', async () => {
  const { createServer } = await import('node:http')
  const { requestActivationGrant, ActivationCandidateChanged } =
    await import('./update-authorization.ts')
  let mode = 'signed'
  let previewContext: import('./preview.ts').PreviewContext | undefined
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(req.method, 'POST')
    assert.match(body.nonce, /^[a-f0-9]{64}$/)
    assert.deepEqual(body.candidate, activationCandidate(candidate))
    assert.deepEqual(body.preview_context, previewContext)
    if (mode === 'changed') {
      res.writeHead(409).end()
      return
    }
    if (mode === 'oversized') {
      res.end('a'.repeat(12289))
      return
    }
    const issued = Math.floor(Date.now() / 1000)
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify(
        envelope({ ...payload, nonce: body.nonce, issued_at: issued, expires_at: issued + 60 })
      )
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const request = () =>
    requestActivationGrant(
      `http://127.0.0.1:${port}`,
      keys,
      candidate,
      new AbortController().signal,
      1000,
      previewContext
    )
  try {
    const grant = await request()
    grant.assertValid()
    previewContext = {
      version: '0.2.0',
      build_number: '202610201000',
      preview_scope: 'current-version',
      target_line: '0.3',
      target_id: candidate.id,
    }
    ;(await request()).assertValid()
    mode = 'changed'
    await assert.rejects(request, ActivationCandidateChanged)
    mode = 'oversized'
    await assert.rejects(request, /size limit/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('only a signed, matching expired grant qualifies for renewal', () => {
  const expired = { ...payload, issued_at: now / 1000 - 61, expires_at: now / 1000 - 1 }
  assert.throws(
    () => verifyActivationGrant(envelope(expired), keys, candidate, nonce, now),
    ActivationExpired
  )
  assert.throws(
    () =>
      verifyActivationGrant(envelope({ ...expired, nonce: 'wrong' }), keys, candidate, nonce, now),
    (error) => !(error instanceof ActivationExpired)
  )
})

test('handoff renews expiry once, but never retries refusal or the committed operation', async () => {
  for (const mode of [
    'renew',
    'exhausted',
    'withdrawn',
    'signature',
    'cancelled',
    'post-commit',
  ] as const) {
    let requests = 0
    let commits = 0
    const work = commitWithActivation(
      async () => {
        requests++
        if (mode === 'withdrawn') throw new ActivationCandidateChanged('withdrawn')
        if (mode === 'signature') throw new Error('invalid signature')
        if (mode === 'cancelled') throw new Error('cancelled')
        return () => {
          if (mode === 'exhausted' || (mode === 'renew' && requests === 1))
            throw new ActivationExpired()
        }
      },
      (guard) => {
        guard()
        commits++
        if (mode === 'post-commit') throw new Error('native failure')
      }
    )
    if (mode === 'renew') await work
    else await assert.rejects(work)
    assert.equal(requests, mode === 'renew' || mode === 'exhausted' ? 2 : 1)
    assert.equal(commits, mode === 'renew' || mode === 'post-commit' ? 1 : 0)
  }
})
