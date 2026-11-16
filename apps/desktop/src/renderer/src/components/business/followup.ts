import { useEffect, useSyncExternalStore } from 'react'

import {
  DEFAULT_FOLLOW_UP_MODE,
  FOLLOW_UP_MODES,
  getFollowUpPreference,
  setFollowUpPreference,
  type FollowUpMode,
  type FollowUpPreference,
} from '../../api'

const FOLLOW_UP_CHANNEL = 'scholarseed-follow-up-preference'
interface FollowUpState extends FollowUpPreference {
  loading: boolean
  saving: boolean
  error: boolean
}
const listeners = new Set<() => void>()
let snapshot: FollowUpState = {
  mode: DEFAULT_FOLLOW_UP_MODE,
  revision: 0,
  loading: true,
  saving: false,
  error: false,
}
let scope: string | null = null
let epoch = 0
let reading: Promise<void> | null = null
let channel: BroadcastChannel | null = null

function publish(patch: Partial<FollowUpState>): void {
  snapshot = { ...snapshot, ...patch }
  for (const listener of listeners) listener()
}

function valid(preference: FollowUpPreference | null): preference is FollowUpPreference {
  return Boolean(
    preference &&
    FOLLOW_UP_MODES.includes(preference.mode) &&
    Number.isSafeInteger(preference.revision) &&
    preference.revision >= 0
  )
}

export function refreshFollowUpPreference(): Promise<void> {
  if (reading) return reading
  if (snapshot.saving) return Promise.resolve()
  const generation = epoch
  publish({ loading: true })
  const operation = getFollowUpPreference()
    .then((preference) => {
      if (generation !== epoch) return
      if (!valid(preference)) {
        publish({ loading: false, error: true })
        return
      }
      if (preference.revision >= snapshot.revision) {
        publish({ ...preference, loading: false, error: false })
      } else {
        publish({ loading: false })
      }
    })
    .finally(() => {
      if (reading === operation) reading = null
    })
  reading = operation
  return operation
}

export async function saveFollowUpPreference(mode: FollowUpMode): Promise<boolean> {
  if (snapshot.loading || snapshot.saving || snapshot.error) return false
  if (snapshot.mode === mode) return true
  const generation = epoch
  const revision = snapshot.revision
  publish({ saving: true })
  const preference = await setFollowUpPreference(mode, revision)
  if (generation !== epoch) return false
  if (!valid(preference)) {
    publish({ saving: false, error: true })
    channel?.postMessage(null)
    return false
  }
  publish({ ...preference, saving: false, error: false })
  channel?.postMessage(null)
  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(FOLLOW_UP_CHANNEL)
      channel.onmessage = () => void refreshFollowUpPreference()
    }
    window.addEventListener('focus', refreshOnFocus)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      channel?.close()
      channel = null
      window.removeEventListener('focus', refreshOnFocus)
    }
  }
}

function refreshOnFocus(): void {
  void refreshFollowUpPreference()
}

export function useFollowUpPreference(serviceInstanceId: string | null): FollowUpState {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  useEffect(() => {
    if (scope !== serviceInstanceId) {
      scope = serviceInstanceId
      epoch += 1
      reading = null
      publish({
        mode: DEFAULT_FOLLOW_UP_MODE,
        revision: 0,
        loading: true,
        saving: false,
        error: false,
      })
    }
    void refreshFollowUpPreference()
  }, [serviceInstanceId])
  return state
}
