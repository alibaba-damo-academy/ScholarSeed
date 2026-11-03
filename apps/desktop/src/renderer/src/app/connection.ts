import { useSyncExternalStore } from 'react'
import { INITIAL_STARTUP, STARTUP_PHASE, type StartupSnapshot } from '../../../startup'

const WEB_STARTUP: StartupSnapshot = {
  ...INITIAL_STARTUP,
  phase: STARTUP_PHASE.ready,
  apiBase: window.location.origin,
}
let current = window.scholarseed?.getStartup?.() ?? WEB_STARTUP
const listeners = new Set<() => void>()

window.scholarseed?.onStartup?.(snapshot => {
  if (snapshot.revision < current.revision) return
  current = snapshot
  for (const listener of listeners) listener()
})

export function startupSnapshot(): StartupSnapshot {
  return current
}

export function useStartup(): StartupSnapshot {
  return useSyncExternalStore(callback => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }, startupSnapshot)
}
