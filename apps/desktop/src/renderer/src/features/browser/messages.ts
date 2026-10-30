import type { ParseKeys } from 'i18next'
import type { BrowserErrorCode, BrowserDataType } from '../../../../browser'
import type { VaultError, VaultState, VaultIntent } from '../../../../vault'

export const BROWSER_ERROR_KEYS = {
  print_busy: 'errors.print_busy',
  invalid_url: 'errors.invalid_url',
  invalid_command: 'errors.invalid_command',
  invalid_sender: 'errors.invalid_sender',
  navigation_failed: 'errors.navigation_failed',
  permission_denied: 'errors.permission_denied',
  cdp_disabled: 'errors.cdp_disabled',
  cdp_busy: 'errors.cdp_busy',
  devtools_conflict: 'errors.devtools_conflict',
  target_closed: 'errors.target_closed',
  unsupported_cdp_method: 'errors.unsupported_cdp_method',
  desktop_bridge_unavailable: 'errors.desktop_bridge_unavailable',
  operation_failed: 'errors.operation_failed',
  partial_clear: 'errors.partial_clear',
  automatic_download_unavailable: 'errors.automatic_download_unavailable',
  browser_policy_io_unavailable: 'errors.browser_policy_io_unavailable',
  browser_policy_revision_conflict: 'errors.browser_policy_revision_conflict',
  browser_policy_invalid: 'errors.browser_policy_invalid',
  browser_history_delivery_pending: 'errors.browser_history_delivery_pending',
} as const satisfies Record<BrowserErrorCode, ParseKeys<'browser'>>

export const VAULT_ERROR_KEYS = {
  unavailable: 'vault.errors.unavailable',
  debug_unsafe: 'vault.errors.debug_unsafe',
  debug_unknown: 'vault.errors.debug_unknown',
  busy: 'vault.errors.busy',
  revoked: 'vault.errors.revoked',
  invalid_input: 'vault.errors.invalid_input',
  invalid_format: 'vault.errors.invalid_format',
  authentication_failed: 'vault.errors.authentication_failed',
  conflict: 'vault.errors.conflict',
  unknown: 'vault.errors.unknown',
  protected_assets_unavailable: 'vault.errors.protected_assets_unavailable',
  protected_watch_unsupported: 'vault.errors.protected_watch_unsupported',
} as const satisfies Record<VaultError, ParseKeys<'browser'>>

export const VAULT_STATE_KEYS = {
  uninitialized: 'vault.states.uninitialized',
  locked: 'vault.states.locked',
  unlocking: 'vault.states.unlocking',
  unlocked: 'vault.states.unlocked',
  locking: 'vault.states.locking',
  unavailable: 'vault.states.unavailable',
} as const satisfies Record<VaultState, ParseKeys<'browser'>>

export const VAULT_INTENT_KEYS = {
  create: 'vault.create',
  unlock: 'vault.unlock',
  reset: 'vault.reset',
} as const satisfies Record<VaultIntent, ParseKeys<'browser'>>

export const DATA_TYPE_KEYS = {
  history: 'settings.dataType.history',
  cookies: 'settings.dataType.cookies',
  storage: 'settings.dataType.storage',
  cache: 'settings.dataType.cache',
} as const satisfies Record<BrowserDataType, ParseKeys<'browser'>>
