export const AUTH_ME_PATH = '/api/auth/me'
export const LOGIN_DIAGNOSTIC_PREFIX = '[login-confirmation]'
export const AUTH_CHANNEL = Object.freeze({
  capture: 'scholarseed:auth-revision',
  logout: 'scholarseed:auth-logout',
})
export const AUTH_ERROR = Object.freeze({
  stale: 'auth_revision_stale',
  unavailable: 'auth_unavailable',
  mutation: 'auth_mutation_failed',
  http: 'auth_http_failed',
  sender: 'invalid_sender',
  request: 'invalid_request',
} as const)
export const AUTH_LOGOUT_PATH = '/api/auth/logout'
export const AUTH_LOGOUT_TIMEOUT_MS = 8000
export type AuthFailure = { ok: false; code: (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR] }
export type AuthRevisionResult = { ok: true; revision: number } | AuthFailure
export interface AuthLogoutRequest {
  expectedRevision: number
}

export function authLogoutRequest(value: unknown): value is AuthLogoutRequest {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, 'expectedRevision') &&
    Number.isSafeInteger((value as AuthLogoutRequest).expectedRevision) &&
    (value as AuthLogoutRequest).expectedRevision >= 0
  )
}

export async function requestAuthLogout(
  serveBase: string,
  access: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>
): Promise<AuthFailure | { ok: true }> {
  if (!access) return { ok: true }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AUTH_LOGOUT_TIMEOUT_MS)
  try {
    const response = await fetcher(`${serveBase}${AUTH_LOGOUT_PATH}`, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { authorization: `Bearer ${access}` },
      signal: controller.signal,
    })
    if (!response.ok || response.redirected) return { ok: false, code: AUTH_ERROR.http }
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || typeof (body as { ok?: unknown }).ok !== 'boolean') {
      return { ok: false, code: AUTH_ERROR.http }
    }
    return { ok: true }
  } catch {
    return { ok: false, code: AUTH_ERROR.http }
  } finally {
    clearTimeout(timer)
  }
}
