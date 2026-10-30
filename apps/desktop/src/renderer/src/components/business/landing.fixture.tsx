import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import '../../browser'
import { createLocalization } from '../../../../localization/engine'
import { resources } from '../../../../localization/resources'
import { StoreContext } from '../../storeContext'
import type { Store } from '../../store'
import { Landing } from './Landing'

interface Snapshot {
  phase: 'waiting' | 'adopted'
  confirmationId?: number
}
interface LoginHarness {
  acks: unknown[]
  authed: () => number
  unmount: () => void
  rerender: () => void
  snapshot: (next: Snapshot) => void
}
declare global {
  interface Window {
    loginHarness: LoginHarness
  }
}
const listeners = new Set<(snapshot: Snapshot) => void>()
const acks: unknown[] = []
let snapshot: Snapshot = { phase: 'waiting' }
let authed = 0
Object.assign(window.scholarseed, {
  getApiBase: () => window.location.origin,
  desktopEnvironment: async () => ({ elevated: false }),
  desktopAuthState: async () => snapshot,
  onDesktopAuth: (listener: (snapshot: Snapshot) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  desktopAuthAdoptedAck: async (id: number, confirmed: boolean) => {
    acks.push({ id, confirmed })
    return { ok: true }
  },
})
const localization = createLocalization('zh', resources, { report: () => undefined })
export function Fixture(): JSX.Element {
  const [visible, setVisible] = useState(true)
  const [, rerender] = useState(0)
  Object.assign(window, {
    loginHarness: {
      acks,
      authed: () => authed,
      unmount: () => setVisible(false),
      rerender: () => rerender((value) => value + 1),
      snapshot: (next: typeof snapshot) => {
        snapshot = next
        listeners.forEach((listener) => listener(next))
      },
    },
  })
  const store = { state: { lang: 'zh' }, act: {} } as unknown as Store
  return (
    <I18nextProvider i18n={localization}>
      <StoreContext.Provider value={store}>
        {visible && (
          <Landing
            onAuthed={() => {
              authed += 1
            }}
            onSkipped={() => undefined}
          />
        )}
      </StoreContext.Provider>
    </I18nextProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
