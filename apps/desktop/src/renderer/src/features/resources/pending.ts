import type { ResourceCapability } from './api.ts'

const SNAPSHOT_SAVE_KEYS = {
  user: 'snapshotSave.user',
  agent: 'snapshotSave.agent',
  external: 'snapshotSave.external',
  restore: 'snapshotSave.restore'
} as const

export function snapshotSaveMessage(capability: ResourceCapability | null | undefined,
  externalChange: boolean) {
  if (capability?.pending?.review) return 'snapshotSave.review' as const
  if (externalChange) return 'snapshotSave.adoptExternal' as const
  if (capability?.snapshot_state === 'saved') return 'snapshotSave.saved' as const
  const origin = capability?.pending?.origin
  return origin ? SNAPSHOT_SAVE_KEYS[origin] : 'snapshotSave.save' as const
}
