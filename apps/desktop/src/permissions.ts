export type SystemPermissionId =
  | 'full-disk'
  | 'screen'
  | 'accessibility'
  | 'microphone'
  | 'automation'
  | 'notifications'
  | 'location'

export type SystemPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unavailable'
  | 'system-managed'
  | 'project-scoped'
  | 'query-error'

export type SystemPermissionTarget = SystemPermissionId | 'files-folders'

const SETTINGS_TARGETS: Record<string, Partial<Record<SystemPermissionTarget, string>>> = {
  darwin: {
    notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
    'files-folders':
      'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  },
  win32: {
    notifications: 'ms-settings:notifications',
    'files-folders': 'ms-settings:privacy-broadfilesystemaccess',
  },
}

export function systemPermissionSettingsUrl(
  platform: string,
  target: SystemPermissionTarget
): string | null {
  const targets = Object.prototype.hasOwnProperty.call(SETTINGS_TARGETS, platform)
    ? SETTINGS_TARGETS[platform]
    : undefined
  return targets && Object.prototype.hasOwnProperty.call(targets, target)
    ? (targets[target] ?? null)
    : null
}

export type SystemPermissionDetailCode =
  'project-scoped' | 'system-settings' | 'notifications-unavailable' | 'not-implemented'

export interface SystemPermissionRecord {
  id: SystemPermissionId
  status: SystemPermissionStatus
  actionable: boolean
  implemented: boolean
  detail?: string
  detailCode?: SystemPermissionDetailCode
}

export interface SystemPermissionsSnapshot {
  platform: string
  permissions: SystemPermissionRecord[]
}

const PLANNED_PERMISSION_IDS: SystemPermissionId[] = [
  'screen',
  'accessibility',
  'microphone',
  'automation',
  'location',
]

export function unavailablePermissionRecords(): SystemPermissionRecord[] {
  return PLANNED_PERMISSION_IDS.map((id) => ({
    id,
    status: 'unavailable',
    actionable: false,
    implemented: false,
    detailCode: 'not-implemented',
  }))
}
