import type { ConnectorInfo } from '../../api'

export const AUTHORIZATION_URL_INVALID = 'connector_oauth_metadata_invalid'
const AUTHORIZATION_METHODS = ['key', 'oauth'] as const

export function authorizationFailure(
  connector: Pick<
    ConnectorInfo,
    'authorized' | 'custom' | 'method' | 'methods' | 'tools_fetched_at'
  >
): 'authorized' | 'saved' | null {
  if (!connector.authorized) return null
  if (!connector.custom || connector.method === 'oauth') return 'authorized'
  if (!connector.methods.includes('key')) return null
  return connector.tools_fetched_at != null ? 'authorized' : 'saved'
}

export function authorizationMethods(supported: readonly string[]): ('key' | 'oauth')[] {
  return AUTHORIZATION_METHODS.filter((method) => supported.includes(method))
}

export function authorizationStatus(
  connector: Pick<
    ConnectorInfo,
    'authorized' | 'custom' | 'method' | 'methods' | 'tools_fetched_at' | 'transport'
  >
): 'authorized' | 'saved' | 'none' | 'unknown' {
  const verified = authorizationFailure(connector)
  if (verified) return verified
  if (
    connector.authorized &&
    (connector.transport === 'stdio' || connector.tools_fetched_at != null)
  )
    return 'none'
  return 'unknown'
}

export function authorizationUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(AUTHORIZATION_URL_INVALID)
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
    throw new Error(AUTHORIZATION_URL_INVALID)
  return value
}
