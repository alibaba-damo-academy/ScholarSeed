import { randomUUID } from 'node:crypto'
import type { ApiKeyCreated, ApiKeySummary } from '../src/renderer/src/account.ts'

export const PREVIEW_DEVELOPER = {
  keysPath: '/api/account/api-keys',
  ensurePath: '/api/serve/skill-credential',
  refreshPath: '/api/serve/skill-credential/refresh',
  delayMs: 2_000,
  maxName: 64,
  maxKeys: 100,
  identityPrefix: 'preview-key:',
  tokenPrefix: 'preview-only:',
  manualName: '模拟手动密钥（不可认证）',
  managedName: '模拟托管密钥（不可认证）',
  invalid: 'invalid_api_key_name',
  invalidRequest: 'preview_developer_invalid',
  unknown: 'preview_developer_key_not_found',
  forbidden: 'preview_developer_key_operation_forbidden',
  busy: 'preview_developer_write_pending',
  capacity: 'preview_developer_capacity',
  disposed: 'preview_developer_disposed',
  readFailure: 'preview_developer_read_failed',
  writeFailure: 'preview_developer_write_failed',
} as const

export interface PreviewDeveloperPolicy {
  read: 'sample' | 'empty' | 'delayed' | 'failed'
  write: 'normal' | 'delayed' | 'fail-once'
}

export class PreviewDeveloperError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

function keyName(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== 1 || !Object.prototype.hasOwnProperty.call(value, 'name')) {
    throw new PreviewDeveloperError(PREVIEW_DEVELOPER.invalid, 400)
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'name')
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new PreviewDeveloperError(PREVIEW_DEVELOPER.invalid, 400)
  const name = descriptor.value.trim()
  if (Array.from(name).length > PREVIEW_DEVELOPER.maxName) throw new PreviewDeveloperError(PREVIEW_DEVELOPER.invalid, 400)
  return name
}

export class PreviewDeveloper {
  private readonly keys = new Map<string, ApiKeySummary>()
  private readonly pending = new Set<() => void>()
  private disposed = false
  private writing = false
  private failedWrite = false
  private readonly policy: Readonly<PreviewDeveloperPolicy>

  constructor(policy: PreviewDeveloperPolicy = { read: 'sample', write: 'normal' }) {
    this.policy = { ...policy }
    if (policy.read !== 'empty') this.insert(PREVIEW_DEVELOPER.manualName, false)
  }

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewDeveloperError(PREVIEW_DEVELOPER.disposed, 410)
  }

  private capacity(): void {
    if (this.keys.size >= PREVIEW_DEVELOPER.maxKeys) throw new PreviewDeveloperError(PREVIEW_DEVELOPER.capacity, 409)
  }

  private insert(name: string, managed: boolean, prefix?: string): ApiKeySummary {
    this.capacity()
    const identity = randomUUID()
    const summary: ApiKeySummary = {
      key_id: PREVIEW_DEVELOPER.identityPrefix + identity,
      name,
      prefix: prefix ?? PREVIEW_DEVELOPER.tokenPrefix + identity.slice(0, 8),
      managed,
      created_at: Date.now() / 1_000,
      last_used_at: null,
    }
    this.keys.set(summary.key_id, summary)
    return structuredClone(summary)
  }

  private find(id: unknown): ApiKeySummary {
    const key = typeof id === 'string' ? this.keys.get(id) : undefined
    if (!key) throw new PreviewDeveloperError(PREVIEW_DEVELOPER.unknown, 404)
    return key
  }

  private async wait(delayed: boolean, signal?: AbortSignal): Promise<void> {
    this.active(signal)
    if (!delayed) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (cancelled: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        if (cancelled) reject(new PreviewDeveloperError(PREVIEW_DEVELOPER.disposed, 410))
        else resolve()
      }
      const cancel = (): void => finish(true)
      const timer = setTimeout(() => finish(false), PREVIEW_DEVELOPER.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    this.active(signal)
  }

  async list(signal?: AbortSignal): Promise<{ keys: ApiKeySummary[] }> {
    this.active(signal)
    if (this.policy.read === 'failed') throw new PreviewDeveloperError(PREVIEW_DEVELOPER.readFailure, 503)
    await this.wait(this.policy.read === 'delayed', signal)
    this.active(signal)
    return { keys: structuredClone([...this.keys.values()]) }
  }

  private async mutate<Result>(validate: () => void, commit: () => Result, signal?: AbortSignal): Promise<Result> {
    this.active(signal)
    if (this.writing) throw new PreviewDeveloperError(PREVIEW_DEVELOPER.busy, 409)
    validate()
    if (this.policy.write === 'fail-once' && !this.failedWrite) {
      this.failedWrite = true
      throw new PreviewDeveloperError(PREVIEW_DEVELOPER.writeFailure, 503)
    }
    this.writing = true
    try {
      await this.wait(this.policy.write === 'delayed', signal)
      this.active(signal)
      validate()
      return commit()
    } finally { this.writing = false }
  }

  create(body: unknown, signal?: AbortSignal): Promise<ApiKeyCreated> {
    let name: string | undefined
    return this.mutate(
      () => { name ??= keyName(body); this.capacity() },
      () => {
        const suffix = randomUUID()
        const token = PREVIEW_DEVELOPER.tokenPrefix + suffix
        return { ...this.insert(name!, false, PREVIEW_DEVELOPER.tokenPrefix + suffix.slice(0, 8)), token }
      },
      signal,
    )
  }

  revoke(id: unknown, signal?: AbortSignal): Promise<{ revoked: true }> {
    return this.mutate(
      () => { if (this.find(id).managed) throw new PreviewDeveloperError(PREVIEW_DEVELOPER.forbidden, 403) },
      () => { this.keys.delete(id as string); return { revoked: true } },
      signal,
    )
  }

  rotate(id: unknown, signal?: AbortSignal): Promise<{ rotated: true }> {
    return this.mutate(
      () => { if (!this.find(id).managed) throw new PreviewDeveloperError(PREVIEW_DEVELOPER.forbidden, 403) },
      () => { this.keys.delete(id as string); return { rotated: true } },
      signal,
    )
  }

  ensure(): void {
    this.active()
    if (this.policy.read === 'empty' || [...this.keys.values()].some(key => key.managed)) return
    this.insert(PREVIEW_DEVELOPER.managedName, true)
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
    this.keys.clear()
  }
}
