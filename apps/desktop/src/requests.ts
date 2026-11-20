export const API_DIAGNOSTIC_PREFIX = '[api-request]'
export const PROJECT_CREATION_DIAGNOSTIC_PREFIX = '[project-creation]'
export const API_DIAGNOSTIC_HEADER = 'x-scholarseed-diagnostic-id'
export const HTTP_LATENCY_DIAGNOSTIC_PREFIX = '[http-latency]'
export const REQUEST_TIMEOUT_ERROR_NAME = 'TimeoutError'
export const REQUEST_ABORT_ERROR_NAME = 'AbortError'
export const MODEL_PROFILES_PATH = '/api/serve/model-profiles'
export const MODEL_PROVIDERS_PATH = '/api/serve/model-providers'
export const AUTH_ME_PATH = '/api/auth/me'
export const CONTENT_OPERATIONS_PATH = '/api/content/operations'
export const SESSION_CATALOG_PATH = '/api/serve/sessions'
export const REQUEST_DIAGNOSTIC_ID_PATTERN = /^[a-f0-9]{32}$/

export function isRequestDiagnosticId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_DIAGNOSTIC_ID_PATTERN.test(value)
}

export function catalogDiagnosticContext(path: string) {
  const query = new URLSearchParams(path.split('?')[1] ?? '')
  const single = (name: string): string | null => {
    const values = query.getAll(name)
    return values.length === 1 ? values[0] : null
  }
  const boolean = (name: string): boolean | null => {
    const value = single(name)
    return value === 'true' ? true : value === 'false' ? false : null
  }
  const scope = single('scope')
  const limit = single('limit')
  const parsedLimit = limit !== null && /^\d+$/.test(limit) ? Number(limit) : null
  return {
    scope: scope === 'all' || scope === 'project' ? scope : null,
    archived: boolean('archived'),
    include_last_agent_reply: boolean('include_last_agent_reply'),
    limit: parsedLimit !== null && Number.isSafeInteger(parsedLimit) ? parsedLimit : null,
  }
}
