import React from 'react'

import { getAuthMe } from '../../api.ts'
import { SKILL_CATALOG_CHANGED_EVENT } from '../../../../skills.ts'

const AUTH_REQUIRED_EVENT = 'scholarseed:auth-required'
const AUTH_RESTORED_EVENT = 'scholarseed:auth-restored'

interface AccountAccess {
  authenticated: boolean
  revision: number
}

export function watchAccountAccess(ready: boolean, onChange: (access: AccountAccess) => void): () => void {
  let request = 0
  let alive = true
  let authenticated = false
  let revision = 0
  const changed = (): void => {
    revision += 1
    onChange({ authenticated, revision })
  }
  const refresh = (): void => {
    const current = ++request
    authenticated = false
    changed()
    if (!ready) return
    void getAuthMe().then((identity) => {
      if (!alive || current !== request) return
      authenticated = identity?.auth === true
      changed()
    })
  }
  const clear = (): void => {
    request += 1
    authenticated = false
    changed()
  }
  refresh()
  window.addEventListener(AUTH_REQUIRED_EVENT, clear)
  window.addEventListener(AUTH_RESTORED_EVENT, refresh)
  window.addEventListener(SKILL_CATALOG_CHANGED_EVENT, changed)
  return () => {
    alive = false
    request += 1
    window.removeEventListener(AUTH_REQUIRED_EVENT, clear)
    window.removeEventListener(AUTH_RESTORED_EVENT, refresh)
    window.removeEventListener(SKILL_CATALOG_CHANGED_EVENT, changed)
  }
}

export function useAccountAccess(ready: boolean): AccountAccess {
  const [access, setAccess] = React.useState<AccountAccess>({ authenticated: false, revision: 0 })
  React.useEffect(() => watchAccountAccess(ready, setAccess), [ready])
  return access
}
