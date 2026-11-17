export const API_DIAGNOSTIC_PREFIX = '[api-request]'
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
