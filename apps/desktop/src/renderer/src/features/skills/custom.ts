import type { McpServerConfig } from '../../api'

export const CUSTOM_INVALID = 'connector_custom_invalid'
export const CUSTOM_UNAVAILABLE = 'connector_service_unavailable'
export const CUSTOM_UNSUPPORTED = 'connector_custom_transport_unsupported'
export const CUSTOM_TIMEOUT_MINIMUM = 1000
const MAX_SERVERS = 128
const ALLOWED_FIELDS = new Set([
  'type',
  'transport',
  'url',
  'headers',
  'command',
  'args',
  'cwd',
  'env',
  'environment',
  'description',
  'timeout',
  'startup_timeout',
])
const CREDENTIAL_QUERY = /^(token|api[_-]?key|access[_-]?token|password|secret|key)$/i

export class CustomImportError extends Error {
  constructor(
    readonly entry: string,
    code: string
  ) {
    super(code)
  }
}

export function isCustomTimeout(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= CUSTOM_TIMEOUT_MINIMUM)
  )
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(CUSTOM_INVALID)
  return value as Record<string, unknown>
}

export function customPairs(value: unknown, headers: boolean): Record<string, string> {
  const fields = record(value)
  const seen = new Set<string>()
  for (const [name, content] of Object.entries(fields)) {
    const normalized = name.toLowerCase()
    if (
      !name ||
      seen.has(normalized) ||
      typeof content !== 'string' ||
      /[\r\n\0]/.test(content) ||
      !(headers ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(name)
    )
      throw new Error(CUSTOM_INVALID)
    seen.add(normalized)
  }
  return fields as Record<string, string>
}

export function customConfig(name: string, value: unknown): McpServerConfig {
  const config = record(value)
  if (
    !name.trim() ||
    name !== name.trim() ||
    Object.keys(config).some((key) => !ALLOWED_FIELDS.has(key))
  )
    throw new Error(CUSTOM_INVALID)
  const type = config.type ?? config.transport ?? (config.command ? 'stdio' : 'http')
  if (
    config.description !== undefined &&
    (typeof config.description !== 'string' || config.description.length > 1000)
  )
    throw new Error(CUSTOM_INVALID)
  for (const timeout of [config.timeout, config.startup_timeout]) {
    if (!isCustomTimeout(timeout)) throw new Error(CUSTOM_INVALID)
  }
  const base = {
    id: '',
    name,
    enabled: true,
    description: (config.description as string | undefined) ?? '',
    timeout: (config.timeout as number | null | undefined) ?? null,
    ...(config.startup_timeout != null
      ? { startup_timeout: config.startup_timeout as number }
      : {}),
  }
  if (type === 'stdio') {
    if (
      'url' in config ||
      'headers' in config ||
      typeof config.command !== 'string' ||
      !config.command.trim() ||
      config.command.includes('\0')
    )
      throw new Error(CUSTOM_INVALID)
    const args = config.args ?? []
    if (
      !Array.isArray(args) ||
      args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))
    )
      throw new Error(CUSTOM_INVALID)
    if (
      config.cwd !== undefined &&
      (typeof config.cwd !== 'string' || !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(config.cwd))
    )
      throw new Error(CUSTOM_INVALID)
    return {
      ...base,
      transport: 'stdio',
      command: config.command,
      args,
      ...(config.cwd ? { cwd: config.cwd as string } : {}),
      environment: customPairs(config.environment ?? config.env ?? {}, false),
    }
  }
  if (type !== 'http' && type !== 'streamable-http' && type !== 'sse')
    throw new Error(CUSTOM_UNSUPPORTED)
  if (
    ['command', 'args', 'cwd', 'env', 'environment'].some((field) => field in config) ||
    typeof config.url !== 'string'
  )
    throw new Error(CUSTOM_INVALID)
  let url: URL
  try {
    url = new URL(config.url)
  } catch {
    throw new Error(CUSTOM_INVALID)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    /\s/.test(config.url) ||
    [...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY.test(key))
  )
    throw new Error(CUSTOM_INVALID)
  return {
    ...base,
    transport: type === 'sse' ? 'sse' : 'http',
    url: config.url,
    headers: customPairs(config.headers ?? {}, true),
  }
}

export function parseCustomImport(source: string): McpServerConfig[] {
  const document = record(JSON.parse(source))
  if (Object.keys(document).length !== 1 || !('mcpServers' in document))
    throw new Error(CUSTOM_INVALID)
  const entries = Object.entries(record(document.mcpServers))
  if (!entries.length || entries.length > MAX_SERVERS) throw new Error(CUSTOM_INVALID)
  const seen = new Set<string>()
  return entries.map(([name, value]) => {
    try {
      if (seen.has(name.toLowerCase())) throw new Error(CUSTOM_INVALID)
      seen.add(name.toLowerCase())
      return customConfig(name, value)
    } catch (error) {
      throw new CustomImportError(
        name,
        error instanceof Error && error.message === CUSTOM_UNSUPPORTED
          ? CUSTOM_UNSUPPORTED
          : CUSTOM_INVALID
      )
    }
  })
}

export function submission(config: McpServerConfig): Record<string, unknown> {
  const { id: _identifier, enabled: _enabled, ...values } = config
  return values
}

export function serializeCustom(config: McpServerConfig): string {
  const { name, ...values } = submission(config)
  return JSON.stringify({ mcpServers: { [name as string]: values } }, null, 2)
}
