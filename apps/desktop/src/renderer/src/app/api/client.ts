export const apiBase = (): string => window.scholarseed?.getApiBase() ?? ''

const CREDENTIALS: RequestCredentials = 'include'

type ApiFetchInit = RequestInit & { timeoutMs?: number }

export function apiFetch(path: string, init?: ApiFetchInit): Promise<Response> {
  const { timeoutMs, ...rest } = init ?? {}
  const signal = timeoutMs === undefined ? rest.signal : AbortSignal.timeout(timeoutMs)
  return fetch(apiBase() + path, { credentials: CREDENTIALS, ...rest, signal })
}

export async function getJson<T>(path: string, timeoutMs?: number): Promise<T | null> {
  const ctl = timeoutMs ? new AbortController() : null
  const timer = ctl ? window.setTimeout(() => ctl.abort(), timeoutMs) : null
  try {
    const r = await apiFetch(path, ctl ? { signal: ctl.signal } : undefined)
    if (r.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      return null
    }
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  } finally {
    if (timer != null) window.clearTimeout(timer)
  }
}

export async function postJson<T>(
  path: string,
  body: unknown,
  timeoutMs?: number
): Promise<T | null> {
  const ctl = timeoutMs ? new AbortController() : null
  const timer = ctl ? window.setTimeout(() => ctl.abort(), timeoutMs) : null
  try {
    const r = await apiFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(ctl ? { signal: ctl.signal } : {}),
    })
    if (r.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      return null
    }
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  } finally {
    if (timer != null) window.clearTimeout(timer)
  }
}
