/** Public desktop subscription capability; issuer tokens never cross IPC. */
export const SUBSCRIPTION_CHANNEL = 'scholarseed:subscription-login'
export type SubscriptionRequest = { action: 'available' } | { action: 'login'; connectionId: string }
export interface SubscriptionLogin {
  transaction_id: string
  state: string
  expires_at: number
  error: string
}
export type SubscriptionErrorCode = 'local_service_required' | 'login_failed' | 'window_closed' | 'authorization_open_failed'
export interface SubscriptionReply {
  available: boolean
  errorCode?: SubscriptionErrorCode
  login?: SubscriptionLogin
  error?: string
}
export function subscriptionLoginPath(connectionId: string): string {
  if (!/^personal-[a-z0-9-]+$/.test(connectionId)) throw new Error('Invalid model connection')
  return `/api/settings/model-connections/${encodeURIComponent(connectionId)}/login`
}
export function subscriptionAuthorizationUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing authorization URL')
  const url = new URL(value)
  if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize'
    || url.username || url.password || url.hash
    || url.searchParams.get('redirect_uri') !== 'http://localhost:1455/auth/callback'
    || url.searchParams.get('code_challenge_method') !== 'S256') {
    throw new Error('Unexpected authorization URL')
  }
  return url.href
}
