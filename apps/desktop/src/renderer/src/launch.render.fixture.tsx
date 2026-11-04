import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../localization/engine'
import { resources } from '../../localization/resources'
import { ToastProvider } from './components/ui'
import { StoreProvider, useApp, type SessionSurface, type Store } from './store'
import { Composer } from './components/business/Composer'
import { Stream } from './components/business/Stream'
import { TodoPanel } from './components/business/TodoPanel'
import { DocumentWorkspaceContext, documentWorkspaces } from './features/workbench/workspace'
import { getBackendHealth, getSharedRuntimeReconfiguration } from './api'
import { projectBackendAvailability } from './runtime'

const localization = createLocalization('zh', resources, { report: () => undefined })
let store: Store
let hideComposer: () => void
let setComposerSurface: (surface: SessionSurface) => void
Object.assign(window, {
  launchProbe: {
    language: (language: 'zh' | 'en') => localization.changeLanguage(language),
    patch: (patch: Parameters<Store['set']>[0]) => store.set(patch),
    catalog: (catalog: Parameters<Store['act']['applyModelCatalog']>[0]) =>
      store.act.applyModelCatalog(catalog),
    get state() {
      return store.state
    },
    draft: (panel = false) => (panel ? store.act.startPanelDraft() : store.act.startDraft()),
    hide: () => hideComposer(),
    surface: (surface: SessionSurface) => setComposerSurface(surface),
    health: async () => {
      const health = await getBackendHealth()
      const reconfiguration =
        health === null ? await getSharedRuntimeReconfiguration().catch(() => null) : null
      store.set((current) => projectBackendAvailability(current, health, reconfiguration))
    },
  },
})

function Fixture(): React.JSX.Element {
  store = useApp()
  const [visible, setVisible] = useState(true)
  const [surface, setSurface] = useState<SessionSurface>('conversation')
  hideComposer = () => setVisible(false)
  setComposerSurface = setSurface
  return visible ? (
    <>
      {Reflect.get(window, 'streamFixture') === true && <Stream home />}
      <Composer
        home
        surface={surface}
        header={({ continueTurn, continueDisabled }) => (
          <TodoPanel
            compact
            currentTurnOnly
            onContinue={continueTurn}
            continueDisabled={continueDisabled}
          />
        )}
      />
    </>
  ) : (
    <output data-testid="composer-hidden" />
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <StoreProvider assistantSources={[]}>
        <DocumentWorkspaceContext.Provider value={documentWorkspaces.forProject(null)}>
          <Fixture />
        </DocumentWorkspaceContext.Provider>
      </StoreProvider>
    </ToastProvider>
  </I18nextProvider>
)
