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

export type SystemPermissionDetailCode = 'project-scoped' | 'system-settings' | 'notifications-unavailable' | 'not-implemented'

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
  'location'
]

export function unavailablePermissionRecords(): SystemPermissionRecord[] {
  return PLANNED_PERMISSION_IDS.map((id) => ({
    id,
    status: 'unavailable',
    actionable: false,
    implemented: false,
    detailCode: 'not-implemented'
  }))
}
