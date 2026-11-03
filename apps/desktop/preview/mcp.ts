import type { McpConfigurationView, McpServerConfig } from '../src/renderer/src/api.ts'

export const PREVIEW_MCP = {
  delayMs: 2_000, initialRevision: 0, schemaVersion: 1, maxBytes: 1024 * 1024, maxServers: 128,
  maxArguments: 256, maxValueChars: 8192, maxNameChars: 128,
  invalid: 'mcp_configuration_invalid', conflict: 'mcp_configuration_conflict', tooLarge: 'mcp_configuration_too_large',
  runtimeNotExecuted: 'preview runtime not executed', readFailure: 'preview_mcp_read_failed', writeFailure: 'preview_mcp_write_failed',
  disposed: 'preview_mcp_disposed', credentialsUnsupported: 'preview_mcp_credentials_unsupported',
} as const

export interface PreviewMcpPolicy {
  readonly read: 'normal' | 'delayed' | 'failed'
  readonly write: 'normal' | 'delayed' | 'fail-once'
}

type PreviewMcpServer = McpServerConfig & { environment_secrets?: Record<string, string>; header_secrets?: Record<string, string> }
interface PreviewMcpView extends McpConfigurationView {
  configuration: { schema_version: number; revision: number; servers: PreviewMcpServer[] }
}
interface Replacement { expectedRevision: number; servers: PreviewMcpServer[] }

export class PreviewMcpError extends Error {
  constructor(code: string, readonly status: number) { super(code) }
}

function invalid(): never { throw new PreviewMcpError(PREVIEW_MCP.invalid, 422) }
function credential(): never { throw new PreviewMcpError(PREVIEW_MCP.credentialsUnsupported, 403) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function length(value: string): number { return Array.from(value).length }
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || length(value) > maximum || (required && length(value) === 0)) invalid()
  return value
}
function emptyMap(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!record(value)) invalid()
  if (Object.keys(value).length) credential()
  return {}
}
function server(value: unknown): PreviewMcpServer {
  if (!record(value)) invalid()
  const common = ['id', 'name', 'enabled', 'transport']
  const fields = value.transport === 'http' ? ['url', 'headers', 'header_secrets'] : value.transport === 'stdio' ? ['command', 'args', 'cwd', 'environment', 'environment_secrets'] : invalid()
  if (Object.keys(value).some(key => !common.includes(key) && !fields.includes(key))) invalid()
  const id = text(value.id, 64, true)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) invalid()
  const name = value.name === undefined ? '' : text(value.name, PREVIEW_MCP.maxNameChars)
  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean') invalid()
  if (value.transport === 'http') {
    const url = text(value.url, PREVIEW_MCP.maxValueChars, true)
    if (/\s/u.test(url) || Array.from(url).some(character => (character.codePointAt(0) ?? 0) < 32)) invalid()
    let parsed: URL
    try { parsed = new URL(url) } catch { return invalid() }
    if (!/^https?:\/\//i.test(url) || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || url.split('/')[2]?.includes('@') || url.includes('#')) invalid()
    if (url.includes('?')) credential()
    return { id, name, enabled, transport: 'http', url, headers: emptyMap(value.headers), header_secrets: emptyMap(value.header_secrets) }
  }
  const command = text(value.command, PREVIEW_MCP.maxValueChars, true)
  if (!command.trim() || command.includes('\0')) invalid()
  const args = value.args === undefined ? [] : value.args
  if (!Array.isArray(args) || args.length > PREVIEW_MCP.maxArguments) invalid()
  const argumentsList = args.map(argument => {
    const result = text(argument, PREVIEW_MCP.maxValueChars)
    if (result.includes('\0')) invalid()
    return result
  })
  const cwd = value.cwd === undefined || value.cwd === null ? undefined : text(value.cwd, PREVIEW_MCP.maxValueChars)
  if (cwd !== undefined && (!cwd.trim() || cwd.includes('\0'))) invalid()
  return { id, name, enabled, transport: 'stdio', command, args: argumentsList, ...(cwd === undefined ? {} : { cwd }), environment: emptyMap(value.environment), environment_secrets: emptyMap(value.environment_secrets) }
}

function replacement(value: unknown): Replacement {
  if (!record(value) || Object.keys(value).some(key => !['expected_revision', 'servers', 'wait_for_application'].includes(key))) invalid()
  if (!Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < PREVIEW_MCP.initialRevision || (value.wait_for_application !== undefined && typeof value.wait_for_application !== 'boolean') || !Array.isArray(value.servers) || value.servers.length > PREVIEW_MCP.maxServers) invalid()
  const servers = value.servers.map(server)
  if (new Set(servers.map(server => server.id)).size !== servers.length) invalid()
  if (new TextEncoder().encode(JSON.stringify(servers)).length > PREVIEW_MCP.maxBytes) throw new PreviewMcpError(PREVIEW_MCP.tooLarge, 413)
  return { expectedRevision: value.expected_revision as number, servers }
}

export class PreviewMcp {
  private revision: number = PREVIEW_MCP.initialRevision
  private servers: PreviewMcpServer[] = []
  private failedWrite = false
  private disposed = false
  private readonly pending = new Set<() => void>()

  constructor(private readonly policy: PreviewMcpPolicy = { read: 'normal', write: 'normal' }) {}

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewMcpError(PREVIEW_MCP.disposed, 410)
  }

  private async wait(delayed: boolean, signal?: AbortSignal): Promise<void> {
    this.active(signal)
    if (!delayed) return
    await new Promise<void>((resolve, reject) => {
      const finish = (cancelled: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        if (cancelled) reject(new PreviewMcpError(PREVIEW_MCP.disposed, 410))
        else resolve()
      }
      const cancel = (): void => finish(true)
      const timer = setTimeout(() => finish(false), PREVIEW_MCP.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    this.active(signal)
  }

  private snapshot(): PreviewMcpView {
    const failed = this.servers.some(server => server.enabled)
    return {
      configuration: { schema_version: PREVIEW_MCP.schemaVersion, revision: this.revision, servers: structuredClone(this.servers) },
      supported: true, state: failed ? 'failed' : this.servers.length ? 'disabled' : 'saved', safe_error: failed ? PREVIEW_MCP.runtimeNotExecuted : '',
      servers: this.servers.map(server => ({ id: server.id, state: server.enabled ? 'failed' : 'disabled', tool_count: null, safe_error: server.enabled ? PREVIEW_MCP.runtimeNotExecuted : '' })),
    }
  }

  async read(signal?: AbortSignal): Promise<PreviewMcpView> {
    await this.wait(this.policy.read === 'delayed', signal)
    this.active(signal)
    if (this.policy.read === 'failed') throw new PreviewMcpError(PREVIEW_MCP.readFailure, 503)
    return this.snapshot()
  }

  async replace(value: unknown, signal?: AbortSignal): Promise<PreviewMcpView> {
    this.active(signal)
    const input = replacement(value)
    const compare = (): void => {
      if (input.expectedRevision !== this.revision) throw new PreviewMcpError(PREVIEW_MCP.conflict, 409)
    }
    compare()
    if (this.policy.write === 'fail-once' && !this.failedWrite) {
      this.failedWrite = true
      throw new PreviewMcpError(PREVIEW_MCP.writeFailure, 503)
    }
    await this.wait(this.policy.write === 'delayed', signal)
    this.active(signal)
    compare()
    this.servers = input.servers
    this.revision++
    return this.snapshot()
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }
}
