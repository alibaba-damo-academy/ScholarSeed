export const VAULT_CHANNEL = {
  status: 'vault:status', changed: 'vault:changed', metadata: 'vault:metadata', open: 'vault:open', lock: 'vault:lock',
  seed: 'vault-view:seed', submit: 'vault-view:submit', cancel: 'vault-view:cancel', reset: 'vault-view:reset'
} as const
export const VAULT_LIMIT = { passwordBytes: 1024, minimumCodepoints: 12, requestId: 128, requests: 128, promptMilliseconds: 120_000 } as const
export const VAULT_ERROR = {
  unavailable: 'unavailable', debugUnsafe: 'debug_unsafe', debugUnknown: 'debug_unknown', busy: 'busy', revoked: 'revoked',
  invalidInput: 'invalid_input', invalidFormat: 'invalid_format', authenticationFailed: 'authentication_failed',
  conflict: 'conflict', unknown: 'unknown', assets: 'protected_assets_unavailable', watch: 'protected_watch_unsupported'
} as const
export type VaultError = typeof VAULT_ERROR[keyof typeof VAULT_ERROR]
export const VAULT_STATE = { uninitialized: 'uninitialized', locked: 'locked', unlocking: 'unlocking', unlocked: 'unlocked', locking: 'locking', unavailable: 'unavailable' } as const
export type VaultState = typeof VAULT_STATE[keyof typeof VAULT_STATE]
export type VaultIntent = 'create' | 'unlock' | 'reset'
export interface VaultStatus { state: VaultState; generation: number; error?: VaultError }
export type VaultReply = { ok: true; status: VaultStatus } | { ok: false; error: VaultError }
export interface VaultMetadata { generation: number; count: number; items: { id: string; kind: 'password' | 'cookie'; name: string; origin: string; username: string }[] }
export interface VaultBridge {
  status(): Promise<VaultStatus>
  subscribeStatus(callback: (status: VaultStatus) => void): () => void
  listMetadata(): Promise<VaultMetadata | null>
  open(request: { intent: VaultIntent }): Promise<VaultReply>
  lock(): Promise<VaultReply>
}
export interface VaultSeed {
  sessionId: string; generation: number; intent: VaultIntent; language: 'zh' | 'en'; theme: 'light' | 'dark' | 'system'
  minimumCodepoints: number; passwordBytes: number
}
export interface VaultRequest { sessionId: string; generation: number; requestId: string }
export type VaultSubmit = VaultRequest & ({ kind: 'create'; password: string; confirmation: string } | { kind: 'unlock'; password: string })
export interface VaultViewBridge {
  seed(): Promise<VaultSeed | null>
  submit(request: VaultSubmit): Promise<VaultReply>
  cancel(request: VaultRequest): Promise<VaultReply>
  confirmReset(request: VaultRequest & { confirmation: true }): Promise<VaultReply>
}
const IDENTIFIER = /^[A-Za-z0-9_-]+$/
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
const encoder = new TextEncoder()
export function exactVaultObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key)))
}
export function validVaultPassword(value: unknown, creating = false): value is string {
  return typeof value === 'string' && !UNPAIRED_SURROGATE.test(value) && encoder.encode(value).length <= VAULT_LIMIT.passwordBytes
    && (!creating || Array.from(value).length >= VAULT_LIMIT.minimumCodepoints)
}
export function parseVaultOpen(value: unknown): VaultIntent | null {
  return exactVaultObject(value, ['intent']) && ['create', 'unlock', 'reset'].includes(String(value.intent))
    && typeof value.intent === 'string' ? value.intent as VaultIntent : null
}
export function validVaultRequest(value: unknown): value is VaultRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return ['sessionId', 'requestId'].every(key => typeof request[key] === 'string' && (request[key] as string).length > 0
    && (request[key] as string).length <= VAULT_LIMIT.requestId && IDENTIFIER.test(request[key] as string))
    && Number.isSafeInteger(request.generation) && Number(request.generation) >= 0
}
export function parseVaultSubmit(value: unknown): VaultSubmit | null {
  if (!validVaultRequest(value)) return null
  const request = value as unknown as Record<string, unknown>
  const creating = request.kind === 'create'
  if (!creating && request.kind !== 'unlock') return null
  if (!exactVaultObject(value, ['sessionId', 'generation', 'requestId', 'kind', 'password', ...(creating ? ['confirmation'] : [])])
    || !validVaultPassword(request.password, creating) || creating && (!validVaultPassword(request.confirmation, true) || request.password !== request.confirmation)) return null
  return value as unknown as VaultSubmit
}
export function parseVaultCancel(value: unknown): VaultRequest | null {
  return exactVaultObject(value, ['sessionId', 'generation', 'requestId']) && validVaultRequest(value) ? value as unknown as VaultRequest : null
}
export function parseVaultReset(value: unknown): (VaultRequest & { confirmation: true }) | null {
  return exactVaultObject(value, ['sessionId', 'generation', 'requestId', 'confirmation']) && validVaultRequest(value) && value.confirmation === true
    ? value as unknown as VaultRequest & { confirmation: true } : null
}
