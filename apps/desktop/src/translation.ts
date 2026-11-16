export const TRANSLATION_CHANNEL = 'scholarseed:translation'
export const TRANSLATION_PATH = '/api/settings/translation'
export const TRANSLATION_TIMEOUT_MS = 45000
export interface TranslationPreferences {
  toolbar: boolean
  selectionAutomatic: boolean
}
export type TranslationRequest =
  | { operation: 'status' }
  | { operation: 'preferences'; preferences: Partial<TranslationPreferences> }
  | { operation: 'verify'; provider: string; fields: Record<string, string> }
  | { operation: 'invalidate'; provider: string }
  | { operation: 'translate'; provider: string; text: string; source: string; target: string }
export interface TranslationReply {
  status: number
  body: string
}
export function translationRequest(request: TranslationRequest): RequestInit {
  if (request.operation === 'status') return { method: 'GET' }
  if (request.operation === 'preferences')
    return {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.preferences),
    }
  if (!['verify', 'invalidate', 'translate'].includes(request.operation))
    throw new Error('Invalid translation operation')
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }
}
