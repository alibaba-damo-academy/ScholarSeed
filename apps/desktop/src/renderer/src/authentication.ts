import { AUTH_ERROR, authLogoutRequest, requestAuthLogout, type AuthFailure, type AuthRevisionResult } from '../../authentication.ts'

export const WEB_AUTH_LOCK = 'scholarseed.auth-cookie'
interface WebAuthenticationPorts {
  available(): boolean
  authority(): string
  read(): string
  write(token: string): void
  lock<Result>(action: () => Promise<Result>): Promise<Result>
  fetch(url: string, init: RequestInit): Promise<Response>
}
interface CookieSnapshot { readonly token: string; readonly authority: string; readonly revision: number }

export function createWebAuthentication(ports: WebAuthenticationPorts) {
  let revision = 0
  let snapshot: CookieSnapshot | null = null
  let exhausted = false
  const advance = (): boolean => {
    if (revision >= Number.MAX_SAFE_INTEGER) { exhausted = true; return false }
    revision += 1
    return true
  }
  const observe = (): CookieSnapshot | null => {
    const token = ports.read()
    const authority = ports.authority()
    if (!snapshot || token !== snapshot.token || authority !== snapshot.authority) {
      if (snapshot && !advance()) return null
      snapshot = Object.freeze({ token, authority, revision })
    }
    return exhausted ? null : snapshot
  }
  const lock = async <Result>(action: () => Promise<Result>): Promise<Result | AuthFailure> => {
    if (!ports.available()) return { ok: false, code: AUTH_ERROR.unavailable }
    try { return await ports.lock(action) }
    catch { return { ok: false, code: AUTH_ERROR.mutation } }
  }
  const expected = (expectedRevision: number): CookieSnapshot | AuthFailure => {
    const current = observe()
    return current && current.revision === expectedRevision
      ? current : { ok: false, code: AUTH_ERROR.stale }
  }
  return {
    capture: (): Promise<AuthRevisionResult> => lock(async () => {
      const current = observe()
      return current ? { ok: true, revision: current.revision } : { ok: false, code: AUTH_ERROR.unavailable }
    }),
    get: async (): Promise<string> => {
      const current = await lock(async () => observe())
      return current && 'token' in current ? current.token : ''
    },
    set: (token: string): Promise<AuthRevisionResult> => lock(async () => {
      if (typeof token !== 'string' || !token) return { ok: false, code: AUTH_ERROR.request }
      if (!observe() || !advance()) return { ok: false, code: AUTH_ERROR.unavailable }
      ports.write(token)
      const actual = ports.read()
      snapshot = Object.freeze({ token: actual, authority: ports.authority(), revision })
      if (actual !== token) return { ok: false, code: AUTH_ERROR.mutation }
      return { ok: true, revision }
    }),
    logout: async (request: unknown): Promise<AuthRevisionResult> => {
      if (!authLogoutRequest(request)) return { ok: false, code: AUTH_ERROR.request }
      const captured = await lock(async () => expected(request.expectedRevision))
      if ('ok' in captured) return captured
      const response = await requestAuthLogout('', captured.token, ports.fetch)
      if (!response.ok) return response
      return lock(async () => {
        const current = expected(captured.revision)
        if ('ok' in current) return current
        if (current !== captured || !advance()) return { ok: false, code: AUTH_ERROR.stale }
        ports.write('')
        const actual = ports.read()
        snapshot = Object.freeze({ token: actual, authority: ports.authority(), revision })
        return actual ? { ok: false, code: AUTH_ERROR.mutation } : { ok: true, revision }
      })
    }
  }
}
