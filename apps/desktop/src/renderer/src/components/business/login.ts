import type { TFunction } from 'i18next'

export interface LoginFailure {
  code: string
  diagnostic?: string
}

const LOGIN_FAILURE_KEYS = {
  account_base_unavailable: 'loginFailure.account_base_unavailable',
  open_browser_failed: 'loginFailure.open_browser_failed',
  bad_callback: 'loginFailure.bad_callback',
  state_mismatch: 'loginFailure.state_mismatch',
  handoff_unclaimed: 'loginFailure.handoff_unclaimed',
  login_expired: 'loginFailure.login_expired',
  handoff_invalid: 'loginFailure.handoff_invalid',
  adopt_failed: 'loginFailure.adopt_failed',
  exchange_error: 'loginFailure.exchange_error',
  verify_failed: 'loginFailure.verify_failed',
  native_unavailable: 'loginFailure.native_unavailable',
  login_failed: 'loginFailure.login_failed',
} as const

/** Snapshot errors are protocol codes; start errors retain explicit application provenance. */
export function loginFailureText(failure: LoginFailure, t: TFunction<'account'>): string {
  const key = Object.prototype.hasOwnProperty.call(LOGIN_FAILURE_KEYS, failure.code)
    ? LOGIN_FAILURE_KEYS[failure.code as keyof typeof LOGIN_FAILURE_KEYS]
    : undefined
  return key ? t(key) : t('loginFailure.login_failed')
}
