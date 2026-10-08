import React from 'react'

import { getAuthMe } from '../../api.ts'
import { SKILL_CATALOG_CHANGED_EVENT } from '../../../../skills.ts'

const AUTH_REQUIRED_EVENT = 'scholarseed:auth-required'
const AUTH_RESTORED_EVENT = 'scholarseed:auth-restored'

interface AccountAccess {
  authenticated: boolean
  revision: number
}

const listeners = new Map<(access: AccountAccess) => void, boolean>()
let access: AccountAccess = { authenticated: false, revision: 0 }
let resolved = false
let request = 0
let pending: Promise<void> | null = null
let eventsAttached = false

const changed = (authenticated = access.authenticated): void => {
  access = { authenticated, revision: access.revision + 1 }
  for (const listener of listeners.keys()) listener(access)
}

const refresh = (): void => {
  if (![...listeners.values()].some(Boolean) || pending) return
  if (resolved) {
    for (const listener of listeners.keys()) listener(access)
    return
  }
  const current = ++request
  changed(false)
  pending = getAuthMe()
    .then((identity) => {
      if (current !== request) return
      resolved = true
      changed(identity?.auth === true)
    })
    .finally(() => {
      if (current === request) pending = null
    })
}

const clear = (): void => {
  request += 1
  pending = null
  resolved = true
  changed(false)
}

const restored = (): void => {
  request += 1
  pending = null
  resolved = false
  refresh()
}

const revisionChanged = (): void => changed()

const attachEvents = (): void => {
  if (eventsAttached) return
  eventsAttached = true
  window.addEventListener(AUTH_REQUIRED_EVENT, clear)
  window.addEventListener(AUTH_RESTORED_EVENT, restored)
  window.addEventListener(SKILL_CATALOG_CHANGED_EVENT, revisionChanged)
}

const detachEvents = (): void => {
  if (!eventsAttached || listeners.size > 0) return
  eventsAttached = false
  window.removeEventListener(AUTH_REQUIRED_EVENT, clear)
  window.removeEventListener(AUTH_RESTORED_EVENT, restored)
  window.removeEventListener(SKILL_CATALOG_CHANGED_EVENT, revisionChanged)
}

export function watchAccountAccess(ready: boolean, onChange: (access: AccountAccess) => void): () => void {
  listeners.set(onChange, ready)
  attachEvents()
  onChange(access)
  if (ready) refresh()
  return () => {
    listeners.delete(onChange)
    detachEvents()
  }
}

export function useAccountAccess(ready: boolean): AccountAccess {
  const [access, setAccess] = React.useState<AccountAccess>({ authenticated: false, revision: 0 })
  React.useEffect(() => watchAccountAccess(ready, setAccess), [ready])
  return access
}
