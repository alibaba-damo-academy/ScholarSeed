/** Narrow host-authorized MCP configuration operations shared by preload and main. No arbitrary URLs. */
export const MCP_SETTINGS_CHANNEL = 'scholarseed:mcp-settings'
export const MCP_SETTINGS_PATH = '/api/settings/mcp'
export const CONNECTOR_SETTINGS_PATH = '/api/settings/connectors'

export interface ConnectorAction {
  operation:
    | 'install'
    | 'remove'
    | 'revoke'
    | 'cancel'
    | 'login'
    | 'key'
    | 'libraries'
    | 'toggle'
    | 'retry'
    | 'inspect'
    | 'custom_save'
    | 'custom_remove'
    | 'custom_toggle'
    | 'custom_retry'
  access_token?: string
  library_type?: string
  library_id?: string
  enabled?: boolean
  session_id?: string
  expected_revision?: number
  servers?: unknown[]
}

export type McpSettingsRequest =
  | { operation: 'status' }
  | { operation: 'replace'; expectedRevision: number; servers: unknown }
  | { operation: 'connectors' }
  | { operation: 'connector'; id: string; action: ConnectorAction }

export interface McpSettingsResponse {
  status: number
  body: string
}

export function mcpSettingsRequest(request: McpSettingsRequest): {
  path: string
  init: RequestInit
} {
  switch (request.operation) {
    case 'connectors':
      return { path: CONNECTOR_SETTINGS_PATH, init: { method: 'GET' } }
    case 'connector':
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(request.id)) throw new Error('Invalid connector id')
      return {
        path: `${CONNECTOR_SETTINGS_PATH}/${encodeURIComponent(request.id)}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.action),
        },
      }
    case 'status':
      return { path: MCP_SETTINGS_PATH, init: { method: 'GET' } }
    case 'replace':
      return {
        path: MCP_SETTINGS_PATH,
        init: {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expected_revision: request.expectedRevision,
            servers: request.servers,
            wait_for_application: true,
          }),
        },
      }
    default:
      throw new Error('Unsupported MCP settings operation')
  }
}
