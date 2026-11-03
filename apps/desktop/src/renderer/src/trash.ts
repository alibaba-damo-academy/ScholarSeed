const SYSTEM_TRASH_KEYS = {
  darwin: 'systemTrash.darwin',
  win32: 'systemTrash.win32'
} as const
const SYSTEM_TRASH_FALLBACK_KEY = 'systemTrash.fallback'
const RESTORE_ACTION_KEYS = {
  darwin: 'restoreAction.darwin',
  win32: 'restoreAction.win32'
} as const
const RESTORE_ACTION_FALLBACK_KEY = 'restoreAction.fallback'

export function systemTrashKey(platform = window.scholarseed?.platform) {
  return SYSTEM_TRASH_KEYS[platform as keyof typeof SYSTEM_TRASH_KEYS] ?? SYSTEM_TRASH_FALLBACK_KEY
}

export function restoreActionKey(platform = window.scholarseed?.platform) {
  return RESTORE_ACTION_KEYS[platform as keyof typeof RESTORE_ACTION_KEYS] ?? RESTORE_ACTION_FALLBACK_KEY
}
