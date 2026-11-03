import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { AUTH_ERROR, authLogoutRequest, requestAuthLogout, type AuthFailure, type AuthRevisionResult } from '../authentication.ts'

const REFRESH_MARKER_FAMILY = 'scholarseed.auth-refresh.'
const REFRESH_MARKER = `${REFRESH_MARKER_FAMILY}v1:`
const REFRESH_VERSION = 1
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const REFRESH_SCHEMA = ['accessDigest', 'refreshToken', 'version']
const PRIVATE_FILE_MODE = 0o600
const FILE_ABSENT = 'ENOENT'
const TEMPORARY_SUFFIX = '.tmp'

export type RefreshRead =
  | { status: 'bound-v1'; refreshToken: string; accessDigest: string }
  | { status: 'legacy-unbound'; refreshToken: string }
  | { status: 'absent' | 'unavailable' | 'invalid' | 'failed' }
export type RefreshWrite = { status: 'persisted' | 'absent' | 'unavailable' | 'failed' }
export interface RefreshPersistence {
  read(namespace: string): RefreshRead
  write(namespace: string, refreshToken: string, access: string): RefreshWrite
  remove(namespace: string): RefreshWrite
}
interface EncryptionPort {
  isEncryptionAvailable(): boolean
  encryptString(payload: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function accessDigest(access: string): string {
  return createHash('sha256').update(access).digest('hex')
}

export function refreshPayload(access: string, refreshToken: string): string {
  return REFRESH_MARKER + JSON.stringify({ version: REFRESH_VERSION, refreshToken, accessDigest: accessDigest(access) })
}

export function parseRefreshPayload(payload: string): RefreshRead {
  if (!payload) return { status: 'invalid' }
  if (!payload.startsWith(REFRESH_MARKER_FAMILY)) return { status: 'legacy-unbound', refreshToken: payload }
  if (!payload.startsWith(REFRESH_MARKER)) return { status: 'invalid' }
  try {
    const value: unknown = JSON.parse(payload.slice(REFRESH_MARKER.length))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' }
    const fields = value as Record<string, unknown>
    if (JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify(REFRESH_SCHEMA)
      || fields.version !== REFRESH_VERSION || typeof fields.refreshToken !== 'string' || !fields.refreshToken
      || typeof fields.accessDigest !== 'string' || !DIGEST_PATTERN.test(fields.accessDigest)) return { status: 'invalid' }
    return { status: 'bound-v1', refreshToken: fields.refreshToken, accessDigest: fields.accessDigest }
  } catch { return { status: 'invalid' } }
}

export function createRefreshPersistence(path: (namespace: string) => string, encryption: EncryptionPort): RefreshPersistence {
  return {
    read(namespace) {
      try {
        const encrypted = readFileSync(path(namespace))
        if (!encryption.isEncryptionAvailable()) return { status: 'unavailable' }
        try { return parseRefreshPayload(encryption.decryptString(encrypted)) }
        catch { return { status: 'unavailable' } }
      } catch (error) {
        return { status: (error as NodeJS.ErrnoException).code === FILE_ABSENT ? 'absent' : 'failed' }
      }
    },
    write(namespace, refreshToken, access) {
      if (!refreshToken || !access) return { status: 'failed' }
      const destination = path(namespace)
      const temporary = destination + TEMPORARY_SUFFIX
      try {
        if (!encryption.isEncryptionAvailable()) return { status: 'unavailable' }
        writeFileSync(temporary, encryption.encryptString(refreshPayload(access, refreshToken)), { mode: PRIVATE_FILE_MODE })
        renameSync(temporary, destination)
        return { status: 'persisted' }
      } catch {
        try { rmSync(temporary) } catch {}
        return { status: 'failed' }
      }
    },
    remove(namespace) {
      try { rmSync(path(namespace)); return { status: 'absent' } }
      catch (error) { return { status: (error as NodeJS.ErrnoException).code === FILE_ABSENT ? 'absent' : 'failed' } }
    }
  }
}

export interface AuthAuthority {
  cookieUrl: string
  serveBase: string
  namespace: string
}
export interface AuthFence {
  revision: number
  authority: AuthAuthority
  isCurrent?: () => boolean
}
export type AuthSnapshot = AuthFence & { ok: true; access: string; refresh: RefreshRead; coherence: 'paired' | 'legacy-unbound' | 'access-only' | 'empty' }
export interface AuthenticationPorts {
  authority(): AuthAuthority | null
  readAccess(authority: AuthAuthority): Promise<string>
  setAccess(authority: AuthAuthority, access: string): Promise<void>
  removeAccess(authority: AuthAuthority): Promise<void>
  persistence: RefreshPersistence
  fetch(url: string, init: RequestInit): Promise<Response>
  revoke(authority: AuthAuthority, refreshToken: string): Promise<void>
}

export class AuthenticationOwner {
  private queue: Promise<unknown> = Promise.resolve()
  private revision = 0
  private blocked = false
  private exhausted = false
  private issued: AuthFence | null

  constructor(private readonly ports: AuthenticationPorts) {
    const authority = ports.authority()
    this.issued = authority ? Object.freeze({ revision: this.revision, authority }) : null
  }

  authority(): AuthAuthority | null { return this.ports.authority() }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private valid(fence: AuthFence): boolean {
    return !this.exhausted && fence.revision === this.revision && fence.authority === this.ports.authority()
      && (fence.isCurrent?.() ?? true)
  }

  private advance(): boolean {
    if (this.revision >= Number.MAX_SAFE_INTEGER) { this.exhausted = true; return false }
    this.revision += 1
    this.issued = null
    return true
  }

  invalidate(): Promise<AuthRevisionResult> {
    return this.enqueue(async () => this.advance() ? { ok: true, revision: this.revision } : { ok: false, code: AUTH_ERROR.unavailable })
  }

  capture(isCurrent: () => boolean = () => true): Promise<AuthRevisionResult> {
    return this.enqueue(async () => {
      if (!isCurrent()) return { ok: false, code: AUTH_ERROR.sender }
      const authority = this.ports.authority()
      if (!authority || this.exhausted) return { ok: false, code: AUTH_ERROR.unavailable }
      this.issued = Object.freeze({ revision: this.revision, authority })
      return { ok: true, revision: this.revision }
    })
  }

  intent(isCurrent: () => boolean = () => true): Promise<AuthFence | AuthFailure> {
    return this.enqueue(async () => {
      if (!isCurrent()) return { ok: false, code: AUTH_ERROR.sender }
      const authority = this.ports.authority()
      return authority && !this.exhausted ? Object.freeze({ revision: this.revision, authority, isCurrent })
        : { ok: false, code: AUTH_ERROR.unavailable }
    })
  }

  token(isCurrent: () => boolean): Promise<string> {
    return this.enqueue(async () => {
      const authority = this.ports.authority()
      if (!authority || !isCurrent()) return ''
      try {
        const access = await this.ports.readAccess(authority)
        return authority === this.ports.authority() && isCurrent() ? access : ''
      } catch { return '' }
    })
  }

  private async read(fence: AuthFence): Promise<AuthSnapshot | AuthFailure> {
    if (!this.valid(fence)) return { ok: false, code: AUTH_ERROR.stale }
    try {
      const access = await this.ports.readAccess(fence.authority)
      if (!this.valid(fence)) return { ok: false, code: AUTH_ERROR.stale }
      const refresh = this.ports.persistence.read(fence.authority.namespace)
      if (this.blocked) return { ok: false, code: AUTH_ERROR.unavailable }
      if (refresh.status === 'absent') return { ok: true, ...fence, access, refresh, coherence: access ? 'access-only' : 'empty' }
      if (refresh.status === 'legacy-unbound') return { ok: true, ...fence, access, refresh, coherence: 'legacy-unbound' }
      if (refresh.status === 'bound-v1' && access && refresh.accessDigest === accessDigest(access)) {
        return { ok: true, ...fence, access, refresh, coherence: 'paired' }
      }
      return { ok: false, code: AUTH_ERROR.unavailable }
    } catch { return { ok: false, code: AUTH_ERROR.unavailable } }
  }

  snapshot(): Promise<AuthSnapshot | AuthFailure> {
    return this.enqueue(async () => {
      const authority = this.ports.authority()
      if (!authority) return { ok: false, code: AUTH_ERROR.unavailable }
      return this.read(Object.freeze({ revision: this.revision, authority }))
    })
  }

  replace(access: string, refreshToken: string, expected?: AuthFence): Promise<AuthRevisionResult> {
    return this.enqueue(async () => {
      if (typeof access !== 'string' || !access || typeof refreshToken !== 'string') return { ok: false, code: AUTH_ERROR.request }
      const authority = expected?.authority ?? this.ports.authority()
      if (!authority) return { ok: false, code: AUTH_ERROR.unavailable }
      const fence = expected ?? Object.freeze({ revision: this.revision, authority })
      if (!this.valid(fence)) return { ok: false, code: AUTH_ERROR.stale }
      if (!this.advance()) return { ok: false, code: AUTH_ERROR.unavailable }
      this.blocked = true
      try {
        const saved = refreshToken ? this.ports.persistence.write(authority.namespace, refreshToken, access) : this.ports.persistence.remove(authority.namespace)
        if (saved.status === 'unavailable') {
          if (this.ports.persistence.remove(authority.namespace).status !== 'absent') return { ok: false, code: AUTH_ERROR.mutation }
        } else if (saved.status !== 'persisted' && saved.status !== 'absent') return { ok: false, code: AUTH_ERROR.mutation }
        await this.ports.setAccess(authority, access)
        if (authority !== this.ports.authority()) return { ok: false, code: AUTH_ERROR.stale }
        this.blocked = false
        const verified = await this.read({ revision: this.revision, authority })
        if (!verified.ok || verified.access !== access) { this.blocked = true; return { ok: false, code: AUTH_ERROR.mutation } }
        return { ok: true, revision: this.revision }
      } catch { this.blocked = true; return { ok: false, code: AUTH_ERROR.mutation } }
    })
  }

  clear(expected: AuthFence): Promise<AuthRevisionResult> {
    return this.enqueue(async () => {
      if (!this.valid(expected)) return { ok: false, code: AUTH_ERROR.stale }
      if (!this.advance()) return { ok: false, code: AUTH_ERROR.unavailable }
      const operation = Object.freeze({ ...expected, revision: this.revision })
      this.blocked = true
      try {
        if (this.ports.persistence.remove(expected.authority.namespace).status !== 'absent') return { ok: false, code: AUTH_ERROR.mutation }
        await this.ports.removeAccess(expected.authority)
        if (!this.valid(operation)) return { ok: false, code: AUTH_ERROR.stale }
        const remaining = await this.ports.readAccess(expected.authority)
        if (!this.valid(operation)) return { ok: false, code: AUTH_ERROR.stale }
        if (remaining) return { ok: false, code: AUTH_ERROR.mutation }
        if (this.ports.persistence.read(expected.authority.namespace).status !== 'absent') return { ok: false, code: AUTH_ERROR.mutation }
        if (!this.valid(operation)) return { ok: false, code: AUTH_ERROR.stale }
        this.blocked = false
        return { ok: true, revision: operation.revision }
      } catch { return { ok: false, code: AUTH_ERROR.mutation } }
    })
  }

  async logout(request: unknown, isCurrent: () => boolean = () => true): Promise<AuthRevisionResult> {
    if (!authLogoutRequest(request)) return { ok: false, code: AUTH_ERROR.request }
    const captured = await this.enqueue(async () => {
      if (!isCurrent()) return { ok: false as const, code: AUTH_ERROR.sender }
      const fence = this.issued
      if (!fence || fence.revision !== request.expectedRevision || !this.valid(fence)) return { ok: false as const, code: AUTH_ERROR.stale }
      try {
        const access = await this.ports.readAccess(fence.authority)
        if (!this.valid(fence)) return { ok: false as const, code: AUTH_ERROR.stale }
        const refresh = this.ports.persistence.read(fence.authority.namespace)
        const revoke = refresh.status === 'bound-v1' && access && refresh.accessDigest === accessDigest(access) ? refresh.refreshToken : ''
        if (!isCurrent()) return { ok: false as const, code: AUTH_ERROR.sender }
        return { ok: true as const, fence: Object.freeze({ ...fence, isCurrent }), access, revoke }
      } catch { return { ok: false as const, code: AUTH_ERROR.unavailable } }
    })
    if (!captured.ok) return captured
    if (!this.valid(captured.fence)) return { ok: false, code: AUTH_ERROR.stale }
    const http = await requestAuthLogout(captured.fence.authority.serveBase, captured.access, this.ports.fetch)
    if (!http.ok) return http
    const cleared = await this.clear(captured.fence)
    if (cleared.ok && captured.revoke) void this.ports.revoke(captured.fence.authority, captured.revoke).catch(() => undefined)
    return cleared
  }
}
