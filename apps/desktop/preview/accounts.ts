import type { AccountProfile } from '../src/renderer/src/account.ts'
import type { AuthUser } from '../src/renderer/src/app/api/auth.ts'

export type PreviewAccountMode = 'ready' | 'delayed' | 'failed' | 'anonymous' | 'no-base'
export type PreviewLoginMode = 'ready' | 'anonymous'
export const PREVIEW_LOGIN = { path: '/__preview/account', modes: ['ready', 'anonymous'] } as const
export const PREVIEW_CREDITS = { path: '/api/account/credits', unavailableCode: 'preview_credits_unavailable' } as const

export function isPreviewLoginMode(value: unknown): value is PreviewLoginMode {
  return typeof value === 'string' && (PREVIEW_LOGIN.modes as readonly string[]).includes(value)
}

export function previewAccountMode(value: unknown, declared: PreviewAccountMode | undefined, controllable: boolean): PreviewAccountMode | undefined {
  if (!controllable) return declared
  if (!value || typeof value !== 'object' || !('mode' in value) || !isPreviewLoginMode(value.mode)) throw new Error('Invalid preview login control state')
  return value.mode
}

export interface PreviewAccountBootstrap {
  instance: string
  mode: PreviewAccountMode
  capability: string | null
}

interface AccountResponse {
  status: number
  body: AccountProfile | { code: string }
}

const ACCOUNT_DELAY_MS = 2_000
const ACCOUNT_HTTP = { ready: 200, unauthorized: 401, disposed: 410, unavailable: 503 } as const
const ACCOUNT_DISPOSED = 'preview_account_disposed'
const ACCOUNT_CAPABILITY_PREFIX = 'preview-account:'
const ACCOUNT_NAME = '模拟协作账号（非真实用户）'
const ACCOUNT_EMAIL = 'preview@example.invalid'
const ACCOUNT_CAPABILITY = /^preview-account:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function readPreviewAccountBootstrap(value: unknown, instance: string, mode: PreviewAccountMode | undefined): PreviewAccountBootstrap | undefined {
  if (value === undefined && mode === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preview account bootstrap')
  const record = value as Record<string, unknown>
  const hasCapability = mode === 'ready' || mode === 'delayed' || mode === 'failed'
  if (mode === undefined || Object.keys(record).length !== 3 || record.instance !== instance || record.mode !== mode
    || (hasCapability ? typeof record.capability !== 'string' || !ACCOUNT_CAPABILITY.test(record.capability) : record.capability !== null)) {
    throw new Error('Invalid preview account bootstrap')
  }
  return { instance, mode, capability: record.capability as string | null }
}

export function previewAccountBase(origin: string, bootstrap: PreviewAccountBootstrap | undefined): string {
  if (!bootstrap || bootstrap.mode === 'no-base') return ''
  const url = new URL(origin)
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.origin !== origin) throw new Error('Preview account requires its same-origin loopback renderer')
  return url.origin
}

export class PreviewAccount {
  private readonly capability: string | null
  private disposed = false
  private waits = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: (completed: boolean) => void }>()

  constructor(private readonly instance: string, private readonly mode: PreviewAccountMode) {
    this.capability = mode === 'anonymous' || mode === 'no-base' ? null : ACCOUNT_CAPABILITY_PREFIX + crypto.randomUUID()
  }

  bootstrap(): PreviewAccountBootstrap {
    return { instance: this.instance, mode: this.mode, capability: this.capability }
  }

  identity(): AuthUser & AccountProfile {
    return { user_id: ACCOUNT_CAPABILITY_PREFIX + this.instance, email: ACCOUNT_EMAIL, auth: !this.disposed && this.capability !== null, display_name: ACCOUNT_NAME, nickname: ACCOUNT_NAME }
  }

  authorizes(authorization?: string): boolean {
    return !this.disposed && this.capability !== null && authorization === `Bearer ${this.capability}`
  }

  async profile(authorization?: string): Promise<AccountResponse> {
    if (this.disposed) return { status: ACCOUNT_HTTP.disposed, body: { code: ACCOUNT_DISPOSED } }
    if (!this.authorizes(authorization)) return { status: ACCOUNT_HTTP.unauthorized, body: { code: 'unauthorized' } }
    if (this.mode === 'failed') return { status: ACCOUNT_HTTP.unavailable, body: { code: 'preview_account_unavailable' } }
    if (this.mode === 'delayed') {
      const completed = await new Promise<boolean>(resolve => {
        const wait = { timer: setTimeout(() => { this.waits.delete(wait); resolve(true) }, ACCOUNT_DELAY_MS), resolve }
        this.waits.add(wait)
      })
      if (!completed || this.disposed) return { status: ACCOUNT_HTTP.disposed, body: { code: ACCOUNT_DISPOSED } }
    }
    const identity = this.identity()
    return { status: ACCOUNT_HTTP.ready, body: { user_id: identity.user_id, nickname: identity.nickname } }
  }

  async credits(authorization?: string): Promise<AccountResponse> {
    const response = await this.profile(authorization)
    if (this.disposed) return { status: ACCOUNT_HTTP.disposed, body: { code: ACCOUNT_DISPOSED } }
    return response.status === ACCOUNT_HTTP.ready
      ? { status: ACCOUNT_HTTP.unavailable, body: { code: PREVIEW_CREDITS.unavailableCode } }
      : response
  }

  dispose(): void {
    this.disposed = true
    for (const wait of this.waits) { clearTimeout(wait.timer); wait.resolve(false) }
    this.waits.clear()
  }
}
