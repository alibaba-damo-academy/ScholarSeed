import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'

import { createLocalization } from '../../../../localization/engine'
import zhComponents from '../../../../localization/locales/zh/components.json'
import enComponents from '../../../../localization/locales/en/components.json'
import zhUi from '../../../../localization/locales/zh/ui.json'
import enUi from '../../../../localization/locales/en/ui.json'
import type { StorageConfig } from '../../../../storage'
import { DataStoragePage } from './AccountPanel'
import { StorageFirstLaunchDialog } from './StorageFirstLaunch'
import { StorageFixtureContext } from './storage.render.state'
import { Button, ToastProvider, Toaster } from '../ui'
import '../../styles.css'

const localization = createLocalization(
  'zh',
  {
    zh: { components: zhComponents, ui: zhUi },
    en: { components: enComponents, ui: enUi },
  },
  { report: () => undefined }
)
const homeReads: { resolve: (value: StorageConfig) => void; reject: (error: Error) => void }[] = []
let picker: 'cancel' | 'reject' | 'select' | 'pending' = 'cancel'
let pickerCalls = 0
let finishPicker: ((value: string | null) => void) | undefined
const launch = window.location.search.includes('launch')
Object.assign(window, {
  scholarseed: {
    platform: 'darwin',
    getApiBase: () => window.location.origin,
    storageConfig: () =>
      new Promise<StorageConfig>((resolve, reject) => homeReads.push({ resolve, reject })),
    pickDir: async () => {
      pickerCalls += 1
      if (picker === 'reject') throw new Error('fixture picker rejected')
      if (picker === 'pending')
        return new Promise<string | null>((resolve) => {
          finishPicker = resolve
        })
      return picker === 'select' ? '/fixture/chosen' : null
    },
  },
  storageFixture: {
    homeReads,
    home: (index: number, success: boolean) => {
      if (success)
        homeReads[index].resolve({
          home: '/fixture/home',
          runtimeStore: null,
          configured: false,
          canChangeDataHome: launch,
          firstLaunchEligible: launch,
        })
      else homeReads[index].reject(new Error('fixture home rejected'))
    },
    picker: (value: typeof picker) => {
      picker = value
    },
    pickerCalls: () => pickerCalls,
    cancelPicker: () => finishPicker?.(null),
  },
})

export function Fixture(): React.JSX.Element {
  const [mounted, setMounted] = useState(true)
  const [state, set] = useState({ storageFirstLaunchSeen: window.location.search.includes('seen') })
  return (
    <StorageFixtureContext.Provider value={{ state, set }}>
      <output data-testid="fixture-seen">{String(state.storageFirstLaunchSeen)}</output>
      <Button data-testid="fixture-toggle" onClick={() => setMounted((value) => !value)}>
        Toggle page
      </Button>
      <Button data-testid="fixture-english" onClick={() => void localization.changeLanguage('en')}>
        English
      </Button>
      {mounted && (launch ? <StorageFirstLaunchDialog /> : <DataStoragePage />)}
      <Toaster />
    </StorageFixtureContext.Provider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nextProvider i18n={localization}>
      <ToastProvider>
        <Fixture />
      </ToastProvider>
    </I18nextProvider>
  </StrictMode>
)
