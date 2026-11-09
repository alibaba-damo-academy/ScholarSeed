import { reportApiFailure } from './diagnostics.ts'
import { REQUEST_TIMEOUT_ERROR_NAME } from '../../../../requests.ts'

export const apiBase = (): string => window.scholarseed?.getApiBase() ?? ''

const CREDENTIALS: RequestCredentials = 'include'
type ApiFetchInit = RequestInit & { timeoutMs?: number }
const CATALOG_REQUEST_TIMEOUT_MS = 10_000
export const LIVE_CATALOG_REQUEST = {
  cache: 'no-store',
  timeoutMs: CATALOG_REQUEST_TIMEOUT_MS,
} as const satisfies ApiFetchInit

export async function apiFetch(path: string, init?: ApiFetchInit): Promise<Response> {
  const startedAt = performance.now()
  const method = init?.method ?? 'GET'
  try {
    const { timeoutMs, ...rest } = init ?? {}
    const deadline = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
    const signal = deadline
      ? rest.signal
        ? AbortSignal.any([rest.signal, deadline])
        : deadline
      : rest.signal
    const response = await fetch(apiBase() + path, { credentials: CREDENTIALS, ...rest, signal })
    if (!response.ok) reportApiFailure(path, method, response.status, startedAt, 'http')
    return response
  } catch (error) {
    reportApiFailure(path, method, null, startedAt, 'transport', error)
    throw error
  }
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  timeoutMs?: number
): Promise<T | null> {
  const startedAt = performance.now()
  let response: Response | undefined
  const ctl = timeoutMs ? new AbortController() : null
  const timer = ctl
    ? window.setTimeout(
        () => ctl.abort(new DOMException('', REQUEST_TIMEOUT_ERROR_NAME)),
        timeoutMs
      )
    : null
  try {
    const r = await apiFetch(path, { ...init, ...(ctl ? { signal: ctl.signal } : {}) })
    response = r
    if (r.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      return null
    }
    if (!r.ok) return null
    return (await r.json()) as T
  } catch (error) {
    if (response?.ok)
      reportApiFailure(path, init.method ?? 'GET', response.status, startedAt, 'decode', error)
    return null
  } finally {
    if (timer != null) window.clearTimeout(timer)
  }
}

export function getJson<T>(
  path: string,
  timeoutMs?: number,
  options?: Pick<RequestInit, 'cache'>
): Promise<T | null> {
  return requestJson<T>(path, options ?? {}, timeoutMs)
}

export async function postJson<T>(
  path: string,
  body: unknown,
  timeoutMs?: number
): Promise<T | null> {
  const startedAt = performance.now()
  let encodedBody: string | undefined
  try {
    encodedBody = JSON.stringify(body)
  } catch {
    reportApiFailure(path, 'POST', null, startedAt, 'encode')
    return null
  }
  return requestJson<T>(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: encodedBody,
    },
    timeoutMs
  )
}
