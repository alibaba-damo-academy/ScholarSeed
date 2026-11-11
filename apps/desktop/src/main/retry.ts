import { setTimeout as delay } from 'node:timers/promises'

const UPDATE_ATTEMPTS = 3
const UPDATE_BACKOFF_MS = [250, 1000] as const
const TRANSIENT_CODES = new Set([
  'EBUSY',
  'ETXTBSY',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504])

export class UpdateTransportError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`update transport HTTP ${status}`)
    this.status = status
  }
}

export function transientUpdateFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  if (error instanceof UpdateTransportError) return TRANSIENT_HTTP.has(error.status)
  const failure = error as { code?: unknown; cause?: unknown } | null
  return (
    (typeof failure?.code === 'string' && TRANSIENT_CODES.has(failure.code)) ||
    (!!failure?.cause &&
      failure.cause !== error &&
      typeof (failure.cause as { code?: unknown }).code === 'string' &&
      TRANSIENT_CODES.has((failure.cause as { code: string }).code))
  )
}

export async function retryUpdate<Result>(
  operation: () => Promise<Result>,
  signal?: AbortSignal,
  onRetry?: (attempt: number) => void
): Promise<Result> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await operation()
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt >= UPDATE_ATTEMPTS || !transientUpdateFailure(error)) throw error
      onRetry?.(attempt)
      await delay(UPDATE_BACKOFF_MS[attempt - 1], undefined, { signal })
    }
  }
}
