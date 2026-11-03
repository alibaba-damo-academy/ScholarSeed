import { Notification, shell } from 'electron'

import type {
  SystemPermissionId,
  SystemPermissionRecord,
  SystemPermissionsSnapshot
} from '../permissions'
import {
  unavailablePermissionRecords
} from '../permissions'

const MACOS_PLATFORM = 'darwin'
const WINDOWS_PLATFORM = 'win32'
const WINDOWS_NOTIFICATIONS_SETTINGS = 'ms-settings:notifications'

const SETTINGS_URLS: Record<SystemPermissionId, string> = {
  'full-disk': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
  location: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices'
}

const ACTIONABLE_SETTINGS_IDS = new Set<SystemPermissionId>(['notifications'])

export function readSystemPermissions(): SystemPermissionsSnapshot {
  const planned = Object.fromEntries(
    unavailablePermissionRecords().map((permission) => [permission.id, permission])
  ) as Record<SystemPermissionId, SystemPermissionRecord>
  const notificationsAvailable = (process.platform === MACOS_PLATFORM || process.platform === WINDOWS_PLATFORM) && Notification.isSupported()
  return {
    platform: process.platform,
    permissions: [
      {
        id: 'full-disk',
        status: 'project-scoped',
        actionable: false,
        implemented: true,
        detailCode: 'project-scoped'
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
        detailCode: notificationsAvailable ? 'system-settings' : 'notifications-unavailable'
      },
      planned.location
    ]
  }
}

export async function openSystemPermission(id: SystemPermissionId): Promise<boolean> {
  if (process.platform === WINDOWS_PLATFORM && id === 'notifications') {
    await shell.openExternal(WINDOWS_NOTIFICATIONS_SETTINGS)
    return true
  }
  const url = SETTINGS_URLS[id]
  if (process.platform !== MACOS_PLATFORM || !url || !ACTIONABLE_SETTINGS_IDS.has(id)) return false
  await shell.openExternal(url)
  return true
}
