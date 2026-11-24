import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { createLocalization } from '../../localization/engine'
import { resources } from '../../localization/resources'
import { ToastProvider } from './components/ui'
import { StoreProvider, useApp, type SessionSurface, type Store } from './store'
import { Composer } from './components/business/Composer'
import { AiPanel } from './features/assistant/AiPanel'
import { assistantFeature } from './features/assistant/feature'
import { DisplayCardProvider } from './components/business/Cards'
import { ConversationControls, Stream } from './components/business/Stream'
import { InteractionPolicyProvider } from './components/business/Interactions'
import { fileRecovery } from './features/assistant/recovery'
import { TodoPanel } from './components/business/TodoPanel'
import { DocumentWorkspaceContext, documentWorkspaces } from './features/workbench/workspace'
import { getBackendHealth, getSharedRuntimeReconfiguration } from './api'
import { projectBackendAvailability } from './runtime'
import { useLiveSession } from './live'

const localization = createLocalization('zh', resources, { report: () => undefined })
const displayCards = new Map(assistantFeature().displayCards?.map((card) => [card.type, card]))
let store: Store
let hideComposer: () => void
let setComposerSurface: (surface: SessionSurface) => void
Object.assign(window, {
  launchProbe: {
    patch: (patch: Parameters<Store['set']>[0]) => store.set(patch),
    catalog: (catalog: Parameters<Store['act']['applyModelCatalog']>[0]) =>
      store.act.applyModelCatalog(catalog),
    get state() {
      return store.state
    },
    draft: (panel = false) => (panel ? store.act.startPanelDraft() : store.act.startDraft()),
    hide: () => hideComposer(),
    surface: (surface: SessionSurface) => setComposerSurface(surface),
    language: (language: string) => localization.changeLanguage(language),
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
  return visible && Reflect.get(window, 'aiPanelFixture') ? (
    <AiPanel embedded />
  ) : visible ? (
    <>
      {Reflect.get(window, 'streamFixture') === true && (
        <DisplayCardProvider cards={displayCards}>
          <Stream home />
        </DisplayCardProvider>
      )}
      <ConversationControls externalConfirmation={Reflect.get(window, 'hilDockFixture') !== true}>
        <Composer
          home
          contextReferences={
            Reflect.get(window, 'composerContextFixture')
              ? [
                  {
                    key: 'context:fixture',
                    inline: false,
                    content: <span>Context attachment</span>,
                  },
                ]
              : undefined
          }
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
      </ConversationControls>
    </>
  ) : (
    <output data-testid="composer-hidden" />
  )
}

function LiveFixture(): null {
  useLiveSession()
  return null
}

const fixture = (
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <StoreProvider assistantSources={[]}>
        <DocumentWorkspaceContext.Provider value={documentWorkspaces.forProject(null)}>
          <InteractionPolicyProvider policies={[fileRecovery]}>
            {Reflect.get(window, 'liveSessionFixture') === true && <LiveFixture />}
            <Fixture />
          </InteractionPolicyProvider>
        </DocumentWorkspaceContext.Provider>
      </StoreProvider>
    </ToastProvider>
  </I18nextProvider>
)
createRoot(document.getElementById('root')!).render(
  Reflect.get(window, 'strictQueueReceiptFixture') ? <StrictMode>{fixture}</StrictMode> : fixture
)
