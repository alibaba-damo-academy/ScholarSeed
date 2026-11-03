import { AUTH_ME_PATH, LOGIN_DIAGNOSTIC_PREFIX } from '../../authentication.ts'
import { apiFetch } from './app/api/client.ts'

// Final attempt starts after the Serve JWKS refresh cooldown (10 seconds), even
// when earlier requests return immediately. Every request, including body reads,
// has its own deadline; cancellation also interrupts backoff.
export const CONFIRMATION_DELAYS_MS = [1_000, 2_000, 4_000, 5_000] as const
export const CONFIRMATION_REQUEST_TIMEOUT_MS = 4_000
const RETRYABLE_STATUSES = new Set([401, 408, 429, 500, 502, 503, 504])

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

interface ConfirmationDependencies {
  request: (signal: AbortSignal) => Promise<Response>
  wait: (ms: number, signal: AbortSignal) => Promise<void>
  log: (record: Record<string, string | number | boolean | null>) => void
}

const defaults: ConfirmationDependencies = {
  request: (signal) => apiFetch(AUTH_ME_PATH, { signal }),
  wait,
  log: (record) => console.info(LOGIN_DIAGNOSTIC_PREFIX, JSON.stringify(record)),
}

/** Fixed classifications only: never log tokens, response bodies or exception text. */
export async function confirmLocalSession(
  signal: AbortSignal,
  deps: ConfirmationDependencies = defaults
): Promise<boolean> {
  for (let attempt = 0; attempt <= CONFIRMATION_DELAYS_MS.length; attempt += 1) {
    if (signal.aborted) return false
    const started = performance.now()
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), CONFIRMATION_REQUEST_TIMEOUT_MS)
    const requestSignal = AbortSignal.any([signal, deadline.signal])
    let status: number | null = null
    let reason: string
    let retryable = true
    let confirmed = false
    try {
      const response = await deps.request(requestSignal)
      status = response.status
      if (!response.ok) {
        reason = 'http-error'
        retryable = RETRYABLE_STATUSES.has(status)
      } else {
        const payload: unknown = await response.json()
        if (
          payload &&
          typeof payload === 'object' &&
          'auth' in payload &&
          typeof payload.auth === 'boolean'
        ) {
          confirmed = payload.auth === true
          reason = confirmed ? 'confirmed' : 'unauthenticated'
        } else {
          reason = 'invalid-response'
          retryable = false
        }
      }
    } catch (error) {
      reason = signal.aborted
        ? 'cancelled'
        : deadline.signal.aborted
          ? 'timeout'
          : error instanceof SyntaxError
            ? 'invalid-json'
            : 'network-error'
      retryable = reason !== 'invalid-json' && reason !== 'cancelled'
    } finally {
      clearTimeout(timer)
    }
    if (signal.aborted) return false
    const retry = !confirmed && retryable && attempt < CONFIRMATION_DELAYS_MS.length
    deps.log({
      operation: 'login-confirmation',
      route: AUTH_ME_PATH,
      attempt: attempt + 1,
      status,
      reason,
      retry,
      elapsedMs: Math.round(performance.now() - started),
    })
    if (confirmed) return true
    if (!retry) return false
    try {
      await deps.wait(CONFIRMATION_DELAYS_MS[attempt], signal)
    } catch {
      return false
    }
  }
  return false
}
