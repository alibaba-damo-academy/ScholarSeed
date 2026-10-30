import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { VAULT_ERROR, VAULT_STATE, validVaultPassword, exactVaultObject, type VaultError, type VaultIntent, type VaultMetadata, type VaultReply, type VaultStatus } from '../vault.ts'
import type { StoreObservation, StorePort, StoreTerminal } from './vaultstorage.ts'

export const VAULT_FORMAT = {
  magic: 'SSVLTBIN', version: 1, profile: 1, headerBytes: 60, overheadBytes: 76, saltBytes: 32, nonceBytes: 12, tagBytes: 16,
  keyBytes: 32, fileBytes: 8 * 1024 * 1024, records: 10000, depth: 16, values: 200000,
  scrypt: { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, cipher: 'aes-256-gcm',
  offset: { version: 8, profile: 10, salt: 12, nonce: 44, length: 56 },
  text: { name: 256, username: 4096, password: 8192, domain: 253, path: 4096, value: 8192 }
} as const
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const DOMAIN = /^\.?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict'])
const PASSWORD_FIELDS = ['kind', 'id', 'name', 'origin', 'username', 'password']
const COOKIE_FIELDS = ['kind', 'id', 'domain', 'path', 'name', 'value', 'secure', 'httpOnly', 'sameSite', 'expirationDate']
const AVAILABILITY_ATTEMPTS = 2
const BLOCKED_OBSERVATION_ERRORS = new Set<VaultError>([VAULT_ERROR.unknown, VAULT_ERROR.debugUnsafe, VAULT_ERROR.debugUnknown, VAULT_ERROR.assets, VAULT_ERROR.watch])
interface PasswordRecord { kind: 'password'; id: string; name: string; origin: string; username: string; password: string }
interface CookieRecord { kind: 'cookie'; id: string; domain: string; path: string; name: string; value: string; secure: boolean; httpOnly: boolean; sameSite: string; expirationDate: number | null }
interface VaultPayload { version: 1; records: (PasswordRecord | CookieRecord)[]; settings: { autofill: boolean; sites: { origin: string; enabled: boolean }[] } }
export interface VaultPrompt { generation: number; intent: VaultIntent; observation: StoreObservation; store: StorePort }
export type VaultDerivation = (password: Buffer, salt: Buffer) => Promise<Buffer>
interface VaultDependencies { current(): boolean; debug(): VaultError | null; publish(status: VaultStatus): void | Promise<void>; revokeFailure?(code: 'revoke_callback_failed' | 'status_publish_failed'): void | Promise<void>; derive?: VaultDerivation }
let deriving = false
export function vaultKdfBusy(): boolean { return deriving }
export function deriveVaultKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, VAULT_FORMAT.keyBytes, VAULT_FORMAT.scrypt,
    (error, key) => error ? reject(new Error(VAULT_ERROR.unavailable)) : resolve(key)))
}
async function singleDerivation(password: Buffer, salt: Buffer, derive: VaultDerivation): Promise<Buffer> {
  if (deriving) throw new Error(VAULT_ERROR.busy)
  deriving = true
  try { return await derive(password, salt) }
  finally { deriving = false; password.fill(0) }
}
function fail(): never { throw new Error(VAULT_ERROR.invalidFormat) }
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= maximum
}
function origin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password }
  catch { return false }
}
export function validateVaultPayload(value: unknown): VaultPayload {
  if (!exactVaultObject(value, ['version', 'records', 'settings']) || value.version !== VAULT_FORMAT.version
    || !Array.isArray(value.records) || value.records.length > VAULT_FORMAT.records
    || !exactVaultObject(value.settings, ['autofill', 'sites']) || typeof value.settings.autofill !== 'boolean'
    || !Array.isArray(value.settings.sites) || value.settings.sites.length > VAULT_FORMAT.records) fail()
  const ids = new Set<string>()
  const identities = new Set<string>()
  for (const record of value.records) {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !UUID.test(record.id) || ids.has(record.id)) fail()
    ids.add(record.id)
    let identity: string
    if (record.kind === 'password') {
      if (!exactVaultObject(record, PASSWORD_FIELDS) || !boundedText(record.name, VAULT_FORMAT.text.name) || !origin(record.origin)
        || !boundedText(record.username, VAULT_FORMAT.text.username) || !boundedText(record.password, VAULT_FORMAT.text.password)) fail()
      identity = JSON.stringify([record.kind, record.origin, record.username])
    } else if (record.kind === 'cookie') {
      if (!exactVaultObject(record, COOKIE_FIELDS) || !boundedText(record.domain, VAULT_FORMAT.text.domain) || !DOMAIN.test(record.domain)
        || !boundedText(record.path, VAULT_FORMAT.text.path) || !record.path.startsWith('/') || !boundedText(record.name, VAULT_FORMAT.text.name)
        || !boundedText(record.value, VAULT_FORMAT.text.value) || typeof record.secure !== 'boolean' || typeof record.httpOnly !== 'boolean'
        || typeof record.sameSite !== 'string' || !SAME_SITE.has(record.sameSite)
        || record.expirationDate !== null && (typeof record.expirationDate !== 'number' || !Number.isFinite(record.expirationDate) || record.expirationDate < 0)) fail()
      identity = JSON.stringify([record.kind, record.domain, record.path, record.name])
    } else fail()
    if (identities.has(identity)) fail()
    identities.add(identity)
  }
  const sites = new Set<string>()
  for (const site of value.settings.sites) {
    if (!exactVaultObject(site, ['origin', 'enabled']) || !origin(site.origin) || typeof site.enabled !== 'boolean' || sites.has(site.origin)) fail()
    sites.add(site.origin)
  }
  return value as unknown as VaultPayload
}
export function decodeVaultPayload(bytes: Buffer): VaultPayload {
  if (bytes.length > VAULT_FORMAT.fileBytes - VAULT_FORMAT.overheadBytes) fail()
  let source: string
  try { source = UTF8.decode(bytes) } catch { fail() }
  let position = 0
  let values = 0
  const whitespace = () => { while (/\s/.test(source[position] ?? '') && position < source.length) position++ }
  const string = (): string => {
    const start = position++
    while (position < source.length) {
      const character = source[position++]
      if (character === '\\') position++
      else if (character === '"') { try { return JSON.parse(source.slice(start, position)) } catch { fail() } }
    }
    return fail()
  }
  const scan = (depth: number): void => {
    if (depth > VAULT_FORMAT.depth || ++values > VAULT_FORMAT.values) fail()
    whitespace()
    const character = source[position]
    if (character === '{') {
      position++; whitespace()
      const keys = new Set<string>()
      if (source[position] === '}') { position++; return }
      while (position < source.length) {
        if (source[position] !== '"') fail()
        const key = string()
        if (keys.has(key)) fail()
        keys.add(key); whitespace()
        if (source[position++] !== ':') fail()
        scan(depth + 1); whitespace()
        if (source[position] === '}') { position++; return }
        if (source[position++] !== ',') fail()
        whitespace()
      }
      fail()
    } else if (character === '[') {
      position++; whitespace()
      if (source[position] === ']') { position++; return }
      while (position < source.length) {
        scan(depth + 1); whitespace()
        if (source[position] === ']') { position++; return }
        if (source[position++] !== ',') fail()
      }
      fail()
    } else if (character === '"') string()
    else {
      const start = position
      while (position < source.length && !/[\s,}\]]/.test(source[position])) position++
      if (position === start) fail()
    }
  }
  scan(0); whitespace()
  if (position !== source.length) fail()
  try { return validateVaultPayload(JSON.parse(source)) } catch { fail() }
}
export function vaultEnvelope(bytes: Buffer): { header: Buffer; salt: Buffer; nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  if (bytes.length < VAULT_FORMAT.overheadBytes || bytes.length > VAULT_FORMAT.fileBytes
    || !bytes.subarray(0, VAULT_FORMAT.offset.version).equals(Buffer.from(VAULT_FORMAT.magic, 'ascii'))
    || bytes.readUInt16BE(VAULT_FORMAT.offset.version) !== VAULT_FORMAT.version
    || bytes.readUInt16BE(VAULT_FORMAT.offset.profile) !== VAULT_FORMAT.profile
    || bytes.readUInt32BE(VAULT_FORMAT.offset.length) !== bytes.length - VAULT_FORMAT.overheadBytes) fail()
  return { header: bytes.subarray(0, VAULT_FORMAT.headerBytes), salt: bytes.subarray(VAULT_FORMAT.offset.salt, VAULT_FORMAT.offset.nonce),
    nonce: bytes.subarray(VAULT_FORMAT.offset.nonce, VAULT_FORMAT.offset.length), ciphertext: bytes.subarray(VAULT_FORMAT.headerBytes, -VAULT_FORMAT.tagBytes), tag: bytes.subarray(-VAULT_FORMAT.tagBytes) }
}
export function encryptVault(payload: unknown, key: Buffer, salt: Buffer): Buffer {
  const validated = validateVaultPayload(payload)
  const plaintext = Buffer.from(JSON.stringify(validated), 'utf8')
  try {
    if (plaintext.length > VAULT_FORMAT.fileBytes - VAULT_FORMAT.overheadBytes || key.length !== VAULT_FORMAT.keyBytes || salt.length !== VAULT_FORMAT.saltBytes) fail()
    const header = Buffer.alloc(VAULT_FORMAT.headerBytes)
    header.write(VAULT_FORMAT.magic); header.writeUInt16BE(VAULT_FORMAT.version, VAULT_FORMAT.offset.version)
    header.writeUInt16BE(VAULT_FORMAT.profile, VAULT_FORMAT.offset.profile); salt.copy(header, VAULT_FORMAT.offset.salt)
    randomBytes(VAULT_FORMAT.nonceBytes).copy(header, VAULT_FORMAT.offset.nonce)
    header.writeUInt32BE(plaintext.length, VAULT_FORMAT.offset.length)
    const cipher = createCipheriv(VAULT_FORMAT.cipher, key, header.subarray(VAULT_FORMAT.offset.nonce, VAULT_FORMAT.offset.length), { authTagLength: VAULT_FORMAT.tagBytes })
    cipher.setAAD(header)
    return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  } finally { plaintext.fill(0) }
}
export function decryptVault(bytes: Buffer, key: Buffer): VaultPayload {
  const envelope = vaultEnvelope(bytes)
  let partial: Buffer | null = null
  let final: Buffer | null = null
  let plaintext: Buffer | null = null
  try {
    const cipher = createDecipheriv(VAULT_FORMAT.cipher, key, envelope.nonce, { authTagLength: VAULT_FORMAT.tagBytes })
    cipher.setAAD(envelope.header); cipher.setAuthTag(envelope.tag)
    try { partial = cipher.update(envelope.ciphertext); final = cipher.final() }
    catch { throw new Error(VAULT_ERROR.authenticationFailed) }
    plaintext = Buffer.concat([partial, final])
    return decodeVaultPayload(plaintext)
  } finally { partial?.fill(0); final?.fill(0); plaintext?.fill(0) }
}
function errorCode(error: unknown): VaultError {
  const message = error instanceof Error ? error.message : ''
  if (Object.values(VAULT_ERROR).includes(message as VaultError)) return message as VaultError
  if (message === 'browser_storage_conflict') return VAULT_ERROR.conflict
  if (message === 'browser_storage_busy') return VAULT_ERROR.busy
  return VAULT_ERROR.unknown
}
export class VaultOwner {
  private store: StorePort | null = null
  private key: Buffer | null = null
  private payload: VaultPayload | null = null
  private generation = 0
  private state: VaultStatus['state'] = VAULT_STATE.unavailable
  private error: VaultError | undefined
  private present: boolean | null = null
  private disposed = false
  private observationBlocked = false
  private observation: { store: StorePort; promise: Promise<void> } | null = null
  private readonly revoked = new Set<() => void | Promise<void>>()
  private readonly callbackTasks = new Set<Promise<void>>()
  constructor(private readonly dependencies: VaultDependencies) {}
  private failure(code: 'revoke_callback_failed' | 'status_publish_failed'): void {
    try { this.ownCallback(this.dependencies.revokeFailure?.(code)) } catch {}
  }
  private ownCallback(pending: void | Promise<void>, failure?: 'revoke_callback_failed' | 'status_publish_failed'): void {
    if (!pending) return
    const task = Promise.resolve(pending).catch(() => { if (failure) this.failure(failure) })
      .finally(() => { this.callbackTasks.delete(task) })
    this.callbackTasks.add(task)
  }
  private publish(): void {
    try { this.ownCallback(this.dependencies.publish(this.status()), 'status_publish_failed') } catch { this.failure('status_publish_failed') }
  }
  status(): VaultStatus { return { state: this.state, generation: this.generation, ...(this.error ? { error: this.error } : {}) } }
  onRevoke(callback: () => void | Promise<void>): () => void { this.revoked.add(callback); return () => { this.revoked.delete(callback) } }
  lock(error?: VaultError): void {
    if (error && BLOCKED_OBSERVATION_ERRORS.has(error)) this.observationBlocked = true
    this.generation++; this.state = VAULT_STATE.locking; this.key?.fill(0); this.key = null; this.payload = null; this.error = error
    for (const callback of [...this.revoked]) {
      try {
        this.ownCallback(callback(), 'revoke_callback_failed')
      } catch { this.failure('revoke_callback_failed') }
    }
    this.state = !this.store?.current() || this.present === null ? VAULT_STATE.unavailable : this.present ? VAULT_STATE.locked : VAULT_STATE.uninitialized
    if (error === VAULT_ERROR.debugUnsafe || error === VAULT_ERROR.debugUnknown || error === VAULT_ERROR.assets || error === VAULT_ERROR.watch) this.state = VAULT_STATE.unavailable
    this.publish()
  }
  async bindStore(store: StorePort | null): Promise<void> {
    this.lock(); this.store = store?.kind === 'vault' && store.budget >= VAULT_FORMAT.fileBytes ? store : null; this.present = null; this.state = VAULT_STATE.unavailable
    this.observationBlocked = false
    if (!store || store.kind !== 'vault' || store.budget < VAULT_FORMAT.fileBytes || this.disposed) { this.error = VAULT_ERROR.unavailable; this.publish(); return }
    await this.refresh()
  }
  async refresh(): Promise<void> {
    const store = this.store
    if (!store || !this.canObserve(store)) return
    if (this.observation?.store === store) return this.observation.promise
    const pending = { store, promise: this.observe(store) }
    this.observation = pending
    try { await pending.promise } finally { if (this.observation === pending) this.observation = null }
  }
  private canObserve(store: StorePort): boolean {
    return this.store === store && store.current() && !this.disposed && !this.observationBlocked
      && this.dependencies.current() && this.dependencies.debug() === null
      && this.state !== VAULT_STATE.unlocked && this.state !== VAULT_STATE.unlocking
  }
  private async observe(store: StorePort): Promise<void> {
    for (let attempt = 0; attempt < AVAILABILITY_ATTEMPTS && this.canObserve(store); attempt++) {
      const generation = this.generation
      try {
        const observation = await store.read(() => generation === this.generation && this.canObserve(store))
        if (!this.canObserve(store)) return
        if (generation !== this.generation) continue
        this.present = observation.digest !== null
        this.state = this.present ? VAULT_STATE.locked : VAULT_STATE.uninitialized; this.error = undefined
        if (this.present) { try { vaultEnvelope(observation.bytes) } catch { this.error = VAULT_ERROR.invalidFormat } }
        this.publish()
      } catch (error) {
        if (!this.canObserve(store)) return
        if (generation !== this.generation) continue
        this.state = VAULT_STATE.unavailable; this.error = errorCode(error); this.publish()
      }
      return
    }
  }
  private check(generation: number, store: StorePort, current: () => boolean): void {
    const debug = this.dependencies.debug()
    if (debug) { this.lock(debug); throw new Error(debug) }
    if (this.disposed || generation !== this.generation || this.store !== store || !store.current() || !this.dependencies.current() || !current()) throw new Error(VAULT_ERROR.revoked)
  }
  async begin(intent: VaultIntent, current: () => boolean): Promise<VaultPrompt> {
    if (this.state === VAULT_STATE.unavailable) throw new Error(this.error ?? VAULT_ERROR.unavailable)
    if (this.state === VAULT_STATE.unlocked || this.state === VAULT_STATE.unlocking) this.lock()
    const store = this.store
    if (!store || store.budget < VAULT_FORMAT.fileBytes) throw new Error(VAULT_ERROR.unavailable)
    const generation = this.generation
    this.check(generation, store, current)
    const observation = await store.read(() => generation === this.generation && current() && this.dependencies.current() && !this.dependencies.debug())
    this.check(generation, store, current)
    this.present = observation.digest !== null
    this.state = this.present ? VAULT_STATE.locked : VAULT_STATE.uninitialized
    if (intent === 'create' ? this.present : !this.present) throw new Error(VAULT_ERROR.conflict)
    if (intent === 'unlock') vaultEnvelope(observation.bytes)
    this.publish()
    return { generation, intent, observation, store }
  }
  async submit(prompt: VaultPrompt, password: string, confirmation: string | undefined, current: () => boolean): Promise<VaultReply> {
    let candidate: Buffer | null = null
    let passwordBytes: Buffer | null = null
    let ciphertext: Buffer | null = null
    let recoverAfterCancellation = false
    try {
      this.check(prompt.generation, prompt.store, current)
      if (prompt.intent === 'reset' || !validVaultPassword(password, prompt.intent === 'create')
        || prompt.intent === 'create' && (!validVaultPassword(confirmation, true) || password !== confirmation)) throw new Error(VAULT_ERROR.invalidInput)
      if (deriving || this.state === VAULT_STATE.unlocking) throw new Error(VAULT_ERROR.busy)
      const salt = prompt.intent === 'create' ? randomBytes(VAULT_FORMAT.saltBytes) : vaultEnvelope(prompt.observation.bytes).salt
      passwordBytes = Buffer.from(password, 'utf8')
      password = ''; confirmation = undefined
      this.state = VAULT_STATE.unlocking; this.error = undefined; this.publish()
      candidate = await singleDerivation(passwordBytes, salt, this.dependencies.derive ?? deriveVaultKey)
      this.check(prompt.generation, prompt.store, current)
      const payload = prompt.intent === 'create' ? validateVaultPayload({ version: VAULT_FORMAT.version, records: [], settings: { autofill: false, sites: [] } })
        : decryptVault(prompt.observation.bytes, candidate)
      this.check(prompt.generation, prompt.store, current)
      if (prompt.intent === 'create') {
        ciphertext = encryptVault(payload, candidate, salt)
        const terminal = await this.mutation(prompt, () => prompt.store.replace(prompt.observation, ciphertext!, () => this.livePrompt(prompt, current)), current)
        this.check(prompt.generation, prompt.store, current)
        if (terminal.outcome === 'aborted' || terminal.resultPresence !== 'present') throw new Error(VAULT_ERROR.conflict)
        this.present = true
      }
      this.check(prompt.generation, prompt.store, current)
      this.key = candidate; candidate = null; this.payload = payload; this.state = VAULT_STATE.unlocked; this.publish()
      return { ok: true, status: this.status() }
    } catch (error) {
      const code = errorCode(error)
      recoverAfterCancellation = code === VAULT_ERROR.revoked && this.dependencies.debug() === null
      if (prompt.generation === this.generation) {
        if (code === VAULT_ERROR.busy) return { ok: false, error: code }
        this.lock(code)
        if (code === VAULT_ERROR.unknown) { this.present = null; this.state = VAULT_STATE.unavailable; this.publish() }
        else if (code === VAULT_ERROR.conflict || code === VAULT_ERROR.revoked) void this.refresh()
      }
      return { ok: false, error: code }
    } finally {
      candidate?.fill(0); passwordBytes?.fill(0); ciphertext?.fill(0)
      if (recoverAfterCancellation && prompt.generation !== this.generation && prompt.store.current() && this.state !== VAULT_STATE.unlocked && this.state !== VAULT_STATE.unlocking) void this.refresh()
    }
  }
  private livePrompt(prompt: VaultPrompt, current: () => boolean): boolean {
    return prompt.generation === this.generation && this.store === prompt.store && prompt.store.current()
      && !this.disposed && this.dependencies.current() && current() && this.dependencies.debug() === null
  }
  private async mutation(prompt: VaultPrompt, execute: () => Promise<StoreTerminal>, current: () => boolean): Promise<StoreTerminal> {
    try { return await execute() }
    catch (error) {
      if (errorCode(error) !== VAULT_ERROR.unknown) throw error
      this.check(prompt.generation, prompt.store, current)
      try { return await prompt.store.inspect(prompt.observation.operationId, prompt.observation.sequence) }
      catch { throw new Error(VAULT_ERROR.unknown) }
    }
  }
  async reset(prompt: VaultPrompt, current: () => boolean): Promise<VaultReply> {
    try {
      this.check(prompt.generation, prompt.store, current)
      if (prompt.intent !== 'reset' || prompt.observation.digest === null) throw new Error(VAULT_ERROR.invalidInput)
      const terminal = await this.mutation(prompt, () => prompt.store.removeConfirmed(prompt.observation, () => this.livePrompt(prompt, current)), current)
      this.check(prompt.generation, prompt.store, current)
      if (terminal.outcome === 'aborted' || terminal.resultPresence !== 'absent') throw new Error(VAULT_ERROR.conflict)
      this.present = false; this.lock(); return { ok: true, status: this.status() }
    } catch (error) {
      const code = errorCode(error)
      if (prompt.generation === this.generation) { this.lock(code); if (code === VAULT_ERROR.unknown) { this.present = null; this.state = VAULT_STATE.unavailable; this.publish() } }
      return { ok: false, error: code }
    }
  }
  listMetadata(): VaultMetadata | null {
    const store = this.store
    if (!store || this.state !== VAULT_STATE.unlocked || !this.payload) return null
    try { this.check(this.generation, store, () => true) } catch { return null }
    return { generation: this.generation, count: this.payload.records.length, items: this.payload.records.map(record => record.kind === 'password'
      ? { id: record.id, kind: record.kind, name: record.name, origin: record.origin, username: record.username ? '••••' : '' }
      : { id: record.id, kind: record.kind, name: record.name, origin: record.domain, username: '' }) }
  }
  dispose(): void { if (this.disposed) return; this.lock(); this.disposed = true; this.store = null; this.present = null; this.revoked.clear(); this.state = VAULT_STATE.unavailable }
}
