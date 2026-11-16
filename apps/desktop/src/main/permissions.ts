import { Notification, shell } from 'electron'

import type {
  SystemPermissionId,
  SystemPermissionTarget,
  SystemPermissionRecord,
  SystemPermissionsSnapshot,
} from '../permissions'
import { unavailablePermissionRecords, systemPermissionSettingsUrl } from '../permissions'

const MACOS_PLATFORM = 'darwin'
const WINDOWS_PLATFORM = 'win32'

export function readSystemPermissions(): SystemPermissionsSnapshot {
  const planned = Object.fromEntries(
    unavailablePermissionRecords().map((permission) => [permission.id, permission])
  ) as Record<SystemPermissionId, SystemPermissionRecord>
  const notificationsAvailable =
    (process.platform === MACOS_PLATFORM || process.platform === WINDOWS_PLATFORM) &&
    Notification.isSupported()
  return {
    platform: process.platform,
    permissions: [
      {
        id: 'full-disk',
        status: 'project-scoped',
        actionable: false,
        implemented: true,
        detailCode: 'project-scoped',
      },
      planned.screen,
      planned.accessibility,
      planned.microphone,
      planned.automation,
      {
        id: 'notifications',
        status: notificationsAvailable ? 'system-managed' : 'unavailable',
        actionable: notificationsAvailable,
        implemented: true,
        detailCode: notificationsAvailable ? 'system-settings' : 'notifications-unavailable',
      },
      planned.location,
    ],
  }
}

export async function openSystemPermission(id: SystemPermissionTarget): Promise<boolean> {
  const url = systemPermissionSettingsUrl(process.platform, id)
  if (!url) return false
  await shell.openExternal(url)
  return true
}
