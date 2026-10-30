import { createPublicKey, verify, randomBytes } from 'node:crypto'
import type { LatestVersionMeta } from '../updates.ts'
import type { PreviewContext } from './preview.ts'

export type ActivationKeys = Readonly<Record<string, string>>
export type HandoffAuthorization = () => Promise<() => void>
const MAX_HANDOFF_AUTHORIZATION_ATTEMPTS = 2

export class ActivationExpired extends Error {
  constructor() {
    super('activation authorization expired before handoff')
  }
}

/** Only renew before commit. The synchronous callback must check the guard before side effects. */
export async function commitWithActivation(
  authorize: HandoffAuthorization,
  commit: (guard: () => void) => void
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const guard = await authorize()
      commit(guard)
      return
    } catch (error) {
      if (!(error instanceof ActivationExpired) || attempt >= MAX_HANDOFF_AUTHORIZATION_ATTEMPTS)
        throw error
    }
  }
}
const CANDIDATE_FIELDS = [
  'id',
  'version',
  'build_number',
  'channel',
  'arch_type',
  'product_id',
  'bundle_id',
  'team_id',
  'file_size',
  'sha512',
] as const

export function parseActivationKeys(value: unknown): ActivationKeys {
  if (value === undefined) return Object.freeze({})
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('update_activation_keys must be a public-key map')
  }
  const entries = Object.entries(value)
  if (entries.length > 8) throw new Error('too many activation trust roots')
  const result: Record<string, string> = Object.create(null)
  for (const [kid, pem] of entries) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(kid) ||
      typeof pem !== 'string' ||
      pem.length > 256 ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(
        pem
      )
    ) {
      throw new Error('activation trust roots must be Ed25519 public keys')
    }
    const key = createPublicKey(pem)
    const body = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '')
    const der = Buffer.from(body, 'base64')
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      der.toString('base64') !== body ||
      !der.equals(key.export({ format: 'der', type: 'spki' }))
    ) {
      throw new Error('activation trust root contains noncanonical or trailing key material')
    }
    result[kid] = key.export({ format: 'pem', type: 'spki' }).toString()
  }
  return Object.freeze(result)
}

export function activationCandidate(meta: LatestVersionMeta): Record<string, unknown> {
  return Object.fromEntries(CANDIDATE_FIELDS.map((field) => [field, meta[field] ?? null]))
}

function decode(value: unknown, maximum: number): Buffer {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new Error('invalid activation envelope')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('noncanonical activation envelope')
  return bytes
}

/** Verify exact signed bytes against packaged trust roots and this request only. */
export function verifyActivationGrant(
  envelope: unknown,
  keys: ActivationKeys,
  candidate: LatestVersionMeta,
  nonce: string,
  now = Date.now()
): { revision: string; expiresAt: number } {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('invalid activation envelope')
  }
  const { kid, payload, signature } = envelope as Record<string, unknown>
  if (typeof kid !== 'string' || !Object.hasOwn(keys, kid)) {
    throw new Error('activation signing key is not trusted')
  }
  const bytes = decode(payload, 8192)
  const signed = decode(signature, 128)
  if (signed.length !== 64 || !verify(null, bytes, createPublicKey(keys[kid]), signed)) {
    throw new Error('activation signature is invalid')
  }
  const data = JSON.parse(bytes.toString('utf8'))
  if (
    !data ||
    data.domain !== 'scholarseed.update.activation' ||
    data.schema !== 1 ||
    data.artifact_kind !== 'installer' ||
    data.nonce !== nonce ||
    typeof data.revision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(data.revision) ||
    !Number.isSafeInteger(data.issued_at) ||
    !Number.isSafeInteger(data.expires_at) ||
    data.expires_at <= data.issued_at ||
    data.expires_at - data.issued_at > 120 ||
    data.issued_at * 1000 > now + 5000 ||
    !data.candidate ||
    typeof data.candidate !== 'object' ||
    CANDIDATE_FIELDS.some((field) => data.candidate[field] !== (candidate[field] ?? null))
  ) {
    throw new Error('activation grant does not match the prepared release or is expired')
  }
  if (data.expires_at * 1000 <= now) throw new ActivationExpired()
  return { revision: data.revision, expiresAt: data.expires_at * 1000 }
}

/** Keep the grant's original time budget even if the wall clock moves backwards. */
export function activationCommitGuard(
  expiresAt: number,
  clock = Date.now,
  monotonic = () => performance.now()
): () => void {
  const remaining = expiresAt - clock()
  const deadline = monotonic() + remaining
  return () => {
    if (remaining <= 0 || clock() >= expiresAt || monotonic() >= deadline) {
      throw new ActivationExpired()
    }
  }
}

export class ActivationCandidateChanged extends Error {}

export async function requestActivationGrant(
  url: string,
  keys: ActivationKeys,
  candidate: LatestVersionMeta,
  signal: AbortSignal,
  timeoutMs: number,
  previewContext?: PreviewContext
): Promise<{ revision: string; assertValid: () => void }> {
  if (!Object.keys(keys).length) throw new Error('update activation trust roots are not configured')
  const nonce = randomBytes(32).toString('hex')
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce,
      candidate: activationCandidate(candidate),
      ...(previewContext ? { preview_context: previewContext } : {}),
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 409)
      throw new ActivationCandidateChanged('update release changed before handoff')
    throw new Error(`activation authorization HTTP ${response.status}`)
  }
  // Enforce a bound before JSON parsing, also for chunked responses.
  const reader = response.body?.getReader()
  if (!reader) throw new Error('empty activation authorization')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 12288) throw new Error('activation authorization exceeds size limit')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  signal.throwIfAborted()
  const grant = verifyActivationGrant(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
    keys,
    candidate,
    nonce
  )
  return { revision: grant.revision, assertValid: activationCommitGuard(grant.expiresAt) }
}
